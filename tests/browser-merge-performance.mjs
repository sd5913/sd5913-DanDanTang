import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "vite";
import { TILE_SIZE } from "../src/player.ts";

const host = "127.0.0.1";
const viewport = { width: 1280, height: 900 };
const project = fileURLToPath(new URL("..", import.meta.url));

async function openFixtureServer() {
  const bundled = await build({
    root: project,
    mode: "regression",
    logLevel: "warn",
    plugins: [{
      name: "merge-performance-entry",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          assert.ok(html.includes("/src/main.ts"));
          return html.replace("/src/main.ts", "/tests/browser-merge-performance-fixture.mjs");
        },
      },
    }],
    build: { write: false, emptyOutDir: false },
  });
  assert.ok(bundled && !Array.isArray(bundled) && "output" in bundled);
  const files = new Map(bundled.output.map((file) => ["/" + file.fileName, file]));
  const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript" };
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://" + host).pathname;
    const file = files.get(path === "/" ? "/index.html" : path);
    if (!file) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": types[extname(file.fileName)] ?? "application/octet-stream" });
    response.end(file.type === "chunk" ? file.code : file.source);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return {
    url: "http://" + host + ":" + server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function summarize(samples) {
  assert.ok(samples.length);
  const ordered = [...samples].sort((a, b) => a - b);
  const at = (fraction) => ordered[Math.ceil(ordered.length * fraction) - 1];
  return { frames: ordered.length, medianMs: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), worstMs: ordered.at(-1) };
}

async function pointForGroup(page, index) {
  return page.evaluate(({ index, tile }) => {
    const { col, row } = window.mergePerformanceFixture.groups[index][0];
    const { worldLeft, worldTop, worldWidth, worldHeight } = document.getElementById("visible-chunks").dataset;
    const bounds = document.querySelector("#board canvas").getBoundingClientRect();
    return {
      col, row,
      x: bounds.left + ((col + 0.5) * tile - Number(worldLeft)) * bounds.width / Number(worldWidth),
      y: bounds.top + ((row + 0.5) * tile - Number(worldTop)) * bounds.height / Number(worldHeight),
    };
  }, { index, tile: TILE_SIZE });
}

async function hover(page, index, select = false) {
  const { x, y, col, row } = await pointForGroup(page, index);
  assert.ok(x >= 0 && x < viewport.width && y >= 0 && y < viewport.height);
  if (select) await page.mouse.click(x, y);
  else await page.mouse.move(x, y);
  await page.waitForFunction(({ col, row }) => !document.getElementById("merge-controls").hidden
    && document.getElementById("merge-tiles").textContent.startsWith("保留 (" + col + ", " + row + ")"), { col, row });
  if (select) await page.locator("#merge-confirm").waitFor({ state: "visible" });
}

async function fixturePage(browser, url, verify) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    assert.equal((await page.goto(url))?.status(), 200);
    await page.waitForFunction(() => {
      const state = window.mergePerformanceFixture?.state();
      return state?.ready === 4 && state.knownEntry === "visible" && state.knownGoal === "visible"
        && Number(document.getElementById("visible-chunks").dataset.worldWidth) > 0;
    });
    assert.equal(await page.locator("#merge-controls").count(), 1);
    assert.equal(await page.locator("#merge-controls").isHidden(), true);
    const result = await verify(page);
    assert.deepEqual(errors, []);
    return result;
  } catch (error) {
    if (errors.length) throw new Error("Edge fixture errors: " + errors.join(", "), { cause: error });
    throw error;
  } finally {
    await page.close();
  }
}

function sampleIdleFrames(page, elapsedMs) {
  return page.evaluate((durationMs) => new Promise((resolve) => {
    const spans = [];
    let start;
    let previous;
    requestAnimationFrame(function frame(now) {
      start ??= now;
      if (previous !== undefined) spans.push(now - previous);
      previous = now;
      if (now - start < durationMs) requestAnimationFrame(frame);
      else resolve(spans);
    });
  }), elapsedMs);
}

async function verifyPreviewLifecycle(page) {
  const initial = await page.evaluate(() => window.mergePerformanceFixture.state());
  assert.equal(initial.occupied, 16);
  assert.equal(initial.far, "unknown");
  const idle = await sampleIdleFrames(page, 450);
  await hover(page, 0);
  assert.equal(await page.locator("#merge-risk").getAttribute("data-state"), "unchanged");
  const first = await page.evaluate(() => window.mergePerformanceFixture.metrics());
  assert.equal(first.computations, 1);
  assert.ok(first.searches > 0, "initial preview must perform actual navigation field searches");
  const hovered = await sampleIdleFrames(page, 450);
  const stable = await page.evaluate(() => window.mergePerformanceFixture.metrics());
  assert.equal(stable.computations, first.computations);
  assert.equal(stable.searches, first.searches);
  assert.ok(stable.cacheHits > first.cacheHits + 4);
  const mutation = await page.evaluate(() => window.mergePerformanceFixture.dig());
  assert.equal(mutation.cleared, true);
  assert.equal(mutation.after, mutation.before + 1);
  await page.waitForFunction((before) => window.mergePerformanceFixture.metrics().computations > before, stable.computations);
  const rebuilt = await page.evaluate(() => window.mergePerformanceFixture.metrics());
  assert.equal(rebuilt.computations, stable.computations + 1);
  assert.ok(rebuilt.searches > stable.searches);
  for (let index = 1; index < initial.ready; index += 1) await hover(page, index);
  const switched = await page.evaluate(() => window.mergePerformanceFixture.metrics());
  assert.equal(switched.computations, rebuilt.computations + initial.ready - 1);

  await hover(page, 0, true);
  assert.equal(await page.locator("#merge-confirm").isEnabled(), true);
  assert.equal(await page.evaluate(() => window.mergePerformanceFixture.destroyOne()), true);
  await page.locator("#merge-controls").waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => {
    const { ready, occupied } = window.mergePerformanceFixture.state();
    return { ready, occupied };
  }), { ready: 3, occupied: 15 });

  await hover(page, 1, true);
  await page.keyboard.down("KeyR");
  try {
    await page.waitForFunction(() => window.mergePerformanceFixture.state().occupied === 0
      && document.getElementById("merge-controls").hidden);
  } finally {
    await page.keyboard.up("KeyR");
  }
  assert.equal(await page.evaluate(() => window.mergePerformanceFixture.state().ready), 0);
  assert.equal(await page.locator("#merge-confirm").isHidden(), true);
  return {
    groups: initial.ready, occupied: initial.occupied, far: initial.far, idle, hovered,
    first, stable, rebuilt, switched, mutation, staleSelectionCleared: true, resetCleared: true,
  };
}

async function measure(page, count, requestedDuration) {
  await hover(page, 0);
  const collection = page.evaluate(({ count, requestedDuration }) => new Promise((resolve) => {
    const fixture = window.mergePerformanceFixture;
    const stats = document.getElementById("defense-stats").dataset;
    const panel = document.getElementById("merge-controls");
    const risk = document.getElementById("merge-risk");
    const tiles = document.getElementById("merge-tiles");
    const canvas = document.querySelector("#board canvas");
    const device = { devicePixelRatio, canvasWidth: canvas.width, canvasHeight: canvas.height };
    const begin = performance.now();
    const before = fixture.metrics();
    const first = fixture.start(count);
    const frames = [];
    const states = new Set();
    const previews = new Set();
    let last;
    let firstFrameActive;
    let activePeak = 0;
    let visiblePeak = 0;
    let previewFrames = 0;
    const nativeRaf = Function.prototype.toString.call(requestAnimationFrame).includes("[native code]");
    requestAnimationFrame(function frame(timestamp) {
      if (last !== undefined) frames.push(timestamp - last);
      last = timestamp;
      const active = Number(stats.active);
      firstFrameActive ??= active;
      activePeak = Math.max(activePeak, active);
      visiblePeak = Math.max(visiblePeak, Number(stats.visible));
      if (!panel.hidden) {
        previewFrames += 1;
        states.add(risk.dataset.state);
        previews.add(tiles.textContent);
      }
      const durationMs = performance.now() - begin;
      if (durationMs < requestedDuration) return requestAnimationFrame(frame);
      resolve({
        nativeRaf, durationMs, ...first, firstFrameActive, activePeak, visiblePeak, previewFrames, device,
        spawned: Number(stats.spawned), removed: Number(stats.removed), world: fixture.state(),
        states: [...states], previewCount: previews.size, before, after: fixture.metrics(), frames,
      });
    });
  }), { count, requestedDuration });
  if (count === "sustained") {
    for (const index of [1, 2, 3, 0]) {
      await wait(5_000);
      await hover(page, index);
    }
  }
  const raw = await collection;
  const computations = raw.after.computations - raw.before.computations;
  const searches = raw.after.searches - raw.before.searches;
  const hits = raw.after.cacheHits - raw.before.cacheHits;
  assert.equal(raw.nativeRaf, true);
  assert.ok(raw.durationMs >= requestedDuration && raw.activePeak > 0 && raw.visiblePeak > 0);
  assert.ok(raw.previewFrames > 30 && raw.previewFrames / raw.frames.length > 0.95);
  assert.equal(raw.world.ready, 4);
  assert.equal(raw.world.far, "unknown");
  assert.ok(raw.states.includes("unchanged"));
  assert.ok(computations > 0 && raw.before.searches > 0,
    "the initial hover and subsequent moving subject must execute route previews");
  assert.ok(hits > computations * 2, "moving preview must reuse scratch route queries between meaningful changes");
  if (count === "sustained") {
    assert.equal(raw.requested, 180);
    assert.ok(raw.spawned >= 100);
    assert.equal(raw.previewCount, 4);
    assert.ok(searches > 0, "switching candidates must evaluate separate occupancy layouts");
  } else {
    assert.equal(raw.requested, count);
    assert.equal(raw.initialActive, count);
    assert.equal(raw.firstFrameActive, count);
    assert.equal(raw.activePeak, count);
    assert.equal(raw.spawned, count);
    assert.equal(raw.removed, 0);
    assert.equal(raw.previewCount, 1);
  }
  return { case: count, ...raw, computations, searches, hits, timing: summarize(raw.frames) };
}

const server = await openFixtureServer();
try {
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const lifecycle = await fixturePage(browser, server.url, verifyPreviewLifecycle);
    const { idle, hovered, ...lifecycleSummary } = lifecycle;
    console.log(JSON.stringify({ lifecycle: { ...lifecycleSummary, idle: summarize(idle), hovered: summarize(hovered) } }));
    const cases = process.argv.includes("--smoke") ? [[50, 1_500]] : [[50, 3_000], [100, 3_000], [250, 3_000], ["sustained", 26_000]];
    const results = [];
    for (const [count, duration] of cases) {
      const raw = await fixturePage(browser, server.url, (page) => measure(page, count, duration));
      results.push(raw);
      const { frames, ...summary } = raw;
      console.log(JSON.stringify(summary));
    }
    const metadata = { edge: browser.version(), viewport, map: [40, 96], fog: true, input: "native Playwright mouse and keyboard, native browser RAF" };
    if (process.argv.includes("--record")) {
      const directory = join(await realpath(project), ".estd-private");
      await mkdir(directory, { recursive: true });
      assert.equal(await realpath(directory), directory);
      const filename = "p0-i-fix02-merge-performance-" + new Date().toISOString().replaceAll(":", "-") + ".json";
      const output = join(directory, filename);
      await writeFile(output, JSON.stringify({ ...metadata, lifecycle, results }, null, 2), { flag: "wx" });
      console.log("Raw private results saved to " + output);
    }
    console.log(JSON.stringify(metadata));
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

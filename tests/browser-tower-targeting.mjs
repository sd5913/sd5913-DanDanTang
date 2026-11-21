import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const viewport = { width: 1280, height: 900 };
const host = "127.0.0.1";

async function serveFixture() {
  const bundled = await build({
    root, mode: "regression", logLevel: "warn", build: { write: false },
    plugins: [{ name: "tower-targeting-fixture", transformIndexHtml: {
      order: "pre",
      handler(html) {
        assert.ok(html.includes("/src/main.ts"));
        return html.replace("/src/main.ts", "/tests/browser-tower-targeting-fixture.mjs");
      },
    } }],
  });
  assert.ok(bundled && !Array.isArray(bundled) && "output" in bundled);
  const files = new Map(bundled.output.map((file) => ["/" + file.fileName, file]));
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    const file = files.get(pathname === "/" ? "/index.html" : pathname);
    if (!file) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": mime[extname(file.fileName)] ?? "application/octet-stream" });
    response.end(file.type === "chunk" ? file.code : file.source);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return { server, url: `http://${host}:${server.address().port}/` };
}

async function withFixture(browser, url, fixture, action) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto(url + "?fixture=" + fixture);
    await page.waitForFunction(() => window.targetingFixture && document.querySelector("#board canvas"));
    const result = await action(page);
    assert.deepEqual(errors, []);
    return result;
  } finally {
    await page.close();
  }
}

async function verifyCorner(page, expected) {
  assert.equal(await page.evaluate(() => window.targetingFixture.start(1)), 1);
  await page.waitForFunction(() => {
    const { turn, timeMs } = window.targetingFixture.snapshot();
    return turn && timeMs >= turn.timeMs + 120;
  });
  const { turn, health, shortEvents } = await page.evaluate(() => window.targetingFixture.snapshot());
  assert.deepEqual(turn.to, { col: 9, row: 10 });
  assert.ok(turn.center.y > 9.55);
  assert.equal(turn.kind, "armored");
  assert.equal(turn.hp, 14);
  if (expected) {
    const shot = shortEvents.find(({ event }) => event.type === "towerShot");
    const effect = shortEvents.find(({ event }) => event.type === "towerEffect");
    assert.equal(shot.event.towerId, turn.towerId);
    assert.equal(shot.event.enemyId, turn.enemyId);
    assert.equal(shot.event.damage, 2);
    assert.equal(shot.metadata.enemyKind, "armored");
    assert.equal(effect.event.effect.kind, "piercingFallback");
    assert.ok(shot.timeMs - turn.timeMs < 100);
  } else {
    assert.deepEqual(shortEvents, []);
  }
  assert.deepEqual(health, [[turn.enemyId, expected ? 12 : 14]]);
  return { turn, hpAfter: health[0][1], landed: shortEvents };
}

async function verifyEdges(page) {
  assert.equal(await page.evaluate(() => window.targetingFixture.start()), 6);
  await page.waitForFunction(() => window.targetingFixture.snapshot().shortEvents.length >= 5);
  const snapshot = await page.evaluate(() => window.targetingFixture.snapshot());
  const { shortEvents, towers } = snapshot;
  const ordinary = shortEvents.find(({ event }) => event.type === "towerShot" && event.towerId === towers.standard);
  const burst = shortEvents.find(({ event }) => event.type === "towerEffect" && event.effect.kind === "burst");
  assert.equal(ordinary.event.enemyId, 1);
  assert.equal(ordinary.event.damage, 2);
  assert.ok(ordinary.event.to.x > 13.5);
  assert.ok(burst.event.effect.center.x > 29.5 && burst.event.effect.radius === 2);
  assert.deepEqual(burst.event.enemyIds, [3, 4, 5]);
  const burstDamage = shortEvents
    .filter(({ event, timeMs }) => event.type === "towerShot" && event.towerId === towers.burst && timeMs === burst.timeMs)
    .map(({ event }) => [event.enemyId, event.damage]);
  assert.deepEqual(burstDamage, [[3, 4], [4, 2], [5, 2]]);
  assert.deepEqual(snapshot.health, [[1, 12], [2, 14], [3, 10], [4, 12], [5, 12], [6, 14]]);
  return { ordinary: ordinary.event, burst: burst.event, burstDamage, health: snapshot.health };
}

function summarize(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.ceil(fraction * ordered.length) - 1];
  return { samples: samples.length, p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: ordered.at(-1) };
}

async function stress(page, count, sampleMs, expectedTowers) {
  const raw = await page.evaluate(({ count, sampleMs }) => new Promise((resolve) => {
    const fixture = window.targetingFixture;
    const requested = fixture.start(count);
    const nativeRaf = Function.prototype.toString.call(requestAnimationFrame).includes("[native code]");
    const started = performance.now();
    const frames = [];
    let lastFrame;
    let peakActive = 0;
    let peakVisible = 0;
    let maxPiercingTargets = 0;
    let maxBurstTargets = 0;
    requestAnimationFrame(function sample(timestamp) {
      if (lastFrame !== undefined) frames.push(timestamp - lastFrame);
      lastFrame = timestamp;
      const { counts, effects, visible } = fixture.snapshot();
      peakActive = Math.max(peakActive, counts.spawned - counts.removed);
      peakVisible = Math.max(peakVisible, visible);
      for (const { enemyIds, effect } of effects?.recent ?? []) {
        if (effect.kind === "piercing") maxPiercingTargets = Math.max(maxPiercingTargets, enemyIds.length);
        if (effect.kind === "burst") maxBurstTargets = Math.max(maxBurstTargets, enemyIds.length);
      }
      const elapsedMs = performance.now() - started;
      if (elapsedMs < sampleMs) return requestAnimationFrame(sample);
      resolve({ nativeRaf, elapsedMs, requested, counts, effects, peakActive, peakVisible,
        maxPiercingTargets, maxBurstTargets, metrics: fixture.metrics(), visibility: fixture.visibility(), frames });
    });
  }), { count, sampleMs });
  assert.equal(raw.nativeRaf, true);
  assert.deepEqual(raw.visibility, { current: "visible", far: "unknown" });
  assert.ok(raw.elapsedMs >= sampleMs && raw.frames.length >= 30 && raw.peakVisible > 0);
  const piercing = raw.metrics.filter(({ kind }) => kind === "piercing");
  assert.equal(piercing.length, expectedTowers);
  assert.ok(piercing.every(({ searches, fires, splashSearches }) => searches >= fires && fires > 0 && splashSearches === 0));
  if (count === "sustained") {
    assert.equal(raw.requested, 180);
    assert.ok(raw.counts.spawned >= 60);
  } else {
    assert.equal(raw.requested, count);
    assert.equal(raw.counts.spawned, count);
    assert.equal(raw.peakActive, count);
  }
  assert.ok(raw.maxPiercingTargets >= 2 && raw.maxPiercingTargets <= 4);
  if (expectedTowers > 1) assert.ok(raw.maxBurstTargets >= 2);
  const { frames, effects, ...evidence } = raw;
  return { count, ...evidence, peakFrame: summarize(frames), frames,
    attacks: { piercing: effects.piercing, fallback: effects.piercingFallback, burst: effects.burst },
    piercingSearchesPerSecond: piercing.reduce((sum, metric) => sum + metric.searches, 0) * 1000 / raw.elapsedMs,
    piercingCandidatesPerSecond: piercing.reduce((sum, metric) => sum + metric.candidates, 0) * 1000 / raw.elapsedMs };
}

const { server, url } = await serveFixture();
const results = [];
try {
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const corner = await withFixture(browser, url, "corner", (page) => verifyCorner(page, true));
    const legacy = await withFixture(browser, url, "legacy-corner", (page) => verifyCorner(page, false));
    const edges = await withFixture(browser, url, "edge", verifyEdges);
    console.log(JSON.stringify({ case: "corner and range", corner, legacy, edges }));
    if (!process.argv.includes("--short")) {
      for (const [mode, count, duration, towers] of [["single", 100, 3_000, 1],
        ["stress", 50, 3_000, 2], ["stress", 100, 3_000, 2], ["stress", 250, 3_000, 2], ["stress", "sustained", 26_000, 2]]) {
        const result = await withFixture(browser, url, mode, (page) => stress(page, count, duration, towers));
        results.push({ mode, ...result });
        const { frames, ...summary } = result;
        console.log(JSON.stringify({ mode, ...summary }));
      }
    }
    if (process.argv.includes("--record")) {
      const directory = join(await realpath(root), ".estd-private");
      await mkdir(directory, { recursive: true });
      assert.equal(await realpath(directory), directory);
      const file = join(directory, `p0-j-fix01-edge-towers-${new Date().toISOString().replaceAll(":", "-")}.json`);
      await writeFile(file, JSON.stringify({ browser: browser.version(), viewport, corner, legacy, edges, results }, null, 2), { flag: "wx" });
      console.log(`Private trace saved to ${file}`);
    }
    console.log(`Edge ${browser.version()} · native animation frames · ${viewport.width}×${viewport.height} · fog enabled`);
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

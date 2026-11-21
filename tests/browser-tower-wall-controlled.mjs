import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "vite";
import { PLAYTEST_PROFILE } from "../src/launch-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const viewport = { width: 1280, height: 900 };
const host = "127.0.0.1";

async function serveFixture() {
  const bundled = await build({
    root, mode: "production", logLevel: "warn", build: { write: false },
    plugins: [{ name: "tower-wall-fixture", transformIndexHtml: {
      order: "pre",
      handler(html) {
        assert.ok(html.includes("/src/main.ts"));
        return html.replace("/src/main.ts", "/tests/browser-tower-wall-fixture.mjs");
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
  return { server, url: "http://" + host + ":" + server.address().port + "/" };
}

async function withFixture(browser, url, query, action) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    assert.equal((await page.goto(url + "?fixture=" + query))?.status(), 200);
    await page.waitForFunction(() => window.wallFixture && document.querySelector("#board canvas"));
    const result = await action(page);
    assert.deepEqual(errors, []);
    return result;
  } finally {
    await page.close();
  }
}

async function start(page, count = 1) {
  return page.evaluate((count) => {
    const fixture = window.wallFixture;
    const at = fixture.snapshot().timeMs;
    const requested = fixture.start(count);
    return { at, requested };
  }, count);
}

async function verifyCorner(page, legacy = false) {
  const { requested } = await start(page);
  assert.equal(requested, 1);
  await page.waitForFunction(() => {
    const { turn, timeMs } = window.wallFixture.snapshot();
    return turn && timeMs >= turn.at + 108;
  });
  const { turn, health, hitTrace, targeting, wallHp } = await page.evaluate(() => window.wallFixture.snapshot(true));
  const range = PLAYTEST_PROFILE.towerTuning.piercingFallbackRange ?? 3;
  assert.equal(turn.hp, 14);
  assert.equal(turn.gateHp, 25);
  assert.equal(wallHp, 25);
  assert.deepEqual(turn.to, { col: 10 + range, row: 11 });
  assert.ok(turn.center.y > 10.77);
  const relevant = targeting.filter((frame) => frame.timeMs >= turn.at);
  assert.ok(relevant.some((frame) => frame.candidates.some((enemy) => enemy.mainRejection === "WRONG_AXIS")));
  if (legacy) {
    assert.deepEqual(hitTrace, []);
    assert.deepEqual(health, [[turn.enemyId, 14]]);
    assert.ok(relevant.some(({ reason }) => reason === "BLOCKED_BY_FRIENDLY_WALL"));
  } else {
    const shot = hitTrace.find(({ event }) => event.type === "towerShot");
    const effect = hitTrace.find(({ event }) => event.type === "towerEffect");
    assert.equal(shot.event.damage, 2);
    assert.equal(shot.event.towerId, turn.towerId);
    assert.equal(shot.event.enemyId, turn.enemyId);
    assert.equal(shot.metadata.enemyKind, "armored");
    assert.equal(effect.event.effect.kind, "piercingFallback");
    assert.ok(shot.at - turn.at < 64);
    assert.deepEqual(health, [[turn.enemyId, 12]]);
    assert.ok(relevant.some(({ reason }) => reason === "HIT"));
    assert.ok(relevant.some(({ reason }) => reason === "COOLDOWN"));
  }
  return { range, turn, gateHpAfter: wallHp, health, hitTrace,
    decisions: [...new Set(relevant.map(({ reason }) => reason))] };
}

async function verifySolid(page) {
  const { at, requested } = await start(page);
  assert.equal(requested, 1);
  await page.waitForFunction((at) => window.wallFixture.snapshot().timeMs >= at + 650, at);
  const { wallHp, health, targeting, hitTrace } = await page.evaluate(() => window.wallFixture.snapshot(true));
  const denied = targeting.find(({ candidates }) => candidates.some((enemy) => enemy.inSearchRange
    && enemy.bodyInAttackArea && enemy.mainRejection === "BLOCKED_BY_SOLID_TERRAIN"));
  assert.ok(denied, "A solid tile behind the near wall must clip a valid axis shot");
  assert.deepEqual(health, [[1, 14]]);
  assert.deepEqual(hitTrace, []);
  assert.equal(wallHp, 25);
  return { wallHp, health, denied };
}

async function verifyBurst(page, outside = false) {
  const { at, requested } = await start(page);
  assert.equal(requested, outside ? 1 : 4);
  await page.waitForFunction((at) => window.wallFixture.snapshot().timeMs >= at + 160, at);
  const { health, targeting, hitTrace, wallHp } = await page.evaluate(() => window.wallFixture.snapshot(true));
  const range = PLAYTEST_PROFILE.towerTuning.burstRange ?? 4;
  assert.equal(wallHp, 25);
  const candidates = targeting.find((trace) => trace.candidates.length > 0);
  assert.ok(candidates);
  if (outside) {
    assert.deepEqual(health, [[1, 14]]);
    assert.deepEqual(hitTrace, []);
    assert.equal(candidates.reason, "OUT_OF_RANGE");
  } else {
    assert.ok(candidates.candidates[0].centerDistance > range && candidates.candidates[0].inSearchRange);
    assert.ok(candidates.candidates.slice(1).every(({ mainRejection }) => mainRejection === "OUT_OF_RANGE"));
    const effect = hitTrace.find(({ event }) => event.type === "towerEffect")?.event;
    assert.deepEqual(effect?.enemyIds, [1, 2, 3]);
    assert.equal(effect.effect.radius, 2);
    assert.deepEqual(health, [[1, 10], [2, 12], [3, 12], [4, 14]]);
  }
  return { range, wallHp, health, hitTrace, candidates };
}

function summarize(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (fraction) => ordered[Math.ceil(fraction * ordered.length) - 1];
  return { samples: samples.length, p95: percentile(0.95), p99: percentile(0.99), max: ordered.at(-1) };
}

async function verifyPerformance(page, count, targetMs) {
  const result = await page.evaluate(({ count, targetMs }) => new Promise((resolve) => {
    const fixture = window.wallFixture;
    const requested = fixture.start(count);
    const nativeRaf = Function.prototype.toString.call(requestAnimationFrame).includes("[native code]");
    const started = performance.now();
    let previous;
    let peak = 0;
    let peakVisible = 0;
    const intervals = [];
    requestAnimationFrame(function sample(time) {
      if (previous !== undefined) intervals.push(time - previous);
      previous = time;
      const state = fixture.snapshot();
      peak = Math.max(peak, state.counts.spawned - state.counts.removed);
      peakVisible = Math.max(peakVisible, state.visible);
      if (performance.now() - started < targetMs) requestAnimationFrame(sample);
      else resolve({ requested, nativeRaf, elapsedMs: performance.now() - started, peak, peakVisible, intervals, state });
    });
  }), { count, targetMs });
  const { requested, nativeRaf, elapsedMs, peak, peakVisible, state, intervals } = result;
  assert.equal(nativeRaf, true);
  assert.equal(state.currentVisibility, "visible");
  assert.equal(state.farVisibility, "unknown");
  assert.ok(elapsedMs >= targetMs && intervals.length >= 30 && peakVisible > 0);
  const minimumFires = count === "sustained" ? 2 : 1;
  assert.ok(state.landings.piercing?.fires >= minimumFires && state.landings.burst?.fires >= minimumFires,
    JSON.stringify({ count, landings: state.landings, metrics: state.metrics, counts: state.counts, peak }));
  if (count === "sustained") {
    assert.equal(requested, 180);
    assert.ok(state.counts.spawned >= 100);
  } else {
    assert.equal(requested, count);
    assert.equal(peak, count);
    assert.equal(state.counts.spawned, count);
    assert.ok(state.landings.piercing.maxTargets >= 2 && state.landings.burst.maxTargets >= 2);
  }
  const piercing = state.metrics.filter(({ kind }) => kind === "piercing");
  assert.equal(piercing.length, 2);
  const firingEvaluationsPerSecond = piercing.reduce((total, { searches }) => total + searches, 0) * 1000 / elapsedMs;
  return { count, ...result, frameMs: summarize(intervals), firingEvaluationsPerSecond };
}

const { server, url } = await serveFixture();
const browser = await chromium.launch({ channel: "msedge" });
const performance = [];
try {
  const cases = { corner: await withFixture(browser, url, "corner", verifyCorner),
    priorWallRule: await withFixture(browser, url, "corner&legacy=1", (page) => verifyCorner(page, true)),
    dirt: await withFixture(browser, url, "dirt", verifySolid), rock: await withFixture(browser, url, "rock", verifySolid),
    burstEdge: await withFixture(browser, url, "burst-edge", verifyBurst),
    burstOutside: await withFixture(browser, url, "burst-outside", (page) => verifyBurst(page, true)) };
  console.log(JSON.stringify({ type: "controlled", version: browser.version(), viewport, cases }));
  if (!process.argv.includes("--short")) {
    for (const count of [50, 100, 250, "sustained"]) {
      const result = await withFixture(browser, url, "stress",
        (page) => verifyPerformance(page, count, count === "sustained" ? 26_000 : 3_000));
      performance.push(result);
      const { intervals, ...summary } = result;
      console.log(JSON.stringify({ type: "performance", ...summary }));
    }
  }
  if (process.argv.includes("--record")) {
    const directory = join(await realpath(root), ".estd-private");
    await mkdir(directory, { recursive: true });
    assert.equal(await realpath(directory), directory);
    await writeFile(join(directory, "p0-j-fix02-edge-controlled.json"),
      JSON.stringify({ version: browser.version(), viewport, cases, performance }, null, 2));
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

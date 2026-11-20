import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "vite";
import { PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";

const host = "127.0.0.1";
const viewport = { width: 1280, height: 900 };
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = {
  name: "tower-evolution-perf-fixture",
  transformIndexHtml: {
    order: "pre",
    handler(html) {
      const entry = "/src/main.ts";
      assert.ok(html.includes(entry));
      return html.replace(entry, "/tests/browser-tower-evolution-perf-fixture.mjs");
    },
  },
};

async function buildFixture() {
  const bundled = await build({
    root, mode: "regression", plugins: [fixture], logLevel: "warn",
    build: { write: false, emptyOutDir: false },
  });
  assert.ok(bundled && !Array.isArray(bundled) && "output" in bundled);
  const files = new Map(bundled.output.map((file) => [`/${file.fileName}`, file]));
  const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const file = files.get(path === "/" ? "/index.html" : path);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    const contentType = contentTypes[extname(file.fileName)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(file.type === "chunk" ? file.code : file.source);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://${host}:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function summarize(samples) {
  assert.ok(samples.length > 0);
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.ceil(fraction * ordered.length) - 1];
  return { count: samples.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), worstMs: ordered.at(-1) };
}

async function measure(browser, url, scopedCount, sampleMs) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.towerEvolutionPerfFixture?.visibility().current === "visible");
    const raw = await page.evaluate(({ scopedCount, sampleMs }) => new Promise((resolve) => {
      const fixture = window.towerEvolutionPerfFixture;
      const stats = document.getElementById("defense-stats").dataset;
      const windowOpenedAt = performance.now();
      const nativeRaf = Function.prototype.toString.call(requestAnimationFrame).includes("[native code]");
      const initial = fixture.start(scopedCount);
      const frameSpans = [];
      const effectWindows = [];
      let lastFrame;
      let firstFrameActive;
      let peakActive = 0;
      let peakVisible = 0;
      let maxPiercingTargets = 0;
      let maxBurstTargets = 0;
      let burstsWithOverlappingEffects = 0;
      let nextEffectSampleAt = windowOpenedAt + 2_000;
      let seenEffects;
      let effects = { piercing: 0, burst: 0, recent: [] };
      const countedOverlaps = new Set();
      const countedAttacks = new Set();
      const towerActivity = {};
      const canvas = document.querySelector("#board canvas");
      const display = { devicePixelRatio, canvasWidth: canvas.width, canvasHeight: canvas.height };

      requestAnimationFrame(function sample(timestamp) {
        if (lastFrame !== undefined) frameSpans.push(timestamp - lastFrame);
        lastFrame = timestamp;
        const active = Number(stats.active);
        firstFrameActive ??= active;
        peakActive = Math.max(peakActive, active);
        peakVisible = Math.max(peakVisible, Number(stats.visible));
        if (stats.towerEffects && stats.towerEffects !== seenEffects) {
          seenEffects = stats.towerEffects;
          effects = JSON.parse(seenEffects);
          for (const event of effects.recent) {
            const attackKey = `${event.towerId}:${event.timeMs}`;
            const kind = event.effect.kind;
            if (!countedAttacks.has(attackKey)) {
              countedAttacks.add(attackKey);
              const summary = towerActivity[event.towerId] ??= { kind, shots: 0, grouped: 0, targets: 0 };
              summary.shots += 1;
              summary.grouped += Number(event.enemyIds.length > 1);
              summary.targets += event.enemyIds.length;
            }
            if (kind === "piercing") maxPiercingTargets = Math.max(maxPiercingTargets, event.enemyIds.length);
            if (kind !== "burst") continue;
            maxBurstTargets = Math.max(maxBurstTargets, event.enemyIds.length);
            if (!countedOverlaps.has(attackKey) && effects.recent.some((other) => other.effect.kind === "piercing"
                && Math.abs(other.timeMs - event.timeMs) < 140)) {
              countedOverlaps.add(attackKey);
              burstsWithOverlappingEffects += 1;
            }
          }
        }
        const now = performance.now();
        if (now >= nextEffectSampleAt) {
          effectWindows.push({ atMs: now - windowOpenedAt, piercing: effects.piercing, burst: effects.burst });
          nextEffectSampleAt += 2_000;
        }
        if (now - windowOpenedAt < sampleMs) {
          requestAnimationFrame(sample);
          return;
        }
        resolve({
          nativeRaf, durationMs: now - windowOpenedAt, ...initial, firstFrameActive, peakActive, peakVisible,
          spawned: Number(stats.spawned), removed: Number(stats.removed), hitEvents: Number(stats.shots),
          towerKills: Number(stats.towerKills), piercingAttacks: effects.piercing, burstAttacks: effects.burst,
          maxPiercingTargets, maxBurstTargets, burstsWithOverlappingEffects, effectWindows, towerActivity, display,
          visibility: fixture.visibility(),
          frameSpans, simulationStepSpans: fixture.stop(),
        });
      });
    }), { scopedCount, sampleMs });
    assert.deepEqual(errors, []);
    assert.equal(raw.nativeRaf, true);
    assert.deepEqual(raw.visibility, { current: "visible", far: "unknown" });
    assert.ok(raw.durationMs >= sampleMs && raw.frameSpans.length >= 30);
    const towerActivity = Object.values(raw.towerActivity);
    assert.equal(towerActivity.reduce((sum, tower) => sum + tower.shots, 0), raw.piercingAttacks + raw.burstAttacks);
    assert.equal(towerActivity.reduce((sum, tower) => sum + tower.targets, 0), raw.hitEvents);
    if (scopedCount === "sustained") {
      assert.ok(raw.spawned >= 60 && raw.peakVisible > 0);
      assert.ok(raw.piercingAttacks >= 10 && raw.burstAttacks >= 10);
      assert.ok(raw.maxPiercingTargets > 1 && raw.maxBurstTargets > 1);
      assert.ok(raw.burstsWithOverlappingEffects > 0);
      for (const kind of ["piercing", "burst"]) {
        assert.equal(towerActivity.filter((tower) => tower.kind === kind && tower.grouped > 0).length, 2,
          `Both ${kind} towers must record a grouped hit in the sustained sample`);
      }
      let lastPiercing = 0;
      let lastBurst = 0;
      for (const window of raw.effectWindows) {
        assert.ok(window.piercing > lastPiercing && window.burst > lastBurst);
        lastPiercing = window.piercing;
        lastBurst = window.burst;
      }
    } else if (scopedCount > 0) {
      assert.equal(raw.requested, scopedCount);
      assert.equal(raw.spawned, scopedCount);
      assert.equal(raw.initialActive, scopedCount);
      assert.equal(raw.peakActive, scopedCount);
      assert.ok(raw.peakVisible > 0);
      assert.ok(raw.piercingAttacks > 0 && raw.burstAttacks > 0);
      assert.ok(raw.maxPiercingTargets > 1 && raw.maxBurstTargets > 1);
    }
    return {
      case: scopedCount === 0 ? "idle" : scopedCount, ...raw, errors,
      frames: summarize(raw.frameSpans), simulation: summarize(raw.simulationStepSpans),
    };
  } finally {
    await page.close();
  }
}

const server = await buildFixture();
const results = [];
try {
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const cases = [[0, 2_000], [50, 3_000], [100, 3_000], [250, 3_000], ["sustained", 26_000]];
    for (const [count, duration] of cases) {
      const raw = await measure(browser, server.url, count, duration);
      results.push(raw);
      const { frameSpans, simulationStepSpans, ...summary } = raw;
      console.log(JSON.stringify(summary));
    }
    if (process.argv.includes("--record")) {
      const directory = join(await realpath(root), ".estd-private");
      await mkdir(directory, { recursive: true });
      assert.equal(await realpath(directory), directory);
      const filename = `p0-i-fix01-edge-perf-${new Date().toISOString().replaceAll(":", "-")}.json`;
      const output = join(directory, filename);
      await writeFile(output, JSON.stringify({
        edge: browser.version(), viewport, towerTuning: PLAYTEST_TOWER_TUNING,
        source: "Compiled Vite test entry with real GridScene, Phaser canvas, real simulation, native RAF",
        results,
      }, null, 2), { flag: "wx" });
      console.log(`Raw private results saved to ${output}`);
    }
    console.log(`Edge ${browser.version()} · native RAF · ${viewport.width}×${viewport.height} · fog enabled`);
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

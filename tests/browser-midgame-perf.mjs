import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { TILE_SIZE } from "../src/player.ts";
import { startFirstWave } from "./browser-challenge.mjs";
import { preparePaidTowers } from "./browser-midgame-economy.mjs";

const host = "127.0.0.1";
const root = fileURLToPath(new URL("..", import.meta.url));
const seed = 515;
const sampleMs = 25_000;
const cell = (col, row) => ({ col, row });
const towerColumns = [27, 21, 23, 28];

async function visibleBeamOrigins(page, game) {
  const view = await game.view();
  return page.locator("#board canvas").evaluate((canvas, { view, tile, columns }) => {
    const ctx = canvas.getContext("2d");
    return columns.filter((col) => {
      const x = Math.round(((col + 0.5) * tile - view.left) * canvas.width / view.width);
      const y = Math.round((91.5 * tile - view.top) * canvas.height / view.height);
      if (x < 4 || y < 4 || x + 4 >= canvas.width || y + 4 >= canvas.height) return false;
      const pixels = ctx.getImageData(x - 4, y - 4, 9, 9).data;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset] === 154 && pixels[offset + 1] === 245 && pixels[offset + 2] === 255) return true;
      }
      return false;
    });
  }, { view, tile: TILE_SIZE, columns: towerColumns });
}

async function sustainedDefense(page, url) {
  // Keep the browser's native frame sampler while Playwright advances legal preparation actions.
  await page.addInitScript(() => {
    const frame = window.requestAnimationFrame;
    const now = performance.now;
    window.estdNativeSampler = {
      frame: frame.bind(window), now: now.bind(performance),
      native: [frame, now].every((api) => Function.prototype.toString.call(api).includes("[native code]")),
    };
  });
  const run = await preparePaidTowers(page, url, "combat-combined", towerColumns);
  await run.returnTo(cell(21, 92));
  await run.game.settleView();
  await startFirstWave(page, run.start);
  let beamOrigins = await visibleBeamOrigins(page, run.game);
  for (let attempt = 0; beamOrigins.length < 2 && attempt < 12; attempt += 1) {
    await page.clock.runFor(48);
    beamOrigins = await visibleBeamOrigins(page, run.game);
  }
  assert.ok(await page.evaluate(() => window.estdNativeSampler.native), "Frame sampler must use browser RAF");
  await page.clock.resume();
  const result = await page.evaluate((duration) => new Promise((resolve) => {
    const { frame, now } = window.estdNativeSampler;
    const stats = document.getElementById("defense-stats").dataset;
    const wave = document.getElementById("round-wave");
    const round = document.getElementById("round-state");
    const begin = now();
    const initialShots = Number(stats.shots);
    const spans = [];
    const waves = new Set();
    let last;
    let peakActive = 0;
    let peakVisible = 0;
    frame(function sample(timestamp) {
      if (last !== undefined) spans.push(timestamp - last);
      last = timestamp;
      const elapsedMs = now() - begin;
      peakActive = Math.max(peakActive, Number(stats.active));
      peakVisible = Math.max(peakVisible, Number(stats.visible));
      if (round.dataset.phase === "attacking") waves.add(Number(wave.textContent));
      if (elapsedMs < duration && round.dataset.phase !== "lost") {
        frame(sample);
        return;
      }
      spans.sort((a, b) => a - b);
      const at = (fraction) => spans[Math.ceil(spans.length * fraction) - 1];
      resolve({ elapsedMs, frames: spans.length, medianFrameMs: at(0.5), p95FrameMs: at(0.95),
        worstFrameMs: spans.at(-1), peakActive, peakVisible, waves: [...waves],
        newShots: Number(stats.shots) - initialShots, towerKills: Number(stats.towerKills),
        spawned: Number(stats.spawned), phase: round.dataset.phase });
    });
  }), sampleMs);
  assert.ok(result.elapsedMs >= 20_000, "A meaningful sample must include combat and recovery");
  assert.ok(result.frames > 100 && result.waves.length >= 2, "Sample both actual attack waves");
  assert.ok(result.newShots >= 14 && result.towerKills > 0 && result.peakVisible > 0);
  return { seed, fog: true, paidTowers: 4, beamOriginsSameFrame: beamOrigins, clockResumed: true, ...result };
}

const server = await preview({ root, preview: { host, port: 0, strictPort: true } });
try {
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const result = await sustainedDefense(page, `http://${host}:${address.port}`);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ edge: browser.version(), viewport: "1280x900", ...result }));
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

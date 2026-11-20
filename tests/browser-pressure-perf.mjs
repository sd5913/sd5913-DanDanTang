import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const host = '127.0.0.1';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await preview({ root, preview: { host, port: 0, strictPort: true } });
try {
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object');
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    console.log(`Edge ${browser.version()} · production · seed 12 · wait-test · 1280×900 · live RAF`);
    for (const [profile, expected] of [['baseline', 3], ['a', 10], ['b', 10]]) {
      for (let trial = 1; trial <= 3; trial += 1) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await page.goto(`http://${host}:${address.port}/?mode=play&seed=12&speed=wait-test&debug=1&difficulty=${profile}`);
          const result = await page.evaluate(() => new Promise((resolve, reject) => {
            const stats = document.querySelector('#defense-stats').dataset;
            const frames = [];
            let started;
            let last;
            let initialSearches;
            let initialSearchMs;
            let startSearchCount = Number(stats.searches) || 0;
            let startSearchTime = Number(stats.searchMs) || 0;
            const deadline = performance.now() + 12_000;
            requestAnimationFrame(sample);

            function sample(now) {
              const delayed = now > deadline;
              const wave = JSON.parse(stats.waveCombat || '[]')[0];
              if (!wave) {
                if (delayed) { reject(new Error('The first scheduled wave never started')); return; }
                startSearchCount = Number(stats.searches) || 0;
                startSearchTime = Number(stats.searchMs) || 0;
                requestAnimationFrame(sample);
                return;
              }
              if (started === undefined) {
                started = last = now;
                initialSearches = startSearchCount;
                initialSearchMs = startSearchTime;
              } else {
                frames.push(now - last);
                last = now;
              }
              if (wave.attackEndedAtMs === null) {
                if (delayed) { reject(new Error('The first scheduled cohort did not settle')); return; }
                requestAnimationFrame(sample);
                return;
              }
              frames.sort((a, b) => a - b);
              resolve({
                frames: frames.length, sampleMs: last - started, planned: wave.planned,
                spawned: wave.spawned, peakActive: wave.peakActive,
                searches: Number(stats.searches) - initialSearches,
                searchMs: Number(stats.searchMs) - initialSearchMs,
                medianFrameMs: frames[Math.ceil(frames.length / 2) - 1],
                p95FrameMs: frames[Math.ceil(frames.length * 0.95) - 1],
                worstFrameMs: frames.at(-1),
              });
            }
          }));
          assert.equal(result.planned, expected);
          assert.equal(result.spawned, expected);
          assert.ok(result.peakActive > 0 && result.peakActive <= expected);
          assert.ok(result.searches > 0 && result.searchMs >= 0);
          assert.ok(result.frames >= 20 && Number.isFinite(result.p95FrameMs));
          assert.deepEqual(errors, []);
          console.log(JSON.stringify({ profile, trial, ...result }));
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

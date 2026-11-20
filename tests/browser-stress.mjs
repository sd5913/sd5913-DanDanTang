import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const host = '127.0.0.1';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await preview({ root, preview: { host, port: 0, strictPort: true } });
try {
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object', 'Vite did not bind a TCP port');
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    console.log(`Edge ${browser.version()} · Vite production · 1280 × 900 · 1250 ms per sample · seed 12 · fog off`);
    for (const count of [50, 100, 250]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`http://${host}:${address.port}/?mode=play&seed=12&debug=1&fog=off`);
        await page.waitForFunction(() => document.querySelector('#defense-stats').dataset.active === '0');
        await page.locator('#expedition-stress-count').selectOption(String(count));
        const stats = await page.evaluate(async () => {
          const source = document.querySelector('#defense-stats').dataset;
          const sums = { fields: Number(source.searches), ms: Number(source.searchMs) };
          const frames = [];
          const active = [];
          let maxVisible = 0;
          let start;
          let last;

          await new Promise((resolve) => {
            requestAnimationFrame((timestamp) => {
              start = last = timestamp;
              document.querySelector('#expedition-stress').click();
              requestAnimationFrame(sample);
            });

            function sample(timestamp) {
              frames.push(timestamp - last);
              last = timestamp;
              active.push(Number(source.active));
              maxVisible = Math.max(maxVisible, Number(source.visible));
              if (timestamp - start < 1250) requestAnimationFrame(sample);
              else resolve();
            }
          });
          frames.sort((a, b) => a - b);
          return {
            frames: frames.length, elapsedMs: last - start,
            meanFrameMs: frames.reduce((sum, value) => sum + value, 0) / frames.length,
            p95FrameMs: frames[Math.ceil(frames.length * 0.95) - 1],
            worstFrameMs: frames.at(-1),
            minActive: Math.min(...active), maxActive: Math.max(...active), maxVisible,
            requested: Number(source.requested), spawned: Number(source.spawned),
            removed: Number(source.removed), pending: Number(source.pending),
            searchFields: Number(source.searches) - sums.fields,
            searchMs: Number(source.searchMs) - sums.ms,
          };
        });

        assert.equal(stats.requested, count);
        assert.equal(stats.spawned, count);
        assert.equal(stats.minActive, count);
        assert.equal(stats.maxActive, count);
        assert.equal(stats.pending, 0);
        assert.equal(stats.removed, 0);
        assert.ok(stats.maxVisible > 0, 'The scene must render the group during sampling');
        assert.ok(stats.searchFields > 0 && stats.searchMs > 0, 'Must measure a live navigation field');
        assert.deepEqual(errors, [], 'Browser console and page must have no errors');
        console.log(JSON.stringify({ count, ...stats }));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

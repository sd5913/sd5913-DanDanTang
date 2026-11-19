import assert from 'node:assert/strict';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { TILE_SIZE } from '../src/player.ts';

const col = 11;
const spawnRow = 92;
const entryRow = 91;
const seamRow = 63;
const openedRouteRows = [91, 90, 89, 88, 87, 79, 78, 77, 76, 75, 74, 73, 72, 71, 63];
const viewWidth = 24 * TILE_SIZE;
const viewHeight = 32 * TILE_SIZE;
const { dirtMaxHp, attackIntervalMs } = MINING_CONFIG;

export async function runDenseMapSmoke(page, url) {
  const board = page.locator('#board canvas');
  const position = page.locator('#player-cell');
  const camera = page.locator('#visible-chunks');
  const hover = page.locator('#hover-cell');
  const digResult = page.locator('#dig-result');

  async function playerRow() {
    const description = await position.textContent();
    const match = description.match(/^\(11,\s*(\d+)\)$/);
    assert.ok(match, `Unexpected player coordinates ${description}`);
    return Number(match[1]);
  }

  async function worldTop() {
    const top = Number.parseFloat(await camera.getAttribute('data-world-top'));
    assert.ok(Number.isFinite(top), 'Expected a synchronized camera view');
    return top;
  }

  async function holdKey(key, action) {
    await page.keyboard.down(key);
    try {
      await action();
    } finally {
      await page.keyboard.up(key);
    }
  }

  async function walkNorthTo(target) {
    let row = await playerRow();
    assert.ok(row >= target);
    let stalled = 0;
    await holdKey('KeyW', async () => {
      while (row > target) {
        await page.clock.runFor(Math.max(48, (row - target - 1) * 120));
        const next = await playerRow();
        stalled = next === row ? stalled + 1 : 0;
        assert.ok(stalled < 8, `Unexpected obstacle north of row ${row}`);
        assert.ok(next <= row && next >= target, `Passed destination row ${target}`);
        row = next;
      }
    });
  }

  async function inspect(row, terrain, hp) {
    const box = await board.boundingBox();
    const y = (row + 0.5) * TILE_SIZE - await worldTop();
    assert.ok(box && y >= 0 && y < viewHeight, `Row ${row} must be within the camera`);
    const x = (col + 0.5) * TILE_SIZE;
    await page.mouse.move(box.x + x * box.width / viewWidth, box.y + y * box.height / viewHeight);
    const text = await hover.textContent();
    for (const expected of [terrain, `(${col}, ${row})`, hp]) {
      if (expected) assert.ok(text.includes(expected), `Expected ${expected} while hovering, saw ${text}`);
    }
  }

  async function tilePixel(row) {
    await page.clock.runFor(32);
    const x = Math.floor((col + 0.75) * TILE_SIZE);
    const y = Math.floor((row + 0.35) * TILE_SIZE - await worldTop());
    return board.evaluate((canvas, { x, y }) => Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data), { x, y });
  }

  async function mineFor(ms) {
    await page.mouse.down({ button: 'left' });
    try {
      await page.clock.runFor(ms);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
  }

  async function clearDirt(row) {
    await inspect(row, '可挖地形');
    await mineFor(dirtMaxHp * attackIntervalMs + 64);
    await inspect(row, '空地');
    const result = await digResult.textContent();
    assert.ok(result.includes('挖掘成功') && result.includes(`(${col}, ${row})`), result);
  }

  await page.clock.install();
  assert.equal((await page.goto(url))?.status(), 200);
  await board.waitFor();
  await page.waitForFunction(() => Number(document.querySelector('#visible-chunks')?.dataset.count) > 0);
  assert.match(await page.locator('#map-size').textContent(), /24 × 96/);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  assert.equal(await playerRow(), spawnRow);
  assert.equal(await worldTop(), 64 * TILE_SIZE);
  await inspect(entryRow, '可挖地形', `HP ${dirtMaxHp}/${dirtMaxHp}`);
  const originalDirt = await tilePixel(entryRow);
  await holdKey('KeyW', () => page.clock.runFor(500));
  assert.equal(await playerRow(), spawnRow, 'The first dirt tile must block movement');

  await mineFor(64);
  await inspect(entryRow, '可挖地形', `HP ${dirtMaxHp - 1}/${dirtMaxHp}`);
  assert.notDeepEqual(await tilePixel(entryRow), originalDirt, 'Partial damage must be drawn');
  await holdKey('KeyW', () => page.clock.runFor(500));
  assert.equal(await playerRow(), spawnRow, 'Partial damage must not make terrain walkable');

  for (const row of openedRouteRows) {
    await walkNorthTo(row + 1);
    if (row === seamRow) {
      await inspect(row, '可挖地形', `HP ${dirtMaxHp}/${dirtMaxHp}`);
      await holdKey('KeyW', () => page.clock.runFor(500));
      assert.equal(await playerRow(), row + 1, 'The central seam must remain blocked until excavated');
    }
    await clearDirt(row);
    if (row === entryRow) assert.notDeepEqual(await tilePixel(row), originalDirt, 'The cleared block must render as empty');
    await walkNorthTo(row);
  }

  assert.equal(await page.locator('#chunk-status').textContent(), '(0, 1)');
  await holdKey('KeyR', () => page.clock.runFor(48));
  assert.equal(await playerRow(), spawnRow);
  assert.equal(await worldTop(), 64 * TILE_SIZE);
  await inspect(entryRow, '可挖地形', `HP ${dirtMaxHp}/${dirtMaxHp}`);
  assert.deepEqual(await tilePixel(entryRow), originalDirt, 'Reset must restore the dense spawn terrain drawing');
  return openedRouteRows.length;
}

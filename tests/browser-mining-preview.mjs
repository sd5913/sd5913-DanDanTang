import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE, TECHNOLOGY_PROTOTYPE } from '../src/expedition-economy.ts';
import { MINING_CONFIG, TERRAIN_HP_BY_LEVEL } from '../src/mining-config.ts';
import { TILE_SIZE } from '../src/player.ts';
import { openWideGame, playFixture } from './browser-fix02.mjs';

const lane = (row) => ({ col: 19, row });
const label = ({ col, row }) => `(${col}, ${row})`;
const STEP_MS = 32;

async function amberEdges(board, view, cell) {
  return board.evaluate((canvas, { view, cell, size }) => {
    const worldLeft = cell.col * size;
    const worldTop = cell.row * size;
    const x0 = Math.floor((worldLeft - view.left) * canvas.width / view.width);
    const y0 = Math.floor((worldTop - view.top) * canvas.height / view.height);
    const x1 = Math.ceil((worldLeft + size - view.left) * canvas.width / view.width);
    const y1 = Math.ceil((worldTop + size - view.top) * canvas.height / view.height);
    if (x0 < 0 || y0 < 0 || x1 > canvas.width || y1 > canvas.height) return null;

    const width = x1 - x0;
    const height = y1 - y0;
    const pixels = canvas.getContext('2d').getImageData(x0, y0, width, height).data;
    const edges = { top: 0, right: 0, bottom: 0, left: 0, total: 0 };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (pixels[index] < 248 || Math.abs(pixels[index + 1] - 207) > 7 || Math.abs(pixels[index + 2] - 117) > 8) continue;
        const localX = view.left + (x0 + x + 0.5) * view.width / canvas.width - worldLeft;
        const localY = view.top + (y0 + y + 0.5) * view.height / canvas.height - worldTop;
        if (localX < 0 || localX >= size || localY < 0 || localY >= size) continue;
        edges.total += 1;
        if (localX >= 4 && localX <= size - 4) {
          if (Math.abs(localY - 1) <= 1.5) edges.top += 1;
          if (Math.abs(localY - (size - 1)) <= 1.5) edges.bottom += 1;
        }
        if (localY >= 4 && localY <= size - 4) {
          if (Math.abs(localX - 1) <= 1.5) edges.left += 1;
          if (Math.abs(localX - (size - 1)) <= 1.5) edges.right += 1;
        }
      }
    }
    return edges;
  }, { view, cell, size: TILE_SIZE });
}

async function advanceUntil(page, condition, budget, message) {
  for (let elapsed = 0; elapsed <= budget; elapsed += STEP_MS) {
    if (await condition()) return;
    await page.clock.runFor(STEP_MS);
  }
  assert.fail(message);
}

export async function runWideMiningPreviewSmoke(page, url) {
  const seed = Number(new URL(url).searchParams.get('seed'));
  const { layout } = playFixture(seed);
  const game = await openWideGame(page, url, layout);
  const board = page.locator('#board canvas');
  const hover = page.locator('#hover-cell');
  const originalViewport = page.viewportSize();

  async function readPreview(cell) {
    const colors = await amberEdges(board, await game.view(), cell);
    assert.ok(colors, `Tile ${label(cell)} must be fully on screen for its Canvas preview check`);
    return colors;
  }

  async function assertPreview(cell) {
    const edges = await readPreview(cell);
    assert.ok([edges.top, edges.right, edges.bottom, edges.left].every((count) => count >= 5),
      `Expected the amber outline inset inside all four world edges of ${label(cell)}, saw ${JSON.stringify(edges)}`);
  }

  async function assertNoPreview(cell, message) {
    assert.equal((await readPreview(cell)).total, 0, `${message} at ${label(cell)}`);
  }

  const first = lane(93);
  const distant = lane(94);
  const unknown = lane(82);
  assert.equal(layout[first.row][first.col], '+');
  assert.equal(layout[distant.row][distant.col], '+');
  await game.inspect(first, '可挖地形', 'HP 5/5');
  await assertNoPreview(first, 'An idle valid aim must not draw a held preview');
  await page.mouse.down({ button: 'left' });
  try {
    await page.clock.runFor(STEP_MS);
    await assertPreview(first);
    await game.aimAt(unknown);
    await page.clock.runFor(STEP_MS);
    assert.equal(await hover.getAttribute('data-visibility'), 'unknown');
    await assertPreview(first);
    await assertNoPreview(unknown, 'The lock must not reveal a new target inside the fog');
    const fogPixel = await game.tilePixel(unknown);

    await page.clock.runFor(MINING_CONFIG.dirtMaxHp * MINING_CONFIG.attackIntervalMs + 64);
    await assertNoPreview(first, 'A cleared target must lose its amber outline');
    await assertNoPreview(unknown, 'A held mouse must not nominate an unknown cell');
    assert.deepEqual(await game.tilePixel(unknown), fogPixel, 'The fog pixel must remain covered after the lock clears');
    await game.inspect(distant, '可挖地形', 'HP 5/5');
    await page.clock.runFor(MINING_CONFIG.attackIntervalMs + STEP_MS);
    await assertNoPreview(distant, 'Visible dirt beyond digging range is not a valid continuation');
    await game.inspect(distant, 'HP 5/5');
  } finally {
    await page.mouse.up({ button: 'left' });
  }

  const producer = { col: 20, row: 91 };
  await page.locator('#card-economy').click();
  await game.inspect(producer, '空地');
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.clock.runFor(2 * ECONOMY_PROTOTYPE.productionIntervalMs + STEP_MS);
  assert.equal(Number(await page.locator('#economy-balance').textContent()), TECHNOLOGY_PROTOTYPE.researchCost);
  await page.locator('#research-tool').click();
  assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2');

  await game.openLineTo(lane(65), true);
  const beforeResize = await game.settleView();
  const beforeSeam = lane(64);
  const acrossSeam = lane(63);
  assert.equal(layout[beforeSeam.row][beforeSeam.col], '+');
  assert.equal(layout[acrossSeam.row][acrossSeam.col], '2');
  assert.equal(await page.locator('#chunk-status').textContent(), '(0, 2)');
  await game.inspect(beforeSeam, '可挖地形', 'Lv.1');
  await assertNoPreview(beforeSeam, 'An idle aim across the viewport must not show amber');

  await page.mouse.down({ button: 'left' });
  try {
    await page.clock.runFor(STEP_MS);
    await assertPreview(beforeSeam);
    await game.aimAt(acrossSeam);
    await page.setViewportSize({ width: 1000, height: 750 });
    await page.clock.runFor(3 * STEP_MS);
    const resized = await game.view();
    assert.ok(Math.abs(resized.height - beforeResize.height) > TILE_SIZE, 'Changing the window must really resize the world projection');
    await assertPreview(beforeSeam);
    await assertNoPreview(acrossSeam, 'The lock must survive resize without jumping to the out-of-range aim');

    await page.keyboard.down('KeyW');
    try {
      await advanceUntil(page, async () => (await game.position()).row === beforeSeam.row
        && (await readPreview(acrossSeam)).top >= 5, 2_500, 'Northbound hold never showed the seam target after clearing the previous tile');
      await assertPreview(acrossSeam);
      await assertNoPreview(beforeSeam, 'Only the new northbound world target should carry amber');
      assert.equal(await page.locator('#chunk-status').textContent(), '(0, 2)');

      await advanceUntil(page, async () => (await game.position()).row === acrossSeam.row,
        TERRAIN_HP_BY_LEVEL[2] * MINING_CONFIG.attackIntervalMs + 1_000, 'Mining and walking did not cross the real chunk boundary');
      assert.equal(await page.locator('#chunk-status').textContent(), '(0, 1)');
      assert.ok((await game.view()).top < resized.top - TILE_SIZE, 'The camera must track the player across the chunk boundary');
      await assertNoPreview(acrossSeam, 'The cleared seam must not retain its amber outline after the camera moves');
    } finally {
      await page.keyboard.up('KeyW');
    }
  } finally {
    await page.mouse.up({ button: 'left' });
    if (originalViewport) await page.setViewportSize(originalViewport);
  }

  await page.clock.runFor(3 * STEP_MS);
  await game.inspect(acrossSeam, '空地');
  await assertNoPreview(acrossSeam, 'Releasing the held input must leave the old tile unmarked');
}

export async function runTerminalMiningPreviewSmoke(page, url) {
  const seed = Number(new URL(url).searchParams.get('seed'));
  const { layout } = playFixture(seed);
  const game = await openWideGame(page, url, layout);
  const board = page.locator('#board canvas');
  const hover = page.locator('#hover-cell');
  const phase = page.locator('#round-state');
  const playerHp = page.locator('#player-hp');
  const wave = page.locator('#round-wave');
  const target = { col: 25, row: 93 };
  assert.equal(layout[target.row][target.col], '+');

  await game.walkVia({ col: 21, row: 92 }, { col: 21, row: 94 }, { col: 25, row: 94 });
  await advanceUntil(page, async () => (await wave.textContent()) === '2'
    && (await phase.getAttribute('data-phase')) === 'attacking', 8_000, 'The second real enemy wave did not start');
  assert.equal(await playerHp.textContent(), '1', 'The first real wave must leave one player HP');
  // The first enemy traverses four cells before its contact. Start the hold late
  // enough for the lethal hit to interrupt it while the dirt still has HP.
  await page.clock.runFor(320);
  await game.inspect(target, 'HP 5/5');
  await page.mouse.down({ button: 'left' });
  try {
    await page.clock.runFor(STEP_MS);
    const before = await amberEdges(board, await game.view(), target);
    assert.ok(before?.top >= 5, 'A real hold must show amber before the enemy contact');
    await advanceUntil(page, async () => (await phase.getAttribute('data-phase')) === 'lost',
      900, 'A real enemy contact did not end the round');
    const after = await amberEdges(board, await game.view(), target);
    assert.equal(after?.total, 0, 'The loss state must hide amber even while the mouse stays held');
    const pausedTile = await hover.textContent();
    assert.match(pausedTile, /HP [1-4]\/5/, 'The lethal contact must interrupt an uncleared tile');
    await page.clock.runFor(6 * MINING_CONFIG.attackIntervalMs);
    assert.equal(await hover.textContent(), pausedTile, 'A held mouse must not damage the tile after loss');
  } finally {
    await page.mouse.up({ button: 'left' });
  }
}

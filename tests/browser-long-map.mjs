import assert from 'node:assert/strict';
import { LONG_MAP_LAYOUT } from '../src/long-map.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { TILE_SIZE } from '../src/player.ts';
import { TerrainMap } from '../src/terrain.ts';

const map = new TerrainMap(LONG_MAP_LAYOUT);
const viewWidth = 24 * TILE_SIZE;
const viewHeight = 32 * TILE_SIZE;
const southClamp = map.rows * TILE_SIZE - viewHeight;
const coordinates = ({ col, row }) => `(${col}, ${row})`;

export async function runLongMapSmoke(page, url) {
  const board = page.locator('#board canvas');
  const { col, row: spawnRow } = map.spawn;
  const routeTile = (row) => ({ col, row });
  const sideTarget = { col: col - 1, row: spawnRow };
  const untouched = { col: col + 1, row: spawnRow };
  const firstObstacle = routeTile(91);
  const southernSeam = routeTile(63);
  const northernSeam = routeTile(31);
  const { dirtMaxHp, attackIntervalMs } = MINING_CONFIG;
  const fullHp = `HP ${dirtMaxHp}/${dirtMaxHp}`;

  async function snapshot() {
    const state = await page.evaluate(() => {
      const visible = document.querySelector('#visible-chunks');
      return {
        position: document.querySelector('#player-cell').textContent,
        currentChunk: document.querySelector('#chunk-status').textContent,
        visibleChunks: visible.textContent,
        count: Number.parseInt(visible.dataset.count, 10),
        top: Number.parseFloat(visible.dataset.worldTop),
      };
    });
    const match = state.position.match(/^\((\d+),\s*(\d+)\)$/);
    assert.ok(match && Number(match[1]) === col, `Unexpected player world position ${state.position}`);
    assert.ok(state.count === 1 || state.count === 2, `Unexpected visible chunk count ${state.count}`);
    assert.ok(state.top >= 0 && state.top <= southClamp, `Camera moved past world bounds: ${state.top}`);
    return { ...state, row: Number(match[2]) };
  }

  function assertChunks(state, current, shown) {
    assert.equal(state.currentChunk, coordinates({ col: 0, row: current }));
    assert.equal(state.count, shown.length);
    for (const row of shown) assert.ok(state.visibleChunks.includes(coordinates({ col: 0, row })));
  }

  async function holdKey(key, action) {
    await page.keyboard.down(key);
    try {
      await action();
    } finally {
      await page.keyboard.up(key);
    }
  }

  async function travelTo(targetRow) {
    let state = await snapshot();
    const initialDistance = Math.abs(targetRow - state.row);
    if (initialDistance === 0) return state;
    const stepLimit = (initialDistance + 1) * 10;
    let stalledSteps = 0;
    await holdKey(targetRow < state.row ? 'KeyW' : 'KeyS', async () => {
      for (let step = 0; state.row !== targetRow && step < stepLimit; step += 1) {
        const remaining = Math.abs(targetRow - state.row);
        // Approach the destination with short advances so the player stays in the requested row.
        await page.clock.runFor(Math.max(48, Math.min((remaining - 1) * 125, 1_400)));
        const next = await snapshot();
        assert.ok(Math.sign(targetRow - next.row) === Math.sign(targetRow - state.row) || next.row === targetRow,
          `Player passed destination row ${targetRow}`);
        stalledSteps = next.row === state.row ? stalledSteps + 1 : 0;
        assert.ok(stalledSteps < 8, `Player stalled at row ${state.row} on the way to ${targetRow}`);
        state = next;
      }
    });
    assert.equal(state.row, targetRow, 'WASD must reach the requested world row');
    return state;
  }

  async function inspect(cell, terrain, hp) {
    const { top } = await snapshot();
    const box = await board.boundingBox();
    const x = (cell.col + 0.5) * TILE_SIZE;
    const y = (cell.row + 0.5) * TILE_SIZE - top;
    assert.ok(box && y >= 0 && y < viewHeight, `Target ${coordinates(cell)} must be within the camera view`);
    await page.mouse.move(box.x + x * box.width / viewWidth, box.y + y * box.height / viewHeight);
    const hover = await page.locator('#hover-cell').textContent();
    const expected = [terrain, coordinates(cell)];
    if (hp) expected.push(hp);
    for (const detail of expected) assert.ok(hover.includes(detail), `Expected ${detail} while hovering, saw ${hover}`);
  }

  async function tilePixel(cell) {
    await page.clock.runFor(32);
    const { top } = await snapshot();
    return board.evaluate((canvas, { x, y }) => Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data), {
      x: Math.floor((cell.col + 0.75) * TILE_SIZE),
      y: Math.floor((cell.row + 0.35) * TILE_SIZE - top),
    });
  }

  async function mine(cell, hp = 0) {
    await inspect(cell, '可挖地形', fullHp);
    await page.mouse.down({ button: 'left' });
    try {
      const intervals = hp === 0 ? dirtMaxHp : dirtMaxHp - hp - 1;
      await page.clock.runFor(intervals * attackIntervalMs + 64);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
    await inspect(cell, hp === 0 ? '空地' : '可挖地形', hp === 0 ? undefined : `HP ${hp}/${dirtMaxHp}`);
    const result = await page.locator('#dig-result').textContent();
    assert.ok(result.includes(coordinates(cell)) && result.includes(hp === 0 ? '挖掘成功' : '命中'),
      `Mining must report damage at the intended world tile, saw ${result}`);
  }

  await page.clock.install();
  assert.equal((await page.goto(url))?.status(), 200);
  await board.waitFor();
  await page.waitForFunction(() => Number(document.querySelector('#visible-chunks')?.dataset.count) > 0);
  assert.match(await page.locator('#map-size').textContent(), /24 × 96/);
  assert.deepEqual(await board.evaluate((canvas) => [canvas.width, canvas.height]), [viewWidth, viewHeight]);
  assert.notEqual((await board.boundingBox())?.width, viewWidth, 'World input must be tested with a CSS-scaled canvas');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));

  const initial = await snapshot();
  assert.equal(initial.row, spawnRow);
  assert.equal(initial.top, southClamp);
  assertChunks(initial, 2, [2]);
  await inspect(sideTarget, '可挖地形', fullHp);
  const intactPixel = await tilePixel(sideTarget);
  await mine(sideTarget, 2);
  const damagedPixel = await tilePixel(sideTarget);
  assert.notDeepEqual(damagedPixel, intactPixel, 'Partial damage must be visible on the canvas');
  await mine(firstObstacle);

  const beforeSouthSeam = await travelTo(64);
  assert.ok(beforeSouthSeam.top < initial.top, 'Camera must follow the player north');
  assertChunks(beforeSouthSeam, 2, [1, 2]);
  await holdKey('KeyW', () => page.clock.runFor(600));
  assert.equal((await snapshot()).row, 64, 'Dirt across the seam must block movement before mining');
  await mine(southernSeam);
  assertChunks(await travelTo(63), 1, [1, 2]);
  assertChunks(await travelTo(44), 1, [0, 1]);

  assertChunks(await travelTo(spawnRow), 2, [2]);
  await inspect(sideTarget, '可挖地形', `HP 2/${dirtMaxHp}`);
  assert.deepEqual(await tilePixel(sideTarget), damagedPixel, 'The returning chunk must redraw the saved HP');
  await inspect(untouched, '可挖地形', fullHp);
  await inspect(firstObstacle, '空地');
  await travelTo(91);
  await travelTo(64);
  await inspect(southernSeam, '空地');

  assertChunks(await travelTo(32), 1, [0, 1]);
  await mine(northernSeam);
  assertChunks(await travelTo(31), 0, [0, 1]);
  const atGoal = await travelTo(4);
  assert.equal(atGoal.top, 0);
  assertChunks(atGoal, 0, [0]);
  assert.match(await page.locator('#goal-status').textContent(), /P0-A 测试完成/);

  await holdKey('KeyR', () => page.clock.runFor(48));
  const reset = await snapshot();
  assert.equal(reset.row, spawnRow);
  assert.equal(reset.top, southClamp);
  assertChunks(reset, 2, [2]);
  assert.doesNotMatch(await page.locator('#goal-status').textContent(), /P0-A 测试完成/);
  await inspect(sideTarget, '可挖地形', fullHp);
  assert.deepEqual(await tilePixel(sideTarget), intactPixel, 'R must redraw the original southern terrain');
  await mine(firstObstacle);
  await travelTo(64);
  await mine(southernSeam);
  await travelTo(32);
  await inspect(northernSeam, '可挖地形', fullHp);
}

import assert from 'node:assert/strict';
import { GENERATED_ENEMY_ENTRY, GENERATED_GOAL, GENERATED_SPAWN, generateExpeditionMap } from '../src/generated-map.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { TILE_SIZE } from '../src/player.ts';

const seed = 12;
const layout = generateExpeditionMap(seed);
const worldWidth = 40 * TILE_SIZE;
const worldHeight = 96 * TILE_SIZE;
const expectedViewWidth = 18 * TILE_SIZE;
const epsilon = 1;
const { dirtMaxHp, attackIntervalMs } = MINING_CONFIG;
const coordinates = ({ col, row }) => `(${col}, ${row})`;
const centerLane = (row) => ({ col: GENERATED_SPAWN.col, row });

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, saw ${actual}`);
}

function assertSameColor(actual, expected, message) {
  assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 3),
    `${message}: expected ${expected}, saw ${actual}`);
}

async function openWideGame(page, url) {
  const board = page.getByRole('region', { name: '格子地图' }).locator('canvas');
  const playerCell = page.locator('#player-cell');
  const viewport = page.locator('#visible-chunks');
  const hover = page.locator('#hover-cell');

  async function view() {
    const state = await viewport.evaluate((element) => ({
      left: Number.parseFloat(element.dataset.worldLeft),
      top: Number.parseFloat(element.dataset.worldTop),
      width: Number.parseFloat(element.dataset.worldWidth),
      height: Number.parseFloat(element.dataset.worldHeight),
    }));
    near(state.width, expectedViewWidth, 'Wide camera must show 18 columns');
    assert.ok(state.left >= -epsilon && state.left + state.width <= worldWidth + epsilon,
      `Camera exceeded horizontal world bounds: ${JSON.stringify(state)}`);
    assert.ok(state.height > 0 && state.top >= -epsilon && state.top + state.height <= worldHeight + epsilon,
      `Camera exceeded vertical world bounds: ${JSON.stringify(state)}`);
    return state;
  }

  async function position() {
    const label = await playerCell.textContent();
    const match = label.match(/^\((\d+),\s*(\d+)\)$/);
    assert.ok(match, `Expected world coordinates, saw ${label}`);
    return { col: Number(match[1]), row: Number(match[2]) };
  }

  async function holdKey(key, action) {
    await page.keyboard.down(key);
    try {
      await action();
    } finally {
      await page.keyboard.up(key);
    }
  }

  async function walkTo(target, center = false) {
    let current = await position();
    if (current.col === target.col && current.row === target.row) return;
    const axis = current.col === target.col ? 'row' : 'col';
    const other = axis === 'col' ? 'row' : 'col';
    assert.equal(current[other], target[other], 'Smoke navigation must advance along one straight axis');
    const direction = Math.sign(target[axis] - current[axis]);
    const key = axis === 'row' ? (direction < 0 ? 'KeyW' : 'KeyS') : (direction < 0 ? 'KeyA' : 'KeyD');
    let stalls = 0;
    await holdKey(key, async () => {
      while (current[axis] !== target[axis]) {
        const remaining = Math.abs(target[axis] - current[axis]);
        await page.clock.runFor(Math.max(48, Math.min((remaining - 1) * 125, 1_400)));
        const next = await position();
        stalls = next[axis] === current[axis] ? stalls + 1 : 0;
        assert.ok(stalls < 8, `Player stalled at ${coordinates(current)} going to ${coordinates(target)}`);
        assert.ok((target[axis] - next[axis]) * direction >= 0, `Player passed ${coordinates(target)}`);
        assert.ok((next[axis] - current[axis]) * direction >= 0, `Player moved the wrong way for ${key}`);
        current = next;
      }
      // At a turn, move the body far enough into the cell to clear the preceding cell's side walls.
      if (center) await page.clock.runFor(80);
    });
    assert.deepEqual(await position(), target);
  }

  async function inspect(cell, ...details) {
    const camera = await view();
    const bounds = await board.boundingBox();
    const x = (cell.col + 0.5) * TILE_SIZE - camera.left;
    const y = (cell.row + 0.5) * TILE_SIZE - camera.top;
    assert.ok(bounds && x >= 0 && y >= 0 && x < camera.width && y < camera.height,
      `Tile ${coordinates(cell)} must be inside the camera view`);
    await page.mouse.move(bounds.x + x * bounds.width / camera.width, bounds.y + y * bounds.height / camera.height);
    const label = await hover.textContent();
    for (const expected of [coordinates(cell), ...details]) {
      assert.ok(label.includes(expected), `Expected ${expected} while hovering, saw ${label}`);
    }
  }

  async function tilePixel(cell) {
    await page.clock.runFor(32);
    const camera = await view();
    return board.evaluate((canvas, { x, y }) => Array.from(canvas.getContext('2d').getImageData(
      Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data), {
      x: ((cell.col + 0.5) * TILE_SIZE - camera.left) / camera.width,
      y: ((cell.row + 0.5) * TILE_SIZE - camera.top) / camera.height,
    });
  }

  async function dig(cell) {
    await inspect(cell, '可挖地形');
    await page.mouse.down({ button: 'left' });
    try {
      await page.clock.runFor(dirtMaxHp * attackIntervalMs + 64);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
    await inspect(cell, '空地');
    const result = await page.locator('#dig-result').textContent();
    assert.ok(result.includes('挖掘成功') && result.includes(coordinates(cell)), result);
  }

  async function openLineTo(target, center = false) {
    const start = await position();
    const axis = start.col === target.col ? 'row' : 'col';
    const other = axis === 'col' ? 'row' : 'col';
    assert.equal(start[other], target[other]);
    const direction = Math.sign(target[axis] - start[axis]);
    for (let value = start[axis] + direction; direction !== 0 && (target[axis] - value) * direction >= 0; value += direction) {
      const cell = { ...start, [axis]: value };
      const marker = layout[cell.row][cell.col];
      assert.notEqual(marker, '#', `Seed ${seed} must offer a diggable line through ${coordinates(cell)}`);
      if (marker === '+') {
        await walkTo({ ...cell, [axis]: value - direction });
        await dig(cell);
      }
    }
    await walkTo(target, center);
  }

  async function settleView() {
    await page.clock.runFor(480);
    return view();
  }

  await page.clock.install();
  assert.equal((await page.goto(url))?.status(), 200);
  await board.waitFor();
  await page.waitForFunction(() => Number(document.querySelector('#visible-chunks')?.dataset.worldWidth) > 0);
  assert.match(await page.locator('#map-size').textContent(), /40 × 96 · 种子 12/);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  assert.deepEqual(await position(), GENERATED_SPAWN);
  return { view, position, holdKey, walkTo, openLineTo, inspect, tilePixel, settleView };
}

export async function runFix02MapSmoke(page, url) {
  const game = await openWideGame(page, url);
  const initial = await game.view();
  near(initial.top + initial.height, worldHeight, 'The starting camera must clamp to the bottom');
  assert.ok(await page.locator('#defense-panel').isHidden());
  if (process.env.FIX02_SCREENSHOT) await page.screenshot({ path: process.env.FIX02_SCREENSHOT, fullPage: true });

  const lockOrigin = { col: 21, row: 92 };
  const locked = { col: 22, row: 92 };
  const alternate = { col: 21, row: 93 };
  await game.walkTo(lockOrigin, true);
  const beforeResize = await game.settleView();
  assert.ok(beforeResize.left > initial.left + TILE_SIZE, 'Camera must follow horizontal movement');
  await game.inspect(locked, '可挖地形', `HP ${dirtMaxHp}/${dirtMaxHp}`);
  await page.mouse.down({ button: 'left' });
  try {
    await page.clock.runFor(48);
    await game.inspect(locked, `HP ${dirtMaxHp - 1}/${dirtMaxHp}`);
    await game.inspect(alternate, '可挖地形', `HP ${dirtMaxHp}/${dirtMaxHp}`);
    await page.setViewportSize({ width: 1280, height: 1060 });
    await page.clock.runFor(128);
    const resized = await game.view();
    assert.ok(Math.abs(resized.height - beforeResize.height) > TILE_SIZE,
      `Resizing must change visible height, saw ${beforeResize.height} → ${resized.height}`);
    assert.ok(Math.abs(resized.top - beforeResize.top) > TILE_SIZE, 'Resizing at the bottom must also reposition the camera');
    await game.inspect(alternate, '可挖地形', `HP ${dirtMaxHp}/${dirtMaxHp}`);
    await page.clock.runFor(192);
  } finally {
    await page.mouse.up({ button: 'left' });
  }
  await game.inspect(locked, `HP ${dirtMaxHp - 2}/${dirtMaxHp}`);
  await game.inspect(alternate, `HP ${dirtMaxHp}/${dirtMaxHp}`);

  await game.walkTo(GENERATED_SPAWN, true);
  await game.walkTo(centerLane(88), true);
  await game.openLineTo({ col: 32, row: 88 });
  const east = await game.settleView();
  near(east.left + east.width, worldWidth, 'The east camera edge must clamp to the map');
  await game.walkTo(centerLane(88));
  await game.openLineTo({ col: 8, row: 88 });
  const west = await game.settleView();
  near(west.left, 0, 'The west camera edge must clamp to the map');
  await game.walkTo(centerLane(88), true);
  await game.openLineTo(centerLane(64));
  await game.inspect(centerLane(63), '可挖地形');
  await game.holdKey('KeyW', () => page.clock.runFor(500));
  assert.deepEqual(await game.position(), centerLane(64), 'An intact seam must remain solid');
  await game.openLineTo(centerLane(63));
  assert.match(await page.locator('#chunk-status').textContent(), /, 1\)$/);
  await game.openLineTo(centerLane(31));
  assert.match(await page.locator('#chunk-status').textContent(), /, 0\)$/);
  await game.openLineTo(GENERATED_GOAL);
  near((await game.settleView()).top, 0, 'The north camera edge must clamp to the map');
  assert.match(await page.locator('#goal-status').textContent(), /测试完成/);

  await game.walkTo(centerLane(62));
  await game.inspect(centerLane(63), '空地');
  await game.walkTo(GENERATED_SPAWN);
  await game.inspect(locked, '可挖地形', `HP ${dirtMaxHp - 2}/${dirtMaxHp}`);
  await game.holdKey('KeyR', () => page.clock.runFor(48));
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
  const reset = await game.view();
  near(reset.top + reset.height, worldHeight, 'The reset camera must return to the bottom');
  await game.inspect(locked, '可挖地形', `HP ${dirtMaxHp}/${dirtMaxHp}`);
  assert.doesNotMatch(await page.locator('#goal-status').textContent(), /测试完成/);
}

export async function runFix02DefenseSmoke(page, url) {
  const game = await openWideGame(page, url);
  const spawner = page.getByRole('button', { name: '南端生成' });
  const defenseHover = page.locator('#defense-hover');
  const readout = page.locator('#defense-stats');
  const tower = { col: 31, row: 94 };
  assert.ok(await spawner.isVisible());
  const initial = await game.view();
  await game.openLineTo({ col: 28, row: 92 });
  const moved = await game.settleView();
  assert.ok(moved.left >= initial.left + 6 * TILE_SIZE, 'Defense must pan toward the fixed eastern spawn');

  const background = await game.tilePixel(GENERATED_ENEMY_ENTRY);
  await page.locator('#spawn-count').selectOption('1');
  await spawner.click();
  await page.clock.runFor(64);
  const enemy = await game.tilePixel(GENERATED_ENEMY_ENTRY);
  assert.notDeepEqual(enemy, background, 'The enemy must draw at the projected eastern spawn');
  assert.equal(await readout.getAttribute('data-active'), '1');
  assert.equal(await readout.getAttribute('data-visible'), '1');
  assert.equal(await readout.getAttribute('data-north-row'), String(GENERATED_ENEMY_ENTRY.row));

  await game.inspect(tower, '空地');
  const emptyTower = await game.tilePixel(tower);
  await game.holdKey('KeyT', () => page.clock.runFor(48));
  assert.match(await defenseHover.textContent(), /测试塔 \(31, 94\)/);
  const placedTower = await game.tilePixel(tower);
  assert.notDeepEqual(placedTower, emptyTower, 'The tower must draw at the hovered world cell');
  assert.equal(await readout.getAttribute('data-shots'), '1');
  assert.equal(await readout.getAttribute('data-tower-kills'), '1');
  assert.equal(await readout.getAttribute('data-active'), '0');
  if (process.env.FIX02_DEFENSE_SCREENSHOT) await page.screenshot({ path: process.env.FIX02_DEFENSE_SCREENSHOT, fullPage: true });

  await page.clock.runFor(160);
  assertSameColor(await game.tilePixel(GENERATED_ENEMY_ENTRY), background, 'Tower kill must remove the aligned enemy drawing');
  const idleTower = await game.tilePixel(tower);
  await page.setViewportSize({ width: 1280, height: 1080 });
  const resized = await game.settleView();
  assert.ok(Math.abs(resized.height - moved.height) > TILE_SIZE, 'Defense view height must also respond to resize');
  await game.inspect(tower, '空地');
  await page.clock.runFor(32);
  assert.match(await defenseHover.textContent(), /测试塔 \(31, 94\)/);
  assertSameColor(await game.tilePixel(tower), idleTower, 'Resized camera must keep the tower on its world cell');
  await game.holdKey('KeyX', () => page.clock.runFor(48));
  assert.doesNotMatch(await defenseHover.textContent(), /测试塔/);
}

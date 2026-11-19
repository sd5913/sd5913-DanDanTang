import assert from 'node:assert/strict';
import { DEFENSE_CONFIG } from '../src/defense-simulation.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { TILE_SIZE } from '../src/player.ts';

const middle = (row) => ({ col: 11, row });
const spawn = middle(92);
const entry = middle(89);
const wall = middle(87);
const alternate = { col: 12, row: 87 };
const tower = { col: 12, row: 90 };
const viewWidth = 24 * TILE_SIZE;
const viewHeight = 32 * TILE_SIZE;
const coordinates = ({ col, row }) => `(${col}, ${row})`;

export async function runDefenseSmoke(page, url) {
  const board = page.locator('#board canvas');
  const countSelect = page.locator('#spawn-count');
  const damageSelect = page.locator('#spawn-damage');
  const spawner = page.locator('#spawn-enemies');
  const stat = page.locator('#defense-stats');
  const defenseHover = page.locator('#defense-hover');
  const { spawnIntervalMs } = DEFENSE_CONFIG;

  async function stats() {
    const state = await stat.evaluate((element) => Object.fromEntries(
      Object.entries(element.dataset).map(([name, value]) => [name, Number(value)])));
    assert.equal(state.requested, state.spawned + state.pending, 'Every requested enemy must be queued or spawned');
    assert.equal(state.spawned, state.active + state.removed, 'Every spawned enemy must be live or removed');
    assert.ok(state.visible >= 0 && state.visible <= state.active, 'Visible enemies must be a subset of live enemies');
    return state;
  }

  async function until(message, condition, budgetMs = 12_000, stepMs = 64) {
    let state = await stats();
    for (let elapsed = 0; elapsed < budgetMs && !condition(state); elapsed += stepMs) {
      await page.clock.runFor(stepMs);
      state = await stats();
    }
    assert.ok(condition(state), `${message}. Statistics: ${JSON.stringify(state)}`);
    return state;
  }

  function assertStats(state, expected) {
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(state[field], value, `Unexpected defense metric ${field}`);
    }
  }

  async function position() {
    const label = await page.locator('#player-cell').textContent();
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

  async function press(key) {
    await holdKey(key, () => page.clock.runFor(48));
  }

  async function travelTo(target) {
    let current = await position();
    if (coordinates(current) === coordinates(target)) return;
    const axis = current.col === target.col ? 'row' : 'col';
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
    });
    assert.deepEqual(current, target);
  }

  async function worldTop() {
    const value = await page.locator('#visible-chunks').getAttribute('data-world-top');
    const y = Number.parseFloat(value);
    assert.ok(Number.isFinite(y), `Expected camera world top, saw ${value}`);
    return y;
  }

  async function aimAt(cell) {
    await board.scrollIntoViewIfNeeded();
    const box = await board.boundingBox();
    const x = (cell.col + 0.5) * TILE_SIZE;
    const y = (cell.row + 0.5) * TILE_SIZE - await worldTop();
    assert.ok(box && y >= 0 && y < viewHeight, `Expected visible tile ${coordinates(cell)}`);
    await page.mouse.move(box.x + x * box.width / viewWidth, box.y + y * box.height / viewHeight);
    const hover = await page.locator('#hover-cell').textContent();
    assert.ok(hover.includes(coordinates(cell)), `Unexpected hover for ${coordinates(cell)}: ${hover}`);
    return hover;
  }

  async function tilePixels(cell) {
    await page.clock.runFor(32);
    return board.evaluate((canvas, { x, y, size }) =>
      Array.from(canvas.getContext('2d').getImageData(x, y, size, size).data), {
      x: cell.col * TILE_SIZE,
      y: Math.floor(cell.row * TILE_SIZE - await worldTop()),
      size: TILE_SIZE,
    });
  }

  function assertPixelsChanged(before, after, message) {
    assert.ok(before.some((channel, index) => channel !== after[index]), message);
  }

  async function mine(cell) {
    assert.match(await aimAt(cell), /可挖地形/);
    await page.mouse.down({ button: 'left' });
    try {
      await page.clock.runFor(MINING_CONFIG.dirtMaxHp * MINING_CONFIG.attackIntervalMs + 64);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
    assert.match(await aimAt(cell), /空地/);
    const result = await page.locator('#dig-result').textContent();
    assert.ok(result.includes('挖掘成功') && result.includes(coordinates(cell)), result);
  }

  async function openEntry() {
    await travelTo(middle(90));
    await mine(entry);
  }

  async function placeWall() {
    await travelTo(middle(88));
    assert.match(await aimAt(wall), /空地/);
    const empty = await tilePixels(wall);
    await press('KeyB');
    await expectWallHp(50);
    assertPixelsChanged(empty, await tilePixels(wall), 'A placed wall must be drawn on the targeted tile');
    await holdKey('KeyW', () => page.clock.runFor(500));
    assert.deepEqual(await position(), middle(88), 'The wall must block player movement');
    return empty;
  }

  async function expectWallHp(hp) {
    await aimAt(wall);
    await page.clock.runFor(32);
    assert.equal(await defenseHover.textContent(), `城墙 ${coordinates(wall)} · ${hp} HP`);
  }

  async function addEnemies(count, damage = 5) {
    await countSelect.selectOption(String(count));
    await damageSelect.selectOption(String(damage));
    await spawner.click();
    await page.clock.runFor(32);
  }

  async function assertVisibleCounters(state) {
    assert.ok(await stat.isVisible());
    const summary = await stat.textContent();
    for (const [label, field] of [
      ['请求', 'requested'], ['已生成', 'spawned'], ['待生成', 'pending'],
      ['存活', 'active'], ['可见', 'visible'], ['已移除', 'removed'],
    ]) {
      assert.match(summary, new RegExp(`${label} ${state[field]}(?=\\s*·|$)`));
    }
  }

  async function awaitDrain(count) {
    return until(`All ${count} requests must eventually spawn`,
      (state) => state.pending === 0 && state.spawned === count,
      count * (spawnIntervalMs + 60) + 7_000, 512);
  }

  async function spawnLanePixels() {
    await page.clock.runFor(32);
    const y = Math.floor(91 * TILE_SIZE - await worldTop());
    assert.ok(y >= 0 && y + 4 * TILE_SIZE <= viewHeight, 'Spawn lane must be visible for drawing checks');
    return board.evaluate((canvas, { x, y, width, height }) => Array.from(
      canvas.getContext('2d').getImageData(x, y, width, height).data), {
      x: spawn.col * TILE_SIZE, y, width: TILE_SIZE, height: 4 * TILE_SIZE,
    });
  }

  function separatedDrawings(before, after) {
    const stride = TILE_SIZE * 4;
    let bands = 0;
    let previousRowChanged = false;
    for (let start = 0; start < after.length; start += stride) {
      const nextRowChanged = before.slice(start, start + stride)
        .some((channel, offset) => channel !== after[start + offset]);
      if (nextRowChanged && !previousRowChanged) bands += 1;
      previousRowChanged = nextRowChanged;
    }
    return bands;
  }

  async function reset() {
    await press('KeyR');
    assert.deepEqual(await position(), spawn);
    assertStats(await stats(), {
      requested: 0, spawned: 0, pending: 0, removed: 0, visible: 0,
      active: 0, wallImpacts: 0, wallsDestroyed: 0, towerKills: 0, shots: 0,
    });
  }

  await page.clock.install();
  assert.equal((await page.goto(url))?.status(), 200);
  await board.waitFor();
  await page.waitForFunction(() => Number(document.querySelector('#visible-chunks')?.dataset.count) > 0);
  await spawner.waitFor();
  const values = (select) => select.evaluate((element) => Array.from(element.options, (option) => Number(option.value)));
  assert.deepEqual(await values(countSelect), [1, 4, 10, 50, 100, 250]);
  assert.deepEqual(await values(damageSelect), [1, 2, 5]);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  assert.deepEqual(await position(), spawn);

  await addEnemies(1);
  const blocked = await until('The sealed entry must be detected as unreachable', (state) => state.unreachable > 0);
  assertStats(blocked, { requested: 1, spawned: 1, pending: 0, removed: 0, active: 1, visible: 1, northRow: 94, wallImpacts: 0 });
  await assertVisibleCounters(blocked);
  await page.clock.runFor(1_000);
  assertStats(await stats(), { active: 1, northRow: 94, searches: blocked.searches });
  await openEntry();
  const recovered = await until('The existing enemy must use the mined entry', (state) => state.northRow <= 88);
  assert.equal(recovered.active, 1);
  assert.ok(recovered.searches > blocked.searches);

  await reset();
  await openEntry();
  await placeWall();
  await travelTo({ col: 12, row: 88 });
  await mine(alternate);
  await travelTo({ col: 10, row: 88 });
  await page.mouse.move(2, 2);
  const emptyAlternate = await tilePixels(alternate);
  await addEnemies(1);
  const detouring = await until('The enemy must enter the side route', (state) => state.northRow <= 87);
  assertStats(detouring, { active: 1, visible: 1, northRow: 87, wallImpacts: 0 });
  assertPixelsChanged(emptyAlternate, await tilePixels(alternate), 'The enemy must be drawn on the opened side route');
  const bypassed = await until('The enemy must pass the intact wall', (state) => state.northRow <= 86);
  assertStats(bypassed, { active: 1, wallImpacts: 0, wallsDestroyed: 0 });
  await expectWallHp(50);
  await press('KeyX');
  assert.doesNotMatch(await defenseHover.textContent(), /城墙/);

  await reset();
  await openEntry();
  const emptyWallTile = await placeWall();
  const fullWallPixels = await tilePixels(wall);
  await travelTo({ col: 10, row: 88 });
  await addEnemies(1);
  const impact = await until('One enemy must complete one wall impact', (state) => state.wallImpacts === 1);
  assertStats(impact, { requested: 1, spawned: 1, pending: 0, removed: 1, active: 0, wallImpacts: 1, wallsDestroyed: 0, towerKills: 0 });
  await expectWallHp(45);
  assertPixelsChanged(fullWallPixels, await tilePixels(wall), 'The wall must redraw its updated HP number');

  await addEnemies(10);
  const breach = await until('An enemy must survive the breach and cross the old wall',
    (state) => state.pending === 0 && state.wallsDestroyed === 1 && state.active === 1 && state.northRow <= 85);
  assertStats(breach, { requested: 11, spawned: 11, removed: 10, active: 1, wallImpacts: 10, wallsDestroyed: 1, towerKills: 0 });
  await aimAt(wall);
  await page.clock.runFor(32);
  assert.doesNotMatch(await defenseHover.textContent(), /城墙/);
  const restoredWallPixels = await tilePixels(wall);
  assert.ok(emptyWallTile.every((channel, index) => channel === restoredWallPixels[index]),
    'Destroying the wall must restore the original terrain drawing');

  await reset();
  assert.match(await aimAt(tower), /空地/);
  const emptyTowerTile = await tilePixels(tower);
  await press('KeyT');
  const towerHud = await defenseHover.textContent();
  assert.ok(towerHud.includes('塔') && towerHud.includes(coordinates(tower)), towerHud);
  assertPixelsChanged(emptyTowerTile, await tilePixels(tower), 'A placed tower must be drawn on the targeted tile');
  const shotTile = { col: tower.col, row: tower.row + 1 };
  const emptyShotTile = await tilePixels(shotTile);
  await addEnemies(1);
  const towerKill = await until('The tower must fire automatically and kill the enemy',
    (state) => state.shots > 0 && state.towerKills === 1);
  assertStats(towerKill, { requested: 1, spawned: 1, pending: 0, removed: 1, active: 0, towerKills: 1, wallImpacts: 0, wallsDestroyed: 0 });
  assertPixelsChanged(emptyShotTile, await tilePixels(shotTile), 'The automatic shot must be drawn on the canvas');
  await aimAt(tower);
  await press('KeyX');
  assert.doesNotMatch(await defenseHover.textContent(), /塔/);

  await reset();
  await openEntry();
  await travelTo(middle(44));
  assert.ok(await worldTop() + viewHeight <= 63 * TILE_SIZE, 'The seam and enemy spawn must be offscreen');
  await addEnemies(1);
  assertStats(await stats(), { active: 1, visible: 0, northRow: 94 });
  const offscreen = await until('The invisible enemy must cross the seam under simulation',
    (state) => state.northRow <= 63);
  assertStats(offscreen, { active: 1, visible: 0, removed: 0 });
  const appeared = await until('The same enemy must enter the viewport from the south', (state) => state.visible === 1);
  assertStats(appeared, { active: 1, visible: 1, wallImpacts: 0, towerKills: 0 });

  for (const count of [10, 50, 100]) {
    await reset();
    await openEntry();
    const clearLane = count === 10 ? await spawnLanePixels() : undefined;
    await addEnemies(count);
    const queued = await stats();
    assertStats(queued, { requested: count, pending: count - 1, spawned: 1, active: 1, visible: 1, removed: 0 });
    await assertVisibleCounters(queued);

    if (clearLane) {
      const released = await until('The queue must release a separated group', (state) => state.spawned >= 3);
      assert.ok(released.pending > 0 && released.visible >= 2);
      assert.ok(separatedDrawings(clearLane, await spawnLanePixels()) >= 2,
        'At least two enemies in the group must be drawn at distinct positions');
    }

    const drained = await awaitDrain(count);
    assertStats(drained, { requested: count, spawned: count, pending: 0, active: count, removed: 0 });
    await assertVisibleCounters(drained);
    if (count >= 50) {
      await aimAt(tower);
      await press('KeyT');
      const removing = await until('A real tower kill must update the live and removed counts', (state) => state.towerKills > 0);
      assertStats(removing, { requested: count, spawned: count, pending: 0, removed: removing.towerKills, wallImpacts: 0 });
      assertVisibleCounters(removing);
    }
  }

  await reset();
  await addEnemies(10);
  await page.clock.runFor(1_000);
  assertStats(await stats(), { requested: 10, spawned: 1, pending: 9, active: 1, removed: 0, northRow: 94 });
  await openEntry();
  const resumed = await awaitDrain(10);
  assertStats(resumed, { requested: 10, spawned: 10, pending: 0, active: 10, removed: 0 });

  await reset();
  await addEnemies(10);
  assertStats(await stats(), { pending: 9 });
  await reset();
  await page.clock.runFor(spawnIntervalMs * 3);
  const afterReset = await stats();
  assertStats(afterReset, { requested: 0, spawned: 0, pending: 0, active: 0, visible: 0, removed: 0 });
  await assertVisibleCounters(afterReset);
}

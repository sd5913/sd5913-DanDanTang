import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE } from '../src/expedition-economy.ts';
import { GENERATED_SPAWN } from '../src/generated-map.ts';
import { TILE_SIZE } from '../src/player.ts';
import { readCardInventory } from './browser-card-feedback.mjs';
import { openWideGame, playFixture } from './browser-fix02.mjs';

const { layout } = playFixture();
const cell = (col, row) => ({ col, row });
const label = ({ col, row }) => `(${col}, ${row})`;
const reasons = {
  'out-of-range': /距离过远|周围一格/,
  'player-cell': /脚下|自身|玩家所在格/,
  terrain: /空地|地形|不能建造/,
  occupied: /已被占用|已有建筑|位置占用/,
  'out-of-stock': /没有.+卡|库存不足|卡牌不足|卡片不足|数量不足/,
};

async function openBuildScene(page, url) {
  const game = await openWideGame(page, url, layout);
  const preview = page.locator('#build-preview');
  const feedback = page.locator('#expedition-feedback');

  async function select(kind) {
    const button = page.locator(`#card-${kind}`);
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
  }

  async function aim(target, reason) {
    await game.inspect(target);
    await page.clock.runFor(32);
    assert.ok(await preview.isVisible());
    assert.equal(await preview.getAttribute('data-state'), reason ? 'invalid' : 'valid');
    assert.equal(await preview.getAttribute('data-reason'), reason ?? null);
    const text = await preview.textContent();
    assert.match(text, reason ? reasons[reason] : /可建造|可以建造/);
    return preview.evaluate((element) => getComputedStyle(element).color);
  }

  async function click() {
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await page.clock.runFor(32);
  }

  async function reject(target, reason) {
    const color = await aim(target, reason);
    const before = await readCardInventory(page);
    await click();
    assert.match(await feedback.textContent(), reasons[reason]);
    assert.deepEqual(await readCardInventory(page), before, 'An illegal placement must retain all cards');
    return color;
  }

  async function place(kind, target) {
    await select(kind);
    const color = await aim(target);
    const before = await readCardInventory(page);
    await click();
    assert.deepEqual(await readCardInventory(page), { ...before, [kind]: before[kind] - 1 });
    assert.match(await feedback.textContent(), /已建造|已合成/);
    return color;
  }

  async function buildingAt(target) {
    await game.inspect(target, '空地');
    await page.clock.runFor(32);
    return page.locator('#expedition-building').textContent();
  }

  async function reset() {
    await game.holdKey('KeyR', () => page.clock.runFor(48));
    assert.deepEqual(await game.position(), GENERATED_SPAWN);
    assert.deepEqual(await readCardInventory(page), ECONOMY_PROTOTYPE.initialCards);
    assert.ok(await preview.isHidden());
  }

  return { game, preview, feedback, select, aim, reject, place, buildingAt, reset };
}

export async function runBuildRangeSmoke(page, url) {
  const { game, preview, feedback, select, reject, place, buildingAt, reset } = await openBuildScene(page, url);
  assert.ok(await page.locator('#defense-panel').isHidden());
  assert.ok(await page.locator('#expedition-spawn').isHidden());
  assert.ok(await preview.isHidden());
  const startingView = await game.view();
  const diagonal = cell(21, 91);
  await game.inspect(diagonal, '空地');
  const unselectedPixel = await game.tilePixel(diagonal);
  await select('wall');
  const invalidColor = await reject(diagonal, 'out-of-range');
  assert.notDeepEqual(await game.tilePixel(diagonal), unselectedPixel, 'The rejected preview must tint its world tile');
  await reject(GENERATED_SPAWN, 'player-cell');
  const dirt = cell(19, 93);
  await reject(dirt, 'terrain');
  await game.inspect(dirt, '可挖地形', 'HP 5/5');

  await game.walkVia(cell(20, 92));
  const moved = await game.settleView();
  assert.ok(moved.left > startingView.left + TILE_SIZE / 3, 'The camera must pan before retrying the same world tile');
  await page.setViewportSize({ width: 1120, height: 820 });
  const resized = await game.settleView();
  assert.ok(Math.abs(resized.height - moved.height) > TILE_SIZE, 'The viewport must really resize during placement');
  const validColor = await place('wall', diagonal);
  assert.notEqual(validColor, invalidColor, 'The build preview must show two distinct visual cues');
  assert.match(await buildingAt(diagonal), /^城墙 \(21, 91\)/);
  await reject(diagonal, 'occupied');

  const cardinal = cell(20, 91);
  await place('economy', cardinal);
  assert.match(await buildingAt(cardinal), /^经济建筑 \(20, 91\)/);
  await select('economy');
  await reject(cell(19, 91), 'out-of-stock');

  await reset();
  await game.walkVia(cell(19, 88));
  await game.openLineTo(cell(1, 88), true);
  assert.ok(Math.abs((await game.settleView()).left) < 1, 'The camera must clamp at the western map edge');
  await select('wall');
  await reject(cell(3, 88), 'out-of-range');
  await place('wall', cell(2, 88));
  assert.match(await buildingAt(cell(2, 88)), /^城墙 \(2, 88\)/);

  await reset();
  const walls = [16, 17, 18, 19].map((col) => cell(col, 88));
  await game.walkVia(cell(19, 89), cell(17, 89));
  for (const wall of walls.slice(0, 3)) await place('wall', wall);
  await game.walkVia(cell(18, 89));
  await place('wall', walls[3]);
  assert.equal(await feedback.textContent(), `已合成城墙 Lv.2 ${label(walls[0])}`);
  assert.match(await buildingAt(walls[0]), /Lv\.2$/);
  for (const wall of walls.slice(1)) assert.equal(await buildingAt(wall), '—');
  await game.walkVia(cell(19, 89), walls[3]);

  await reset();
  await place('economy', cell(20, 91));
  await page.clock.runFor(2 * ECONOMY_PROTOTYPE.productionIntervalMs + 150);
  await page.locator('#research-tool').click();
  assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2');
  const beforeSeam = cell(19, 64);
  const afterSeam = cell(19, 63);
  await game.openLineTo(beforeSeam, true);
  assert.equal(await page.locator('#chunk-status').textContent(), '(0, 2)');
  await game.openLineTo(afterSeam, true);
  assert.equal(await page.locator('#chunk-status').textContent(), '(0, 1)');
  await place('wall', beforeSeam);
  assert.equal(await feedback.textContent(), '已建造城墙 (19, 64)');
  assert.match(await buildingAt(beforeSeam), /^城墙 \(19, 64\)/);
}

export async function runBuildDebugIsolationSmoke(page, url) {
  const { game, select, reject, buildingAt } = await openBuildScene(page, url);
  assert.ok(await page.locator('#expedition-spawn').isVisible());
  const remote = cell(21, 91);
  await select('wall');
  await reject(remote, 'out-of-range');
  await game.holdKey('KeyB', () => page.clock.runFor(48));
  await game.holdKey('KeyT', () => page.clock.runFor(48));
  assert.equal(await buildingAt(remote), '—');
  assert.deepEqual(await readCardInventory(page), ECONOMY_PROTOTYPE.initialCards);
}

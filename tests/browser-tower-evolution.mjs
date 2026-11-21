import assert from 'node:assert/strict';
import { CONTROL_TOWER_TUNING, evolvedTowerAttributes } from '../src/building-balance.ts';
import { PLAYTEST_PROFILE } from '../src/launch-config.ts';
import { GENERATED_SPAWN } from '../src/generated-map.ts';
import { TILE_SIZE } from '../src/player.ts';
import { piercingFallbackRange } from '../src/tower-attack.ts';
import { readCardInventory } from './browser-card-feedback.mjs';
import { advanceUntil, startFirstWave } from './browser-challenge.mjs';
import { fundFourTowerCards } from './browser-midgame-economy.mjs';

const cell = (col, row) => ({ col, row });
const label = ({ col, row }) => `(${col}, ${row})`;
const cases = {
  piercing: {
    name: 'Piercing Tower Lv.2', direction: '横向穿透',
    targets: [cell(22, 90), cell(23, 90), cell(24, 90), cell(25, 90)],
    builders: [cell(22, 91), cell(23, 91), cell(24, 91), cell(25, 91)],
    evolution: { kind: 'piercing', axis: 'horizontal' },
  },
  burst: {
    name: 'Burst Tower Lv.2', direction: '范围爆裂',
    targets: [cell(25, 92), cell(25, 91), cell(26, 91), cell(26, 92)],
    builders: [cell(24, 92), cell(24, 91), cell(27, 91), cell(27, 92)],
    evolution: { kind: 'burst' },
  },
};

async function tileInk(page, game, tile, color, tolerance) {
  const view = await game.view();
  return page.locator('#board canvas').evaluate((canvas, { view, tile, color, tolerance, size }) => {
    const left = (tile.col * size + 2 - view.left) * canvas.width / view.width;
    const top = (tile.row * size + 2 - view.top) * canvas.height / view.height;
    const width = Math.floor((size - 4) * canvas.width / view.width);
    const height = Math.floor((size - 4) * canvas.height / view.height);
    const pixels = canvas.getContext('2d').getImageData(Math.floor(left), Math.floor(top), width, height).data;
    let matches = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (color.every((value, channel) => Math.abs(value - pixels[index + channel]) <= tolerance)) matches += 1;
    }
    return matches;
  }, { view, tile, color, tolerance, size: TILE_SIZE });
}

async function readPathing(page) {
  return page.locator('#defense-stats').evaluate(({ dataset }) => ({
    active: Number(dataset.active), removed: Number(dataset.removed), searches: Number(dataset.searches),
    spawned: Number(dataset.spawned),
  }));
}

async function confirmManualEvolution(page, run, { kind, name, direction, retained, released, target, stance, moved, attack,
  checkRepath, readyOnly }) {
  const panel = page.locator('#merge-controls');
  const confirm = page.locator('#merge-confirm');
  const readyName = page.locator('#merge-name');
  const forecast = page.locator('#merge-tiles');
  const risk = page.locator('#merge-risk');
  const retainInk = [159, 247, 212];
  const releaseInk = [255, 216, 151];

  const retainBefore = await tileInk(page, run.game, retained, retainInk, 9);
  const releaseBefore = await Promise.all(released.map((tile) => tileInk(page, run.game, tile, releaseInk, 22)));
  await run.place('tower', target);
  await page.clock.runFor(32);
  assert.equal((await readCardInventory(page)).tower, 0);
  await page.clock.runFor(144);
  assert.equal(await readyName.textContent(), '可合成 · ' + name);
  assert.equal(await forecast.textContent(), '保留 ' + label(retained) + ' · 释放 ' + released.map(label).join('、'));
  assert.ok(await panel.isVisible());
  assert.ok(await confirm.isHidden(), 'Hovering shows the forecast but does not select the group');
  for (const tile of [retained, ...released]) {
    await run.game.inspect(tile, '空地');
    await page.clock.runFor(16);
    assert.match(await run.building.textContent(), /^防御塔 .*1 HP$/);
    assert.match(await page.locator('#expedition-building-stats').textContent(), /^Lv\.1/);
  }
  assert.ok(await tileInk(page, run.game, retained, retainInk, 9) > retainBefore + 4, 'The preview must highlight the retained tile');
  for (const [index, tile] of released.entries()) {
    assert.ok(await tileInk(page, run.game, tile, releaseInk, 22) > releaseBefore[index] + 4,
      'The preview must highlight the release tile ' + label(tile));
  }

  const unknown = cell(33, 81);
  await run.game.aimAt(unknown);
  await page.clock.runFor(32);
  assert.equal(await page.locator('#hover-cell').getAttribute('data-visibility'), 'unknown');
  assert.ok(await panel.isHidden());

  await page.setViewportSize({ width: 1120, height: 760 });
  const resized = await run.game.settleView();
  assert.ok(Math.abs(resized.height - moved.height) > TILE_SIZE);
  await run.game.inspect(target, '空地');
  await run.clickBoard();
  assert.equal(await readyName.textContent(), '可合成 · ' + name);
  assert.equal(await forecast.textContent(), '保留 ' + label(retained) + ' · 释放 ' + released.map(label).join('、'));
  assert.match(await risk.textContent(), /路线|通路/);
  const bounds = await panel.boundingBox();
  assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 760, 'The selected merge preview must fit at 1120x760');
  assert.ok(await confirm.isEnabled());
  if (readyOnly) return { ...run, retained, released, attack };

  if (kind === 'piercing' && !checkRepath) {
    await run.returnTo(GENERATED_SPAWN);
    await page.clock.runFor(48);
    assert.ok(await panel.isVisible(), 'Selection should persist while approaching or leaving');
    assert.ok(await confirm.isDisabled());
    assert.match(await page.locator('#merge-hint').textContent(), /靠近/);
    await run.returnTo(stance);
    await page.clock.runFor(48);
    assert.ok(await confirm.isEnabled());
  }

  let beforePath;
  if (checkRepath) {
    await startFirstWave(page, run.start, { publicBuild: true });
    await page.clock.runFor(16);
    beforePath = await readPathing(page);
    assert.equal(beforePath.active, 1);
    assert.equal(beforePath.removed, 0);
    assert.ok(beforePath.searches > 0);
    await page.clock.runFor(16);
    assert.deepEqual(await readPathing(page), beforePath, 'The four placed towers are stable before confirmation');
  }

  const paidBalance = await run.cash();
  const paidInventory = await readCardInventory(page);
  await confirm.click();
  await page.clock.runFor(16);
  const feedback = page.locator('#expedition-feedback');
  if ((await feedback.textContent()).includes('预览已更新')) {
    await confirm.click();
    await page.clock.runFor(16);
  }
  assert.equal(await feedback.textContent(), '已合成 ' + name + ' ' + label(retained) + ' · ' + direction);
  assert.ok(await panel.isHidden());
  if (!checkRepath) assert.equal(await run.cash(), paidBalance, 'The merge must not charge currency');
  assert.deepEqual(await readCardInventory(page), paidInventory, 'The merge must not charge another card');

  let afterPath;
  if (beforePath) {
    afterPath = await readPathing(page);
    for (let elapsed = 0; afterPath.searches <= beforePath.searches && elapsed < 150; elapsed += 16) {
      await page.clock.runFor(16);
      afterPath = await readPathing(page);
    }
    assert.equal(afterPath.active, beforePath.active);
    assert.equal(afterPath.removed, beforePath.removed);
    assert.equal(afterPath.spawned, beforePath.spawned);
    assert.ok(afterPath.searches > beforePath.searches, 'The same live enemy must invalidate and update its route');
  }

  await run.game.inspect(retained, '空地');
  await page.clock.runFor(16);
  assert.equal(await run.building.textContent(), name + ' ' + label(retained) + ' · 1 HP');
  const damage = attack.kind === 'piercing' ? '伤害 5 · 最多 4 个目标' : '主伤害 4 · 溅射 2 · 半径 ' + attack.radius + ' 格';
  const fallback = attack.kind === 'piercing'
    ? ' · 备用 ' + piercingFallbackRange(PLAYTEST_PROFILE.towerTuning) + ' 格 / 2 点（与主攻共用冷却）' : '';
  assert.equal(await page.locator('#expedition-building-stats').textContent(),
    direction + ' · ' + damage + ' · 射程 ' + attack.range + ' 格 · 间隔 ' + attack.intervalMs + ' ms' + fallback);
  for (const tile of released) {
    run.occupied.delete(label(tile));
    await run.game.inspect(tile, '空地');
    await page.clock.runFor(16);
    assert.equal(await run.building.textContent(), '—');
    assert.ok(await tileInk(page, run.game, tile, retainInk, 18) > 4, 'The released tile ' + label(tile) + ' must flash');
  }
  await run.returnTo(released[0]);
  assert.deepEqual(await run.game.position(), released[0], 'A tile must be walkable after confirmation');
  await run.returnTo(GENERATED_SPAWN);
  return { ...run, retained, released, attack, searches: afterPath ? [beforePath.searches, afterPath.searches] : undefined };
}

export async function preparePaidEvolvedTower(page, baseUrl, kind, { playtest = false, checkRepath = false, readyOnly = false } = {}) {
  const { name, direction, targets, builders, evolution } = cases[kind];
  const tuning = playtest ? PLAYTEST_PROFILE.towerTuning : CONTROL_TOWER_TUNING;
  const attack = evolvedTowerAttributes(evolution, 'ordinary', tuning);
  const [retained, ...released] = targets;
  const target = released.at(-1);
  const run = await fundFourTowerCards(page, baseUrl, 'combined', {
    playtestUrl: playtest ? '/' : '/?mode=play&difficulty=challenge&build=w25&midgame=combined&debug=1&evolution=1',
  });
  assert.deepEqual(await readCardInventory(page), { wall: 0, tower: 4, economy: 0 });

  await run.returnTo(builders[0]);
  const initial = await run.game.settleView();
  for (const [index, tile] of targets.slice(0, 3).entries()) {
    await run.returnTo(builders[index]);
    await run.place('tower', tile);
  }
  await run.returnTo(builders[3]);
  const moved = await run.game.settleView();
  assert.ok(moved.left > initial.left + TILE_SIZE, 'The camera must pan as the player approaches the fourth tile');
  if (playtest) return confirmManualEvolution(page, run, {
    kind, name, direction, retained, released, target, stance: builders[3], moved, attack, checkRepath, readyOnly,
  });

  const preview = page.locator('#build-preview');
  const previewText = `将合成 ${name} · ${direction} · 保留 ${label(retained)} · 释放 ${released.map(label).join('、')}`;
  const retainInk = [159, 247, 212];
  const releaseInk = [255, 216, 151];
  const retainBefore = await tileInk(page, run.game, retained, retainInk, 9);
  const releaseBefore = await Promise.all(released.map((tile) => tileInk(page, run.game, tile, releaseInk, 22)));
  await run.select('tower');
  await run.game.inspect(target, '空地');
  await page.clock.runFor(32);
  assert.equal(await preview.textContent(), previewText);
  assert.equal(await preview.getAttribute('data-state'), 'valid');
  assert.ok(await tileInk(page, run.game, retained, retainInk, 9) > retainBefore + 4, 'The retained world tile must visibly highlight');
  for (const [index, tile] of released.entries()) {
    assert.ok(await tileInk(page, run.game, tile, releaseInk, 22) > releaseBefore[index] + 4,
      `The released tile ${label(tile)} must display its amber cross`);
  }

  const unknown = cell(33, 81);
  await run.game.aimAt(unknown);
  await page.clock.runFor(32);
  assert.equal(await page.locator('#hover-cell').getAttribute('data-visibility'), 'unknown');
  assert.equal(await preview.getAttribute('data-state'), 'invalid');
  assert.doesNotMatch(await preview.textContent(), /Piercing Tower|Burst Tower|保留|释放/);
  await page.setViewportSize({ width: 1120, height: 760 });
  const resized = await run.game.settleView();
  assert.ok(Math.abs(resized.height - moved.height) > TILE_SIZE, 'The world projection must actually resize');
  await run.game.inspect(target, '空地');
  await page.clock.runFor(32);
  assert.equal(await preview.textContent(), previewText);
  const previewBounds = await preview.boundingBox();
  assert.ok(previewBounds && previewBounds.y >= 0 && previewBounds.y + previewBounds.height <= 760,
    'The whole forecast must fit on screen after the smaller resize');
  assert.ok(await tileInk(page, run.game, retained, retainInk, 9) > retainBefore + 4);

  let beforePath;
  if (checkRepath) {
    await page.locator('#expedition-spawn').click();
    await run.game.aimAt(target);
    await page.clock.runFor(64);
    beforePath = await readPathing(page);
    assert.equal(beforePath.active, 1);
    assert.equal(beforePath.removed, 0);
    assert.ok(beforePath.searches > 0);
    await page.clock.runFor(16);
    assert.deepEqual(await readPathing(page), beforePath, 'A stable world must reuse its path fields');
    assert.equal(await preview.textContent(), previewText);
  }

  await run.place('tower', target, { merge: true });
  assert.equal(await page.locator('#expedition-feedback').textContent(), `已合成 ${name} ${label(retained)} · ${direction}`);
  assert.equal(await page.locator('#card-tower').getAttribute('aria-pressed'), 'false');
  assert.ok(await preview.isHidden());
  assert.equal((await readCardInventory(page)).tower, 0);
  let afterPath;
  if (beforePath) {
    // An enemy already moving may finish its current tile before consulting the changed route field.
    afterPath = await readPathing(page);
    for (let elapsed = 0; afterPath.searches <= beforePath.searches && elapsed < 250; elapsed += 16) {
      await page.clock.runFor(16);
      afterPath = await readPathing(page);
    }
    assert.equal(afterPath.active, beforePath.active, 'The original enemy must remain active after the merge');
    assert.equal(afterPath.removed, beforePath.removed);
    assert.equal(afterPath.spawned, beforePath.spawned, 'The route search must occur before the next enemy enters');
    assert.ok(afterPath.searches > beforePath.searches, 'Released occupancy must invalidate enemy path fields');
  }

  await run.game.inspect(retained, '空地');
  await page.clock.runFor(32);
  assert.equal(await run.building.textContent(), `${name} ${label(retained)} · 1 HP`);
  const damage = attack.kind === 'piercing' ? `伤害 5 · 最多 4 个目标` : `主伤害 4 · 溅射 2 · 半径 ${attack.radius} 格`;
  assert.equal(await page.locator('#expedition-building-stats').textContent(),
    `${direction} · ${damage} · 射程 ${attack.range} 格 · 间隔 ${attack.intervalMs} ms`);
  for (const tile of released) {
    run.occupied.delete(label(tile));
    await run.game.inspect(tile, '空地');
    await page.clock.runFor(32);
    assert.equal(await run.building.textContent(), '—');
  }
  await run.returnTo(released[0]);
  assert.deepEqual(await run.game.position(), released[0], 'The released world tile must be walkable');
  await run.returnTo(GENERATED_SPAWN);
  return { ...run, retained, released, attack, searches: afterPath ? [beforePath.searches, afterPath.searches] : undefined };
}

export async function runEvolvedTowerCombatSmoke(page, baseUrl, kind) {
  const run = await preparePaidEvolvedTower(page, baseUrl, kind, { checkRepath: kind === 'piercing' });
  const effects = async () => JSON.parse(await page.locator('#defense-stats').getAttribute('data-tower-effects')
    ?? '{"piercing":0,"burst":0,"recent":[]}');
  await startFirstWave(page, run.start);
  let shots = (await effects()).recent.filter((shot) => shot.timeMs >= 60_000);
  for (let elapsed = 0; !shots.some((shot) => shot.enemyIds.length > 1) && elapsed < 8_000; elapsed += 64) {
    await page.clock.runFor(64);
    shots = (await effects()).recent.filter((shot) => shot.timeMs >= 60_000);
  }
  const groupShot = shots.find((shot) => shot.enemyIds.length > 1);
  assert.ok(groupShot, `${kind} must hit a group during a real wave: ${JSON.stringify(shots)}`);
  assert.equal(groupShot.effect.kind, kind);
  assert.deepEqual(groupShot.effect.from, { x: run.retained.col + 0.5, y: run.retained.row + 0.5 });
  assert.equal(new Set(groupShot.enemyIds).size, groupShot.enemyIds.length);
  if (kind === 'piercing') {
    assert.equal(groupShot.effect.to.y, groupShot.effect.from.y);
    assert.ok(groupShot.enemyIds.length <= 4);
    await advanceUntil(page, (round) => round.wave === 1 && round.phase === 'recovering',
      'The paid horizontal tower must clear the normal first wave', 8_000);
  } else {
    assert.equal(groupShot.effect.radius, CONTROL_TOWER_TUNING.burstRadius);
  }
  return { seed: 515, kind, retained: run.retained, released: run.released, searches: run.searches,
    groupedHitCount: groupShot.enemyIds.length, simulatedEventTimeMs: groupShot.timeMs };
}

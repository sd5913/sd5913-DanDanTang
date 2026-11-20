import assert from 'node:assert/strict';
import { ENEMY_RADIUS } from '../src/enemy-contact.ts';
import { PLAYER_HALF_SIZE } from '../src/player.ts';
import { openWideGame, playFixture } from './browser-fix02.mjs';

const player = { col: 14, row: 86 };
const facility = { col: 17, row: 90 };
const obstruction = { col: 14, row: 87 };

function readCombat(page) {
  return page.evaluate(() => {
    const stats = document.getElementById('defense-stats').dataset;
    const trace = document.getElementById('player-contact-trace').value;
    return {
      hp: Number(document.getElementById('player-hp').textContent),
      phase: document.getElementById('round-state').dataset.phase,
      spawned: Number(stats.spawned),
      active: Number(stats.active),
      removed: Number(stats.removed),
      northRow: Number(stats.northRow),
      buildingContacts: Number(stats.buildingContacts),
      playerContacts: Number(stats.playerContacts),
      unreachable: Number(stats.unreachable),
      feedback: document.getElementById('expedition-feedback').textContent,
      trace: trace ? JSON.parse(trace) : [],
    };
  });
}

async function waitForCombat(page, matches, description, timeoutMs = 4_000) {
  let state = await readCombat(page);
  for (let elapsed = 0; !matches(state) && elapsed < timeoutMs; elapsed += 32) {
    await page.clock.runFor(32);
    state = await readCombat(page);
  }
  assert.ok(matches(state), description + ': ' + JSON.stringify(state));
  return state;
}

export async function runEnemyRetargetSmoke(page, baseUrl) {
  const { layout } = playFixture(12);
  const game = await openWideGame(page, baseUrl + '/?mode=play&seed=12&debug=1', layout);
  await game.walkVia({ col: 19, row: 86 }, player);
  await game.settleView();
  await game.inspect(obstruction, '可挖地形', 'HP 5/5');
  await game.inspect(facility, '空地');
  await page.clock.runFor(32);
  const hoveredBuilding = page.locator('#expedition-building');
  assert.match(await hoveredBuilding.textContent(), /^科技设施 \(17, 90\) · 1 HP$/);

  await page.locator('#expedition-spawn').click();
  const attack = await waitForCombat(page, (state) => state.buildingContacts === 1,
    'The lone enemy must destroy the last building before reaching the player');
  assert.match(attack.feedback, /科技设施 \(17, 90\).*已摧毁/);
  assert.equal(attack.hp, 4);
  assert.equal(attack.phase, 'preparing');
  assert.equal(attack.spawned, 1);
  assert.equal(attack.active, 1);
  assert.equal(attack.removed, 0);
  assert.deepEqual(attack.trace, []);
  await game.inspect(facility, '空地');
  await page.clock.runFor(32);
  assert.equal(await hoveredBuilding.textContent(), '—');

  const detour = await waitForCombat(page, (state) => state.active === 1 && state.northRow <= obstruction.row,
    'The surviving enemy must advance north around the intact obstacle with no other target');
  assert.equal(detour.hp, 4, 'An enemy walking around the obstacle cannot damage the player from afar');
  assert.equal(detour.unreachable, 0);
  assert.deepEqual(detour.trace, []);
  await game.inspect(obstruction, '可挖地形', 'HP 5/5');

  const contact = await waitForCombat(page, (state) => state.playerContacts === 1,
    'The retargeted enemy must physically reach the player');
  assert.deepEqual(await game.position(), player);
  assert.equal(contact.phase, 'preparing');
  assert.equal(contact.hp, 3);
  assert.equal(contact.spawned, 1);
  assert.equal(contact.active, 0);
  assert.equal(contact.removed, 1);
  assert.equal(contact.buildingContacts, 1);
  assert.equal(contact.trace.length, 1);
  const [hit] = contact.trace;
  assert.equal(hit.source, 'enemy-body-contact');
  assert.deepEqual(hit.playerCell, player);
  assert.deepEqual([hit.hpBefore, hit.hpAfter], [4, 3]);
  assert.equal(hit.allowedRange, ENEMY_RADIUS);
  const dx = Math.abs(hit.enemyWorld.x - hit.playerWorld.x);
  const dy = Math.abs(hit.enemyWorld.y - hit.playerWorld.y);
  const gap = Math.hypot(Math.max(0, dx - PLAYER_HALF_SIZE), Math.max(0, dy - PLAYER_HALF_SIZE));
  assert.ok(Math.abs(hit.collisionDistance - gap) <= 1e-6 && gap <= ENEMY_RADIUS + 1e-6);
  await game.inspect(obstruction, '可挖地形', 'HP 5/5');
  return { enemyId: hit.enemyId, player, destroyed: facility, preserved: obstruction, hp: contact.hp };
}

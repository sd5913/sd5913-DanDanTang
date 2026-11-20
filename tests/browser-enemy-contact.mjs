import assert from 'node:assert/strict';
import { PLAYER_HALF_SIZE, TILE_SIZE, cellCenter, worldToCell } from '../src/player.ts';
import { openWideGame, playFixture } from './browser-fix02.mjs';

const seed = 12;
const enemyRadius = 5;
const contactTolerance = 1e-6;
const approachRow = 94;
const stagingCell = { col: 25, row: approachRow };

function near(value, expected, tolerance, label) {
  assert.ok(Math.abs(value - expected) <= tolerance, `${label}: expected ${expected}, saw ${value}`);
}

function readCombat(page) {
  return page.evaluate(() => {
    const trace = document.getElementById('player-contact-trace').value;
    const stats = document.getElementById('defense-stats').dataset;
    return {
      hp: Number(document.getElementById('player-hp').textContent),
      phase: document.getElementById('round-state').dataset.phase,
      active: Number(stats.active),
      visible: Number(stats.visible),
      contacts: trace ? JSON.parse(trace) : [],
    };
  });
}

async function redPixels(page, { left, top, right, bottom }) {
  return page.locator('#board canvas').evaluate((canvas, bounds) => {
    const x = Math.max(0, Math.floor(bounds.left));
    const y = Math.max(0, Math.floor(bounds.top));
    const width = Math.min(canvas.width, Math.ceil(bounds.right)) - x;
    const height = Math.min(canvas.height, Math.ceil(bounds.bottom)) - y;
    if (width <= 0 || height <= 0) return 0;
    const data = canvas.getContext('2d').getImageData(x, y, width, height).data;
    let matching = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (Math.abs(data[index] - 236) <= 3 && Math.abs(data[index + 1] - 129) <= 3
        && Math.abs(data[index + 2] - 122) <= 3) matching += 1;
    }
    return matching;
  }, { left, top, right, bottom });
}

async function projection(page, game) {
  const view = await game.view();
  const size = await page.locator('#board canvas').evaluate(({ width, height }) => ({ width, height }));
  return {
    toCanvas: ({ x, y }) => ({
      x: (x - view.left) * size.width / view.width,
      y: (y - view.top) * size.height / view.height,
    }),
  };
}

async function spawnDistantEnemy(page, game, currentHp, priorContacts) {
  await page.locator('#expedition-spawn').click();
  await page.clock.runFor(64);
  const current = await readCombat(page);
  assert.equal(current.hp, currentHp, 'A visible enemy at the southern entrance has no contact range');
  assert.equal(current.contacts.length, priorContacts, 'An approaching red dot must not report a hit');
  assert.equal(current.active, 1);
  assert.equal(current.visible, 1);

  const { toCanvas } = await projection(page, game);
  const left = toCanvas({ x: 27 * TILE_SIZE, y: approachRow * TILE_SIZE }).x;
  const right = toCanvas({ x: 31 * TILE_SIZE, y: approachRow * TILE_SIZE }).x;
  const top = toCanvas({ x: 0, y: approachRow * TILE_SIZE }).y;
  const bottom = toCanvas({ x: 0, y: (approachRow + 1) * TILE_SIZE }).y;
  assert.ok(await redPixels(page, { left, top, right, bottom }) > 0,
    'The distant live enemy must be visible as a red dot on the actual game canvas');
}

async function watchContact(page, currentHp, priorContacts) {
  for (let elapsed = 0; elapsed < 2_000; elapsed += 16) {
    await page.clock.runFor(16);
    const current = await readCombat(page);
    if (current.hp < currentHp) {
      assert.equal(current.hp, currentHp - 1);
      assert.equal(current.contacts.length, priorContacts + 1);
      return current.contacts.at(-1);
    }
    assert.equal(current.hp, currentHp);
    assert.equal(current.contacts.length, priorContacts);
  }
  assert.fail('The approaching enemy never physically reached the player');
}

async function verifyContact(page, game, contact, hpBefore) {
  assert.ok(Number.isInteger(contact.enemyId) && contact.enemyId > 0);
  assert.ok(Number.isFinite(contact.timeMs) && contact.timeMs > 0);
  assert.equal(contact.source, 'enemy-body-contact');
  assert.equal(contact.hpBefore, hpBefore);
  assert.equal(contact.hpAfter, hpBefore - 1);
  assert.equal(contact.allowedRange, enemyRadius);
  const { enemyWorld, playerWorld, enemyCell, playerCell } = contact;
  for (const point of [enemyWorld, playerWorld, contact.redDotWorld, contact.canvasPoint]) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), JSON.stringify(point));
  }
  assert.deepEqual(playerCell, worldToCell(playerWorld.x, playerWorld.y));
  const dotCell = worldToCell(enemyWorld.x, enemyWorld.y);
  assert.ok(Number.isInteger(enemyCell.col) && Number.isInteger(enemyCell.row));
  assert.ok(Math.abs(dotCell.col - enemyCell.col) + Math.abs(dotCell.row - enemyCell.row) <= 1,
    'The navigation cell may trail the interpolated red dot by only one tile');

  const dx = Math.abs(enemyWorld.x - playerWorld.x);
  const dy = Math.abs(enemyWorld.y - playerWorld.y);
  const gap = Math.hypot(Math.max(0, dx - PLAYER_HALF_SIZE), Math.max(0, dy - PLAYER_HALF_SIZE));
  near(contact.centerDistance, Math.hypot(dx, dy), contactTolerance, 'Center-to-center distance');
  near(contact.collisionDistance, gap, contactTolerance, 'Distance to the player body');
  assert.ok(gap <= enemyRadius + contactTolerance, 'HP must only drop when the red circle reaches the player body');

  assert.deepEqual(contact.redDotWorld, enemyWorld);
  assert.equal(contact.cameraVisible, true);
  assert.equal(contact.fogVisible, true);
  assert.equal(contact.drawn, true);
  const { toCanvas } = await projection(page, game);
  const expected = toCanvas(enemyWorld);
  near(contact.canvasPoint.x, expected.x, 1.5, 'Red dot canvas X');
  near(contact.canvasPoint.y, expected.y, 1.5, 'Red dot canvas Y');
  assert.ok(await redPixels(page, {
    left: expected.x - 3, top: expected.y - 3, right: expected.x + 4, bottom: expected.y + 4,
  }) > 0, 'The first damage frame must draw the red dot at the same actual world location as the collision');
}

export async function runEnemyContactSmoke(page, baseUrl) {
  const { layout } = playFixture(seed);
  const game = await openWideGame(page, `${baseUrl}/?mode=play&seed=${seed}&debug=1`, layout);
  await game.walkVia({ col: 21, row: 92 }, { col: 21, row: approachRow });
  await game.walkTo(stagingCell);
  await game.settleView();

  const initial = await readCombat(page);
  assert.equal(initial.phase, 'preparing');
  assert.equal(initial.hp, 4);
  assert.deepEqual(initial.contacts, []);
  await spawnDistantEnemy(page, game, 4, 0);
  const stationary = await watchContact(page, 4, 0);
  await verifyContact(page, game, stationary, 4);
  assert.deepEqual(stationary.playerCell, stagingCell);
  assert.ok(Math.abs(stationary.playerWorld.x - cellCenter(stagingCell).x) > 1,
    'The stationary hit must retain the exact off-center player position');

  const viewport = page.viewportSize();
  const beforeResize = await game.view();
  await page.setViewportSize({ width: viewport.width, height: viewport.height + 160 });
  const afterResize = await game.settleView();
  assert.ok(Math.abs(afterResize.height - beforeResize.height) >= TILE_SIZE,
    'Resize must exercise a changed world-to-canvas projection');

  await spawnDistantEnemy(page, game, 3, 1);
  let moving;
  await game.holdKey('KeyD', async () => {
    moving = await watchContact(page, 3, 1);
    await verifyContact(page, game, moving, 3);
  });
  assert.ok(moving.playerWorld.x > stationary.playerWorld.x + TILE_SIZE,
    'The second collision must use the continuously moving player rather than the original staging cell');
  assert.ok(moving.enemyId !== stationary.enemyId && moving.timeMs > stationary.timeMs);

  await game.holdKey('KeyR', () => page.clock.runFor(48));
  const reset = await readCombat(page);
  assert.equal(reset.hp, 4);
  assert.equal(reset.active, 0);
  assert.deepEqual(reset.contacts, []);
  return { stationary, moving };
}

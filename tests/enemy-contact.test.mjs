import assert from 'node:assert/strict';
import test from 'node:test';
import { DefenseSimulation, enemyWorldPosition } from '../src/defense-simulation.ts';
import { sweepPlayerContact } from '../src/enemy-contact.ts';
import { GENERATED_ENEMY_ENTRY, GENERATED_GOAL } from '../src/generated-map.ts';
import { Player, PLAYER_HALF_SIZE, TILE_SIZE, cellCenter } from '../src/player.ts';
import { TerrainMap } from '../src/terrain.ts';
import { playFixture } from './browser-fix02.mjs';

const enemyRadius = 5;
const cell = (col, row) => ({ col, row });
const playerTarget = (player) => ({ cell: player.cell, position: player.position });

function corridorMap(rowCount, spawn, open) {
  const layout = Array.from({ length: rowCount }, (_, row) => Array.from({ length: 24 }, (_, col) => {
    if (col === spawn.col && row === spawn.row) return 'S';
    return open(col, row) ? '.' : '#';
  }).join(''));
  return new TerrainMap(layout);
}

function startAttack(map, entry, goal) {
  const events = [];
  const simulation = new DefenseSimulation(map, entry, goal,
    (event, metadata) => events.push({ event, metadata }), true);
  return { simulation, events, hits: () => events.filter(({ event }) => event.type === 'playerHit') };
}

function advanceToHit(simulation, player, hits) {
  for (let elapsed = 0; hits().length === 0 && elapsed < 1_200; elapsed += 16) {
    simulation.step(16, playerTarget(player));
  }
  assert.equal(hits().length, 1, 'The enemy must advance beyond its adjacent route target until it touches');
  return hits()[0];
}

function assertContact(hit, player) {
  const { contact } = hit.metadata;
  assert.ok(contact, 'Real HP damage must carry the applied collision geometry');
  assert.deepEqual(contact.playerWorld, player.position);
  const dx = Math.abs(contact.enemyWorld.x - contact.playerWorld.x);
  const dy = Math.abs(contact.enemyWorld.y - contact.playerWorld.y);
  assert.ok(Math.abs(contact.centerDistance - Math.hypot(dx, dy)) < 1e-6);
  const gap = Math.hypot(Math.max(0, dx - PLAYER_HALF_SIZE), Math.max(0, dy - PLAYER_HALF_SIZE));
  assert.ok(Math.abs(contact.collisionDistance - gap) < 1e-6);
  assert.equal(contact.allowedRange, enemyRadius);
  assert.ok(contact.collisionDistance <= contact.allowedRange + 1e-6);
  assert.ok(contact.centerDistance <= Math.hypot(PLAYER_HALF_SIZE + enemyRadius, PLAYER_HALF_SIZE + enemyRadius));
  assert.equal(contact.source, 'enemy-body-contact');
  return contact;
}

test('Seed 12: the old 35.52 px gap deals no damage but approaching until the actual shapes touch does', () => {
  const { layout, biomes } = playFixture(12);
  const map = new TerrainMap(layout, { biomes });
  const player = new Player(cell(26, 94));
  for (let repeat = 0; repeat < 2; repeat += 1) player.move(-1, 0, 48, map);
  assert.deepEqual(player.cell, cell(26, 94));
  assert.ok(Math.abs(player.position.x - 624.48) < 1e-6);
  const { simulation, events, hits } = startAttack(map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL);
  simulation.requestWave(1, { count: 1, enemyHp: 4, wallDamage: 1, contactDamage: 1 });
  const [enemy] = simulation.enemies;

  // Pre-fix the 29th frame damaged the player as soon as the enemy reached (27, 94).
  for (let tick = 0; tick < 29; tick += 1) simulation.step(16, playerTarget(player));
  assert.deepEqual(hits(), []);
  assert.equal(simulation.counters.playerContacts, 0);
  assert.ok(events.some(({ event }) => event.type === 'targetSelected' && event.target.kind === 'player'));
  const beforeTouch = enemyWorldPosition(enemy);
  assert.ok(beforeTouch.x - player.position.x > PLAYER_HALF_SIZE + enemyRadius);

  const hit = advanceToHit(simulation, player, hits);
  const actual = assertContact(hit, player);
  assert.deepEqual(actual.enemyWorld, enemyWorldPosition(enemy));
  assert.equal(actual.enemyWorld.y, player.position.y);
  assert.ok(actual.centerDistance > 0 && actual.centerDistance <= PLAYER_HALF_SIZE + enemyRadius + 1e-6);
  assert.equal(hit.event.damage, 1);
  assert.ok(hit.metadata.timeMs > 464);
  assert.equal(simulation.getWaveMetrics(1).playerContacts, 1);
  assert.deepEqual([...simulation.enemies], []);
  simulation.step(500, playerTarget(player));
  assert.equal(hits().length, 1);
});

test('solid rock prevents damage from an enemy in a disconnected corridor', () => {
  const entry = cell(5, 5);
  const map = corridorMap(32, entry, (col, row) => row === 5 && (col === 5 || col === 7 || col === 8));
  const player = new Player(cell(7, 5));
  player.move(-1, 0, 50, map);
  const { simulation, hits } = startAttack(map, entry, cell(8, 5));
  simulation.spawn(1, 1);
  for (let frame = 0; frame < 40; frame += 1) simulation.step(16, playerTarget(player));

  assert.deepEqual(hits(), []);
  assert.equal(simulation.counters.playerContacts, 0);
  assert.equal(simulation.counters.wallImpacts, 0);
  assert.deepEqual(enemyWorldPosition([...simulation.enemies][0]), cellCenter(entry));
});

test('an enemy on the other side of a wall deals only its one legal wall impact', () => {
  const entry = cell(5, 5);
  const wallCell = cell(6, 5);
  const map = corridorMap(32, entry, (col, row) => row === 5 && col >= 5 && col <= 8);
  assert.ok(map.placeBuilding('wall', wallCell, 5));
  const player = new Player(cell(7, 5));
  player.move(-1, 0, 50, map);
  const { simulation, events, hits } = startAttack(map, entry, cell(8, 5));
  simulation.spawn(1, 1);
  for (let frame = 0; frame < 40; frame += 1) simulation.step(16, playerTarget(player));

  assert.deepEqual(hits(), []);
  assert.equal(simulation.counters.playerContacts, 0);
  assert.equal(simulation.counters.wallImpacts, 1);
  assert.equal(map.getBuilding(wallCell).hp, 4);
  assert.deepEqual([...simulation.enemies], []);
  assert.equal(events.filter(({ event }) => event.type === 'wallImpact').length, 1);
});

test('two enemies already overlapping the player each deal damage once', () => {
  const entry = cell(5, 5);
  const map = corridorMap(32, entry, (col, row) => row === 5 && col >= 5 && col <= 8);
  const player = new Player(entry);
  const { simulation, hits } = startAttack(map, entry, cell(8, 5));
  assert.equal(simulation.spawn(2, 1, { hp: 4, contactDamage: 2 }), 2);
  simulation.step(1, playerTarget(player));

  assert.deepEqual(hits().map(({ event }) => [event.enemyId, event.damage]), [[1, 2], [2, 2]]);
  for (const hit of hits()) assert.equal(assertContact(hit, player).centerDistance, 0);
  assert.equal(simulation.counters.playerContacts, 2);
  assert.deepEqual([...simulation.enemies], []);
  simulation.step(600, playerTarget(player));
  assert.equal(hits().length, 2);
});

test('the same physical player hit works after an enemy advances across a chunk boundary', () => {
  const entry = cell(4, 61);
  const map = corridorMap(96, entry, (col, row) => col === 4 && row >= 61 && row <= 67);
  const player = new Player(cell(4, 64));
  player.move(0, 1, 48, map);
  const { simulation, hits } = startAttack(map, entry, cell(4, 67));
  simulation.spawn(1, 1);
  for (let tick = 0; tick < 20; tick += 1) simulation.step(16, playerTarget(player));

  assert.deepEqual(hits(), [], 'The enemy must still cover the gap from the neighboring chunk');
  const actual = assertContact(advanceToHit(simulation, player, hits), player);
  assert.equal(actual.enemyWorld.x, player.position.x);
  assert.ok(actual.enemyWorld.y >= 64 * TILE_SIZE && actual.enemyWorld.y < player.position.y);
  assert.ok(actual.centerDistance <= PLAYER_HALF_SIZE + enemyRadius + 1e-6);
});

test('circle sweep rejects the rectangle corner gap and catches a real mid-frame corner touch', () => {
  const player = { x: 100, y: 100 };
  const gap = { x: 112, y: 112 };
  assert.equal(sweepPlayerContact(gap, gap, player), undefined);

  const start = { x: 115, y: 111 };
  const end = { x: 85, y: 111 };
  assert.equal(sweepPlayerContact(start, start, player), undefined);
  assert.equal(sweepPlayerContact(end, end, player), undefined);
  const crossing = sweepPlayerContact(start, end, player);
  assert.ok(crossing);
  assert.deepEqual(crossing.enemyWorld, { x: 110, y: 111 });
  assert.equal(crossing.collisionDistance, enemyRadius);
  assert.ok(Math.abs(crossing.progress - 1 / 6) < 1e-6);
});

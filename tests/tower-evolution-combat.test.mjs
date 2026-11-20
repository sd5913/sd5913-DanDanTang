import assert from "node:assert/strict";
import test from "node:test";
import { evolvedTowerAttributes } from "../src/building-balance.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { ENEMY_RADIUS } from "../src/enemy-contact.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { buildEvolvedTowerCoverage, evolvedTargetDistanceSquared, hasTowerLineOfSight } from "../src/tower-attack.ts";

const cell = (col, row) => ({ col, row });
const point = (x, y) => ({ x, y });
const source = cell(8, 8);
const horizontal = [source, cell(7, 8), cell(6, 8), cell(5, 8)];
const vertical = [source, cell(8, 7), cell(8, 6), cell(8, 5)];
const burst = [source, cell(7, 8), cell(7, 7), cell(6, 7)];

function battle({ entry = cell(3, 25), obstacles = [], highland = false, expeditionCombat = false,
  fallback = entry, onEvent = () => {} } = {}) {
  const layout = Array.from({ length: 32 }, () => Array(24).fill("."));
  for (const [position, marker] of obstacles) layout[position.row][position.col] = marker;
  layout[entry.row][entry.col] = "S";
  const biomes = Array.from({ length: 32 }, () => Array(24).fill("ordinary"));
  if (highland) biomes[source.row][source.col] = "highland";
  const map = new TerrainMap(layout.map((row) => row.join("")), { towerEvolution: true, buildingBalance: "w25", biomes });
  const events = [];
  const defense = new DefenseSimulation(map, entry, fallback, (event, metadata) => {
    events.push({ event, metadata });
    onEvent(event, metadata);
  }, expeditionCombat);
  const ofType = (type) => events.filter(({ event }) => event.type === type);
  return { map, defense, events, ofType };
}

function placeTowers(map, sites) {
  for (const site of sites) assert.ok(map.placeBuilding("tower", site));
  return map.getBuilding(source);
}

// Seed real units via the simulation, then position them to isolate targeting from the route geometry.
function positionEnemies(defense, positions, hp) {
  assert.equal(defense.spawn(positions.length, 1, { hp, contactDamage: 1 }), positions.length);
  const units = [...defense.enemies];
  for (const [index, position] of positions.entries()) setEnemyPosition(units[index], position);
  return units;
}

function setEnemyPosition(enemy, { x, y }) {
  enemy.cell = cell(Math.floor(x), Math.floor(y));
  enemy.point = point(x * TILE_SIZE, y * TILE_SIZE);
  enemy.move = undefined;
}

function aimAt(map, tower, targets) {
  const attributes = evolvedTowerAttributes(tower.evolution, map.getBiome(tower.cell));
  const coverage = buildEvolvedTowerCoverage(map, tower.cell, attributes);
  return targets.map((target) => evolvedTargetDistanceSquared(map, coverage, target) !== undefined);
}

test("PIERCE-01 / TOWER-02: fixed axes use the true body width; highland extends only their range", () => {
  const radius = ENEMY_RADIUS / TILE_SIZE;
  const { map } = battle();
  const horizontalTower = placeTowers(map, horizontal);
  assert.deepEqual(aimAt(map, horizontalTower, [
    point(15.5, 8.5), point(15.5001, 8.5), point(10.5, 8.5 + radius - 0.00001), point(10.5, 8.5 + radius + 0.00001),
    point(10.5, 9.5), point(8.5, 10.5), point(4.5, 8.5),
  ]), [true, false, true, false, false, false, true]);

  const highland = battle({ highland: true });
  const verticalTower = placeTowers(highland.map, vertical);
  assert.deepEqual(evolvedTowerAttributes(verticalTower.evolution, "highland"), {
    kind: "piercing", axis: "vertical", damage: 5, intervalMs: 900, baseRange: 7, range: 9, maxTargets: 4,
  });
  assert.deepEqual(aimAt(highland.map, verticalTower, [
    point(8.5, 16.5), point(8.5, 17.5), point(8.5, 17.5001), point(9.5, 16.5), point(10.5, 8.5),
  ]), [true, true, false, false, false]);
});

test("PIERCE-02/03/04: one ray hits the four nearest eligible units, including overlaps once each", () => {
  const { map, defense, ofType, events } = battle();
  const tower = placeTowers(map, horizontal);
  const units = positionEnemies(defense, [
    point(12.5, 8.5), point(10.5, 8.5), point(6.5, 8.5), point(10.5, 8.5),
    point(9.5, 9.5), point(9.5, 8.5), point(11.5, 8.5),
  ], 14);
  defense.step(1);

  const shots = ofType("towerShot");
  assert.deepEqual(shots.map(({ event }) => [event.enemyId, event.damage]), [[6, 5], [2, 5], [4, 5], [7, 5]]);
  assert.deepEqual(units.map(({ hp }) => hp), [14, 9, 14, 9, 14, 9, 9]);
  assert.equal(ofType("towerEffect").length, 1);
  const { event: effect } = ofType("towerEffect")[0];
  assert.equal(events.at(-1).event, effect);
  assert.deepEqual(effect, {
    type: "towerEffect", towerId: tower.id, enemyIds: [6, 2, 4, 7],
    effect: { kind: "piercing", from: point(8.5, 8.5), to: point(15.5, 8.5) },
  });
  assert.deepEqual(shots[0].metadata.towerHit, {
    kind: "piercing", rawDamage: 5, overkill: 0, enemyCell: cell(9, 8),
  });
});

test("PIERCE-05: dirt, rock, water and buildings stop a ray; digging and removal open it immediately", () => {
  const barrier = cell(10, 8);
  const distant = point(12.5, 8.5);
  for (const marker of ["#", "~"]) {
    const { map } = battle({ obstacles: [[barrier, marker]] });
    const tower = placeTowers(map, horizontal);
    assert.deepEqual(aimAt(map, tower, [point(9.5, 8.5), distant]), [true, false]);
  }

  const { map, defense, ofType } = battle({ entry: cell(12, 8), obstacles: [[barrier, "+"]] });
  const tower = placeTowers(map, horizontal);
  assert.equal(defense.spawn(1, 1, { hp: 14, contactDamage: 1 }), 1);
  defense.step(1);
  assert.equal(ofType("towerShot").length, 0);
  assert.ok(map.applyDigDamage(cell(9, 8), barrier, 100).cleared);
  const wall = map.placeBuilding("wall", barrier);
  assert.ok(wall);
  defense.step(1);
  assert.equal(ofType("towerShot").length, 0);
  assert.ok(map.removeBuilding(barrier, wall.id));
  defense.step(1);
  assert.deepEqual(ofType("towerShot").map(({ event }) => [event.enemyId, event.towerId, event.damage]), [[1, tower.id, 5]]);
});

test("TOWER-01: the old shot deadline is honored before the piercing interval starts", () => {
  const { map, defense, ofType } = battle({ entry: cell(13, 8) });
  const standard = map.placeBuilding("tower", source);
  assert.ok(standard);
  assert.equal(defense.spawn(1, 1, { hp: 14, contactDamage: 1 }), 1);
  defense.step(1);
  const upgraded = placeTowers(map, horizontal.slice(1));
  assert.equal(upgraded.id, standard.id);
  assert.equal(upgraded.cell, standard.cell);
  defense.step(349);
  assert.equal(ofType("towerShot").length, 1);
  defense.step(1);
  defense.step(899);
  assert.equal(ofType("towerShot").length, 2);
  defense.step(1);
  assert.deepEqual(ofType("towerShot").map(({ event, metadata }) => [
    event.damage, event.towerId, metadata.timeMs, metadata.towerHit.kind,
  ]), [[2, standard.id, 1, "standard"], [5, standard.id, 351, "piercing"], [5, standard.id, 1251, "piercing"]]);
});

test("BURST-01/02/03: nearest legal primary takes 4, overlaps and other nearby units each take 2", () => {
  const { map, defense, ofType } = battle();
  const tower = placeTowers(map, burst);
  const units = positionEnemies(defense, [
    point(11.5, 8.5), point(10.5, 8.5), point(10.5, 8.5), point(10.5, 9.5),
    point(11.5, 9.5), point(13.5, 8.5),
  ], 14);
  defense.step(1);
  assert.deepEqual(ofType("towerShot").map(({ event, metadata }) => [
    event.enemyId, event.damage, metadata.towerHit.kind,
  ]), [[2, 4, "burst"], [1, 2, "burst"], [3, 2, "burst"], [4, 2, "burst"]]);
  assert.deepEqual(units.map(({ hp }) => hp), [12, 10, 12, 12, 14, 14]);
  const { event } = ofType("towerEffect")[0];
  assert.deepEqual(event, {
    type: "towerEffect", towerId: tower.id, enemyIds: [2, 1, 3, 4],
    effect: { kind: "burst", from: point(8.5, 8.5), center: ofType("towerShot")[0].event.to, radius: 1.25 },
  });
  assert.equal(ofType("towerEffect").length, 1);
});

test("BURST-01/02: primary and splash traces independently block solid cells and corner gaps", () => {
  const blockedPrimary = battle({ obstacles: [[cell(9, 8), "#"]] });
  placeTowers(blockedPrimary.map, burst);
  positionEnemies(blockedPrimary.defense, [point(10.5, 8.5), point(8.5, 11.5)], 14);
  blockedPrimary.defense.step(1);
  assert.deepEqual(blockedPrimary.ofType("towerShot").map(({ event }) => event.enemyId), [2]);

  const blockedSplash = battle({ obstacles: [[cell(11, 8), "#"]] });
  placeTowers(blockedSplash.map, burst);
  assert.ok(blockedSplash.map.placeBuilding("wall", cell(10, 9)));
  const center = point(10.7, 8.7);
  const occluded = point(11.3, 9.3);
  assert.equal(hasTowerLineOfSight(blockedSplash.map, center, occluded), false);
  assert.equal(hasTowerLineOfSight(blockedSplash.map, occluded, center), false);
  positionEnemies(blockedSplash.defense, [center, occluded, point(10.4, 8.7)], 14);
  blockedSplash.defense.step(1);
  assert.deepEqual(blockedSplash.ofType("towerShot").map(({ event }) => [event.enemyId, event.damage]), [[3, 4], [1, 2]]);

  const singleCorner = battle({ obstacles: [[cell(11, 8), "#"]] });
  assert.equal(hasTowerLineOfSight(singleCorner.map, center, occluded), false);
  assert.equal(hasTowerLineOfSight(singleCorner.map, point(10.7, 8.72), occluded), true);
});

test("BURST-04: grouped kills clip overkill, credit exact spawn waves once and never hit removed units", () => {
  let economy;
  const { map, defense, ofType } = battle({
    fallback: cell(3, 21),
    onEvent: (event, metadata) => economy.handleEvent(event, metadata.waveId),
  });
  economy = new ExpeditionEconomy(map, 12, undefined, "challenge", { killDecay: true });
  const deployment = { intervalMs: 150 };
  const order = { enemyHp: 2, wallDamage: 1, contactDamage: 1 };
  assert.equal(defense.requestWave(1, { ...order, count: 9 }, deployment), 9);
  assert.equal(defense.requestWave(2, { ...order, count: 1 }, deployment), 1);
  for (let count = 0; count < 10; count += 1) defense.step(150);
  assert.equal(defense.spawnCounts.spawned, 10);
  for (const enemy of defense.enemies) setEnemyPosition(enemy, point(10.5, 8.5));
  placeTowers(map, burst);
  defense.step(1);
  const shots = ofType("towerShot");
  const kills = ofType("towerKill");
  const effects = ofType("towerEffect");
  assert.equal(effects.length, 1);
  assert.deepEqual(effects[0].event.enemyIds, kills.map(({ event }) => event.enemyId));
  assert.equal(new Set(effects[0].event.enemyIds).size, 10);
  assert.equal(shots.length, 10);
  assert.deepEqual(shots.map(({ event, metadata }) => [event.damage, metadata.towerHit.overkill]), [
    [2, 2], ...Array.from({ length: 9 }, () => [2, 0]),
  ]);
  assert.deepEqual([1, 2].map((waveId) => defense.getWaveMetrics(waveId).towerKills), [9, 1]);
  assert.equal(economy.totals.killIncome, 19);
  for (const { event, metadata } of kills) assert.equal(economy.handleEvent(event, metadata.waveId), 0);
  defense.step(650);
  assert.equal(ofType("towerShot").length, 10);
  assert.equal(defense.spawnCounts.removed, 10);
  assert.equal(economy.totals.killIncome, 19);
});

test("TOWER-01/02: the burst deadline survives the merge and highland extends aim but never splash", () => {
  const { map, defense, ofType } = battle({ highland: true, entry: cell(13, 8) });
  const standard = map.placeBuilding("tower", source);
  assert.ok(standard);
  assert.equal(defense.spawn(1, 1, { hp: 14, contactDamage: 1 }), 1);
  defense.step(1);
  const upgraded = placeTowers(map, burst.slice(1));
  assert.equal(upgraded.cell, standard.cell);
  assert.deepEqual(evolvedTowerAttributes(upgraded.evolution, "highland"), {
    kind: "burst", damage: 4, intervalMs: 650, baseRange: 4, range: 6, splashDamage: 2, radius: 1.25,
  });
  assert.deepEqual(aimAt(map, upgraded, [point(14.5, 8.5), point(14.5001, 8.5)]), [true, false]);
  defense.step(349);
  assert.equal(ofType("towerShot").length, 1);
  defense.step(1);
  defense.step(649);
  assert.equal(ofType("towerShot").length, 2);
  defense.step(1);
  assert.deepEqual(ofType("towerShot").map(({ event, metadata }) => [
    event.damage, event.towerId, metadata.timeMs, metadata.towerHit.kind,
  ]), [[2, standard.id, 1, "standard"], [4, standard.id, 351, "burst"], [4, standard.id, 1001, "burst"]]);
  assert.equal(ofType("towerEffect")[0].event.effect.radius, 1.25);
});

test("TOWER-03: either one-HP upgrade is destroyed on valid contact while the enemy survives and retargets", () => {
  for (const sites of [horizontal, burst]) {
    const { map, defense, ofType } = battle({ entry: cell(9, 8), fallback: cell(9, 5), expeditionCombat: true });
    const tower = placeTowers(map, sites);
    assert.equal(tower.hp, 1);
    assert.equal(tower.maxHp, 1);
    assert.equal(defense.spawn(1, 1, { hp: 14, contactDamage: 1 }), 1);
    const revision = map.revision;
    defense.step(25);
    assert.equal(ofType("towerShot").length, 1);
    defense.step(25);
    assert.equal(map.getBuilding(source), undefined);
    assert.equal(map.revision, revision + 1);
    assert.equal(map.isWalkable(source), true);
    assert.deepEqual(ofType("buildingHit").map(({ event }) => [
      event.enemyId, event.buildingId, event.damage, event.destroyed,
    ]), [[1, tower.id, 1, true]]);
    assert.equal(ofType("wallImpact").length, 0);
    assert.equal(defense.spawnCounts.removed, 0);
    defense.step(350);
    assert.ok([...defense.enemies][0].cell.row < 8);
    assert.equal(ofType("targetSelected").at(-1).event.target.buildingId, undefined);
  }
});

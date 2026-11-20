import assert from "node:assert/strict";
import test from "node:test";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const point = (x, y) => ({ x, y });
const horizontal = [cell(8, 8), cell(7, 8), cell(6, 8), cell(5, 8)];
const burst = [cell(8, 8), cell(7, 8), cell(7, 7), cell(6, 7)];
const armouredOrder = { count: 1, wallDamage: 1, enemyHp: 4, contactDamage: 1 };
const armour = { intervalMs: 200, armor: { hp: 14, slots: [0] } };

function fixture({ towerDiagnostics = true, entry = cell(3, 25), target = entry, rock = [], towerSites = horizontal } = {}) {
  const rows = Array.from({ length: 32 }, () => Array(24).fill("."));
  for (const { col, row } of rock) rows[row][col] = "#";
  rows[entry.row][entry.col] = "S";
  const map = new TerrainMap(rows.map((row) => row.join("")), { towerEvolution: true, buildingBalance: "w25" });
  const events = [];
  const economy = new ExpeditionEconomy(map, 515, undefined, "challenge", { tieredCraft: true, killDecay: true });
  const sim = new DefenseSimulation(map, entry, target, (event, metadata) => {
    events.push({ event, metadata, income: economy.handleEvent(event, metadata.waveId) });
  }, false, { towerDiagnostics });
  for (const at of towerSites) assert.ok(map.placeBuilding("tower", at));
  return { map, sim, events, economy };
}

function placeEnemy(enemy, { x, y }) {
  enemy.cell = cell(Math.floor(x), Math.floor(y));
  enemy.point = point(x * TILE_SIZE, y * TILE_SIZE);
  enemy.move = undefined;
}

function spawnAt(sim, positions, hp) {
  assert.equal(sim.spawn(positions.length, 1, { hp, contactDamage: 1 }), positions.length);
  const units = [...sim.enemies];
  for (const [index, position] of positions.entries()) placeEnemy(units[index], position);
  return units;
}

function armorAt(sim, position) {
  assert.equal(sim.requestWave(1, armouredOrder, armour), 1);
  const [armored] = sim.enemies;
  assert.equal(armored.kind, "armored");
  placeEnemy(armored, position);
  return armored;
}

test("opt-in tower observations leave spawn timing, contact, damage, economy and navigation identical", () => {
  const run = (towerDiagnostics) => {
    const goal = cell(14, 8);
    const wall = cell(12, 8);
    const barrier = Array.from({ length: 32 }, (_, row) => cell(12, row)).filter(({ row }) => row !== wall.row);
    const { map, sim, events, economy } = fixture({
      towerDiagnostics, entry: cell(9, 8), target: goal, rock: barrier, towerSites: [...horizontal, cell(11, 10)],
    });
    assert.ok(map.placeBuilding("wall", wall));
    assert.equal(sim.requestWave(1, { ...armouredOrder, count: 16 }, {
      intervalMs: 100, armor: { hp: 14, slots: [2, 6, 10, 14] },
    }), 16);
    for (let time = 0; time < 12_000 && sim.spawnCounts.removed < 16; time += 10) sim.step(10);
    assert.equal(sim.spawnCounts.removed, 16);
    assert.ok(events.some(({ event }) => event.type === "towerKill"));
    assert.ok(events.some(({ event }) => event.type === "wallImpact"));
    assert.equal(sim.towerDiagnostics === undefined, !towerDiagnostics);
    return { events, counts: sim.counters, spawns: sim.spawnCounts, metrics: sim.waveMetrics, searches: sim.searchCount,
      balance: economy.balance, wallHp: map.getBuilding(wall)?.hp };
  };
  assert.deepEqual(run(false), run(true));
});

test("per-tower decisions distinguish no target, occlusion, wrong axis and a cooldown-delayed finish that exits", () => {
  const { sim } = fixture({ rock: [cell(12, 8)] });
  sim.step(1);
  const [outside, offAxis, occluded] = spawnAt(sim, [point(21.5, 20.5), point(9.5, 9.5), point(13.5, 8.5)], 6);
  sim.step(1);
  placeEnemy(outside, point(10.5, 8.5));
  sim.step(1);
  assert.equal(outside.hp, 1);
  sim.step(10);
  placeEnemy(outside, point(22.5, 20.5));
  placeEnemy(offAxis, point(20.5, 19.5));
  placeEnemy(occluded, point(22.5, 19.5));
  sim.step(10);
  const [tower] = sim.towerDiagnostics;
  assert.equal(tower.kind, "piercing");
  assert.equal(tower.axis, "horizontal");
  assert.equal(tower.effectiveRange, 7);
  assert.equal(tower.rayReachTiles, 10.5);
  assert.ok(tower.observedEligibleTiles.some(({ col, row }) => col === 10 && row === 8));
  assert.deepEqual(tower.decisions, {
    noTarget: 2, noLegalTarget: 1, legalReady: 1, cooldown: 1, occludedTargets: 3, offAxisTargets: 3,
    blockedWhenReady: 1, offAxisWhenReady: 1, occludedSplashTargets: 0, cooldownFinish: 1, missedCooldownFinish: 1,
  });
  assert.deepEqual(tower.exposures, [{
    enemyId: outside.id, enemyKind: "normal", enteredAtMs: 3, leftAtMs: 23, durationMs: 20, hpAfter: 1, reason: "left-area",
  }]);
});

test("grouped live burst separates primary and splash, overkill, distinct hits, exact positions and final kills", () => {
  const { sim, events } = fixture({ towerSites: burst });
  const units = spawnAt(sim, [point(9.5, 8.5), point(9.5, 8.5), point(10.5, 8.5), point(11.24, 8.5)], 2);
  sim.step(1);
  const [tower] = sim.towerDiagnostics;
  assert.equal(tower.kind, "burst");
  assert.equal(tower.fireCount, 1);
  assert.equal(tower.hitCount, 3);
  assert.equal(tower.hitEnemyCount, 3);
  assert.equal(tower.primaryHits, 1);
  assert.equal(tower.additionalHits, 2);
  assert.equal(tower.effectiveDamage, 6);
  assert.equal(tower.overkillDamage, 2);
  assert.equal(tower.kills, 3);
  assert.equal(tower.splashDamage, 4);
  assert.equal(tower.splashShare, 2 / 3);
  assert.equal(tower.averageTargetsPerShot, 3);
  assert.equal(tower.hitDistribution.three, 1);
  assert.deepEqual(tower.shots[0].targets.map(({ enemyId, role, damage, hpAfter }) => [enemyId, role, damage, hpAfter]), [
    [units[0].id, "primary", 2, 0], [units[1].id, "additional", 2, 0], [units[2].id, "additional", 2, 0],
  ]);
  assert.deepEqual(tower.shots[0].targets.map(({ position }) => position),
    events.filter(({ event }) => event.type === "towerShot").map(({ event }) => event.to));
  assert.equal(units[3].hp, 2);
});

test("an armored enemy genuinely moves out of a ray and carries remaining HP into its live exit measurement", () => {
  const { sim } = fixture({ entry: cell(3, 8), target: cell(20, 8) });
  const armored = armorAt(sim, point(14.25, 8.5));
  for (let time = 0; time < 400; time += 10) sim.step(10);
  const [tower] = sim.towerDiagnostics;
  assert.equal(tower.armoredDamage, 5);
  assert.equal(tower.armoredKills, 0);
  assert.equal(tower.armoredExits, 1);
  assert.equal(tower.armoredExitHpSum, 9);
  assert.equal(tower.meanArmoredExitHp, 9);
  assert.equal(armored.hp, 9);
  assert.deepEqual(tower.exposures.map(({ enteredAtMs, leftAtMs, durationMs, reason }) =>
    ({ enteredAtMs, leftAtMs, durationMs, reason })), [
    { enteredAtMs: 10, leftAtMs: 190, durationMs: 180, reason: "left-area" },
  ]);
  sim.reset();
  assert.deepEqual(sim.towerDiagnostics, []);
});

test("piercing armor damage supports ordinary finishing towers while the spawn wave rewards a single kill", () => {
  const { sim, events, economy } = fixture({
    entry: cell(3, 8), target: cell(20, 8), towerSites: [...horizontal, cell(11, 10), cell(12, 10)],
  });
  const armored = armorAt(sim, point(10.5, 8.5));
  for (let time = 0; time < 1_200 && sim.spawnCounts.removed < 1; time += 10) sim.step(10);
  assert.equal(armored.hp, 0);
  const [piercing, ...regular] = sim.towerDiagnostics;
  assert.equal(piercing.armoredDamage, 5);
  assert.equal(piercing.armoredKills, 0);
  assert.equal(piercing.armoredAssists, 1);
  assert.equal(piercing.armoredAssistDamage, 5);
  assert.equal(piercing.armoredExits, 0);
  assert.equal(regular.reduce((total, tower) => total + tower.armoredKills, 0), 1);
  assert.equal(regular.reduce((total, tower) => total + tower.armoredDamage, 0), 9);
  assert.deepEqual(events.filter(({ event }) => event.type === "towerKill")
    .map(({ event, metadata, income }) => [event.enemyId, metadata.waveId, income]), [[armored.id, 1, 2]]);
  assert.equal(economy.totals.killIncome, 2);
});

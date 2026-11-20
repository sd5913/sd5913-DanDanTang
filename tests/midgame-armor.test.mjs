import assert from "node:assert/strict";
import test from "node:test";
import { DefenseSimulation, enemyWorldPosition } from "../src/defense-simulation.ts";
import { GENERATED_ENEMY_ENTRY } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";

const entry = GENERATED_ENEMY_ENTRY;
const goal = { col: entry.col, row: 4 };
const gate = { col: entry.col, row: 70 };
const attack = { col: entry.col, row: 90 };
const nestRow = 78;
const towerSites = Array.from({ length: 4 }, (_, index) => ({ col: entry.col + 2 + index, row: nestRow }));
const order = (count) => ({ count, enemyHp: 7, wallDamage: 2, contactDamage: 1 });
const armorPlan = (slots, intervalMs = 200, hp = 14) => ({ intervalMs, armor: { hp, slots } });

function scenario({ wall = false, tower = false } = {}) {
  const layout = Array.from({ length: 96 }, (_, row) => Array.from({ length: 40 }, (_, col) => {
    if (row === entry.row && col === entry.col - 1) return "S";
    if (row === goal.row && col === goal.col) return "G";
    if (tower && row === nestRow && towerSites.some((site) => site.col === col)) return ".";
    return col === entry.col && row > goal.row && row <= entry.row ? "." : "#";
  }).join(""));
  const map = new TerrainMap(layout, { buildingBalance: "w25" });
  if (wall) assert.ok(map.placeBuilding("wall", gate));
  if (tower) {
    for (const site of towerSites) assert.ok(map.placeBuilding("tower", site));
    assert.equal(map.getBuilding(towerSites[0]).level, 2);
  }
  const events = [];
  const simulation = new DefenseSimulation(map, entry, goal, (event, metadata) => events.push({ event, metadata }), true);
  return { map, simulation, events };
}

function runUntil(simulation, timeMs, player) {
  while (simulation.elapsedMs < timeMs) simulation.step(Math.min(25, timeMs - simulation.elapsedMs), player);
}

function assertTypesAccounted(wave) {
  const kinds = Object.values(wave.enemyKinds);
  for (const kind of kinds) {
    assert.equal(kind.planned, kind.spawned + kind.pending + kind.cancelledPending);
    assert.equal(kind.spawned, kind.active + kind.wallImpacts + kind.towerKills + kind.playerContacts + kind.cancelledActive);
  }
  for (const field of ["planned", "spawned", "pending", "active", "wallImpacts", "towerHits", "towerKills",
    "towerExposed", "buildingContacts", "playerContacts", "cancelledPending", "cancelledActive"]) {
    assert.equal(kinds[0][field] + kinds[1][field], wave[field], field);
  }
}

test("armored slots use the queued immutable type and HP without changing movement", () => {
  const { simulation, events } = scenario();
  const plan = armorPlan([0, 2]);
  assert.equal(simulation.requestWave(1, order(3), plan), 3);
  plan.armor.hp = 99;
  plan.armor.slots[1] = 1;
  runUntil(simulation, 50);
  const firstAfter50Ms = enemyWorldPosition([...simulation.enemies][0]);
  runUntil(simulation, 250);
  assert.deepEqual(enemyWorldPosition([...simulation.enemies][1]), firstAfter50Ms);
  runUntil(simulation, 425);
  assert.deepEqual([...simulation.enemies].map(({ kind, hp, wallDamage, contactDamage, spawnedAtMs }) =>
    [kind, hp, wallDamage, contactDamage, spawnedAtMs]), [
    ["armored", 14, 2, 1, 0], ["normal", 7, 2, 1, 200], ["armored", 14, 2, 1, 400],
  ]);
  assert.deepEqual(events.filter(({ event }) => event.type === "targetSelected")
    .map(({ metadata }) => metadata.enemyKind), ["armored", "normal", "armored"]);
  assertTypesAccounted(simulation.getWaveMetrics(1));
});

test("an unchanged merged level-two tower deals two real hits to normal and three to armor", (t) => {
  const { simulation, events } = scenario({ tower: true });
  assert.equal(simulation.requestWave(1, order(2), armorPlan([1], 2_000)), 2);
  runUntil(simulation, 8_000);
  const wave = simulation.getWaveMetrics(1);
  const { normal, armored } = wave.enemyKinds;
  assert.equal(normal.towerKills, 1);
  assert.equal(armored.towerKills, 1);
  assert.equal(normal.averageTowerHitsOnKill, 2);
  assert.equal(armored.averageTowerHitsOnKill, 3);
  const extraExposureMs = armored.averageTowerExposureToKillMs - normal.averageTowerExposureToKillMs;
  assert.ok(Math.abs(extraExposureMs - 300) < 1e-6);
  const shots = events.filter(({ event }) => event.type === "towerShot");
  assert.deepEqual(shots.map(({ event, metadata }) => [metadata.enemyKind, event.damage]), [
    ["normal", 5], ["normal", 2], ["armored", 5], ["armored", 5], ["armored", 4],
  ]);
  assert.deepEqual(events.filter(({ event }) => event.type === "towerKill").map(({ event }) => event.enemyId), [1, 2]);
  assertTypesAccounted(wave);
  t.diagnostic(JSON.stringify({
    normal: { hits: normal.averageTowerHitsOnKill, exposureMs: normal.averageTowerExposureToKillMs },
    armored: { hits: armored.averageTowerHitsOnKill, exposureMs: armored.averageTowerExposureToKillMs },
  }));
});

test("armor doesn't change wall impact or physical contact damage", () => {
  const walled = scenario({ wall: true });
  assert.equal(walled.simulation.requestWave(1, order(2), armorPlan([1])), 2);
  runUntil(walled.simulation, 5_000);
  const { normal, armored } = walled.simulation.getWaveMetrics(1).enemyKinds;
  assert.deepEqual([normal.wallImpacts, armored.wallImpacts], [1, 1]);
  assert.equal(walled.map.getBuilding(gate).hp, 21);
  const impacts = walled.events.filter(({ event }) => event.type === "wallImpact");
  assert.deepEqual(impacts.map(({ event, metadata }) => [metadata.enemyKind, event.damage]), [["normal", 2], ["armored", 2]]);
  assert.equal(walled.simulation.spawnCounts.removed, 2);

  const open = scenario();
  assert.equal(open.simulation.requestWave(1, order(2), armorPlan([1])), 2);
  runUntil(open.simulation, 2_000, attack);
  const contacts = open.events.filter(({ event }) => event.type === "playerHit");
  assert.deepEqual(contacts.map(({ event, metadata }) => [metadata.enemyKind, event.damage]), [["normal", 1], ["armored", 1]]);
  assert.ok(contacts.every(({ metadata }) => metadata.contact.collisionDistance <= metadata.contact.allowedRange + 1e-6));
  assertTypesAccounted(open.simulation.getWaveMetrics(1));
});

test("invalid armor can't enqueue and cleanup preserves the kind-specific cohort", () => {
  const { simulation } = scenario();
  for (const slots of [[-1], [3], [0, 0], [2, 1]]) {
    assert.equal(simulation.requestWave(1, order(3), armorPlan(slots)), 0);
  }
  assert.equal(simulation.requestWave(1, order(3), armorPlan([1], 200, 7)), 0);
  assert.deepEqual(simulation.waveMetrics, []);
  assert.equal(simulation.requestWave(1, { ...order(1), enemyHp: 4 }), 1);
  assert.equal(simulation.requestWave(2, order(3), armorPlan([0, 2])), 3);
  runUntil(simulation, 250);
  assert.deepEqual([...simulation.enemies].map(({ waveId, kind, hp }) => [waveId, kind, hp]),
    [[1, "normal", 4], [2, "armored", 14]]);
  const initial = simulation.getWaveMetrics(2).enemyKinds;
  simulation.clearBattle();
  const wave = simulation.getWaveMetrics(2);
  const { normal, armored } = wave.enemyKinds;
  assert.deepEqual([normal.cancelledPending, armored.cancelledPending, armored.cancelledActive], [1, 1, 1]);
  assert.equal(initial.armored.active, 1);
  assert.equal(initial.armored.cancelledActive, 0, "A readback snapshot must not change when the round ends");
  assertTypesAccounted(wave);
  simulation.reset();
  assert.deepEqual(simulation.waveMetrics, []);
});

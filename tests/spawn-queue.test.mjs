import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_LAYOUT, DEFENSE_TARGET, ENEMY_ENTRY } from "../src/defense-map.ts";
import { DEFENSE_CONFIG, DefenseSimulation, enemyPosition, sameCell } from "../src/defense-simulation.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const gate = { col: 11, row: 89 };
const gateApproach = { col: 11, row: 90 };
const { spawnIntervalMs, travelMs } = DEFENSE_CONFIG;

function openGate(map) {
  assert.equal(map.applyDigDamage(gateApproach, gate, MINING_CONFIG.dirtMaxHp).cleared, true);
}

function createSimulation({ gateOpen = true } = {}) {
  const map = new TerrainMap(DEFENSE_LAYOUT);
  if (gateOpen) openGate(map);
  const simulation = new DefenseSimulation(map, ENEMY_ENTRY, DEFENSE_TARGET);
  return { map, simulation };
}

function assertSpawns(simulation, requested, spawned, removed = 0) {
  assert.deepEqual(simulation.spawnCounts, { requested, spawned, pending: requested - spawned, removed });
  assert.equal([...simulation.enemies].length, spawned - removed);
}

for (const count of [1, 10, 50, 100]) {
  test(`queues and releases ${count} enemies in order from the fixed entry`, () => {
    const { simulation } = createSimulation();
    assert.equal(simulation.requestSpawn(count, 1), count);
    assertSpawns(simulation, count, 1);
    assert.deepEqual([...simulation.enemies][0].cell, ENEMY_ENTRY);

    for (let released = 1; released < count; released += 1) {
      simulation.step(spawnIntervalMs - 1);
      assertSpawns(simulation, count, released);
      simulation.step(1);
      assertSpawns(simulation, count, released + 1);
      const atEntry = [...simulation.enemies].filter((enemy) => sameCell(enemy.cell, ENEMY_ENTRY));
      assert.equal(atEntry.length, 1);
      assert.equal(atEntry[0].move, undefined);
      assert.equal(atEntry[0].spawnedAtMs, released * spawnIntervalMs);
    }

    const enemies = [...simulation.enemies];
    assert.deepEqual(enemies.map((enemy) => enemy.spawnedAtMs), Array.from({ length: count }, (_, i) => i * spawnIntervalMs));
    if (count === 10) {
      const rows = enemies.map((enemy) => enemyPosition(enemy).y);
      for (let i = 1; i < rows.length; i += 1) {
        assert.ok(Math.abs((rows[i] - rows[i - 1]) * TILE_SIZE - 32) < 1e-6, "queued unit markers must be visibly separated");
      }
    }
  });
}

test("a sealed route holds the queue behind the first enemy and resumes without burst releases", () => {
  const { map, simulation } = createSimulation({ gateOpen: false });
  simulation.requestSpawn(10, 1);
  const wait = spawnIntervalMs * 20;
  simulation.step(wait);
  assertSpawns(simulation, 10, 1);
  assert.ok([...simulation.enemies][0].unreachable);

  openGate(map);
  simulation.step(travelMs - 1);
  assertSpawns(simulation, 10, 1);
  simulation.step(1);
  assertSpawns(simulation, 10, 2);
  assert.equal([...simulation.enemies][1].spawnedAtMs, wait + travelMs);
  simulation.step(spawnIntervalMs - 1);
  assertSpawns(simulation, 10, 2);
  simulation.step(1);
  assertSpawns(simulation, 10, 3);
  simulation.step(wait);
  assertSpawns(simulation, 10, 4);
});

test("a physically blocked entry retains requests until the blocking building is removed", () => {
  const { map, simulation } = createSimulation();
  const blocker = map.placeBuilding("wall", ENEMY_ENTRY);
  assert.ok(blocker);
  assert.equal(simulation.requestSpawn(2, 1), 2);
  assertSpawns(simulation, 2, 0);
  simulation.step(spawnIntervalMs * 2);
  assertSpawns(simulation, 2, 0);

  assert.equal(map.removeBuilding(ENEMY_ENTRY)?.id, blocker.id);
  simulation.step(1);
  assertSpawns(simulation, 2, 1);
  assert.deepEqual([...simulation.enemies][0].cell, ENEMY_ENTRY);
  simulation.step(spawnIntervalMs);
  assertSpawns(simulation, 2, 2);
});

test("queued requests preserve release order and each batch's wall damage", () => {
  const { simulation } = createSimulation();
  simulation.requestSpawn(2, 1);
  simulation.requestSpawn(3, 5);
  assertSpawns(simulation, 5, 1);
  for (let i = 0; i < 4; i += 1) simulation.step(spawnIntervalMs);
  assertSpawns(simulation, 5, 5);
  assert.deepEqual([...simulation.enemies].map((enemy) => enemy.wallDamage), [1, 1, 5, 5, 5]);
});

test("50 queued enemies remain accounted for after exactly ten lethal wall impacts", () => {
  const { map, simulation } = createSimulation();
  assert.ok(map.placeBuilding("wall", { col: 11, row: 87 }, 50));
  simulation.requestSpawn(50, 5);
  for (let elapsed = 0; elapsed <= 50 * spawnIntervalMs; elapsed += 50) simulation.step(50);
  assertSpawns(simulation, 50, 50, 10);
  assert.equal(simulation.counters.wallImpacts, 10);
  assert.equal(simulation.counters.wallsDestroyed, 1);
  assert.equal(simulation.counters.towerKills, 0);
});

test("100 queued enemies remain accounted for after real tower removals", () => {
  const { map, simulation } = createSimulation();
  assert.ok(map.placeBuilding("tower", { col: 12, row: 94 }, 1));
  simulation.requestSpawn(100, 1);
  for (let elapsed = 0; elapsed <= 100 * spawnIntervalMs; elapsed += 50) simulation.step(50);
  const { towerKills, wallImpacts } = simulation.counters;
  assert.ok(towerKills > 0);
  assert.equal(wallImpacts, 0);
  assertSpawns(simulation, 100, 100, towerKills);
});

test("reset drops stale pending enemies and restarts counts and release timing", () => {
  const { simulation } = createSimulation();
  simulation.requestSpawn(10, 1);
  simulation.step(spawnIntervalMs);
  assertSpawns(simulation, 10, 2);

  simulation.reset();
  assertSpawns(simulation, 0, 0);
  simulation.step(spawnIntervalMs * 12);
  assertSpawns(simulation, 0, 0);
  assert.equal(simulation.requestSpawn(1, 2), 1);
  assertSpawns(simulation, 1, 1);
  assert.equal([...simulation.enemies][0].spawnedAtMs, spawnIntervalMs * 12);
});

test("explicit simultaneous fixture spawning remains available and is counted with queued spawning", () => {
  const { simulation } = createSimulation();
  assert.equal(simulation.spawn(2, 2), 2);
  assert.deepEqual([...simulation.enemies].map((enemy) => enemy.spawnedAtMs), [0, 0]);
  assert.equal(simulation.requestSpawn(1, 5), 1);
  assert.equal(simulation.requestSpawn(0, 5), 0);
  assert.equal(simulation.requestSpawn(4, Number.NaN), 0);
  assertSpawns(simulation, 3, 2);
  simulation.step(spawnIntervalMs);
  assertSpawns(simulation, 3, 3);
});

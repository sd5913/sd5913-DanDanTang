import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_CONFIG, DefenseSimulation, enemyWorldPosition } from "../src/defense-simulation.ts";
import { ENEMY_RADIUS } from "../src/enemy-contact.ts";
import { GENERATED_ENEMY_ENTRY } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";

const entry = GENERATED_ENEMY_ENTRY;
const exit = { col: entry.col, row: entry.row - 1 };
const goal = { col: entry.col, row: 4 };
const wall = { col: entry.col, row: 70 };
const tower = { col: entry.col + 2, row: 78 };
const tickMs = 25;
const order = (count) => ({ count, enemyHp: 7, wallDamage: 2, contactDamage: 1 });

function scenario({ sealed = false, defense = false } = {}) {
  const layout = Array.from({ length: 96 }, (_, row) => Array.from({ length: 40 }, (_, col) => {
    if (row === entry.row && col === entry.col - 1) return "S";
    if (row === goal.row && col === goal.col) return "G";
    if (row === exit.row && col === exit.col && sealed) return "+";
    if (row === tower.row && col === tower.col && defense) return ".";
    return col === entry.col && row > goal.row && row <= entry.row ? "." : "#";
  }).join(""));
  const map = new TerrainMap(layout);
  if (defense) {
    assert.ok(map.placeBuilding("wall", wall, 100));
    assert.ok(map.placeBuilding("tower", tower));
  }
  const simulation = new DefenseSimulation(map, entry, goal, undefined, true);
  return { map, simulation };
}

function simulateDeployment(deployment) {
  const { simulation } = scenario({ defense: true });
  assert.equal(simulation.requestWave(1, order(20), deployment), 20);
  const seen = new Map();
  let overlaps = 0;
  while (simulation.elapsedMs <= 10_000) {
    const enemies = [...simulation.enemies];
    for (const enemy of enemies) {
      if (!seen.has(enemy.id)) seen.set(enemy.id, enemy.spawnedAtMs);
    }
    const positions = enemies.map(enemyWorldPosition);
    for (const [index, one] of positions.entries()) {
      for (let other = index + 1; other < positions.length; other += 1) {
        const two = positions[other];
        if (Math.hypot(one.x - two.x, one.y - two.y) < 2 * ENEMY_RADIUS) overlaps += 1;
      }
    }
    if (simulation.getWaveMetrics(1).settledAtMs !== null) break;
    simulation.step(tickMs);
  }
  assert.deepEqual([...seen.keys()], Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(overlaps, 0, "The straight approach never draws overlapping enemy bodies");
  assert.deepEqual(simulation.spawnCounts, { requested: 20, spawned: 20, pending: 0, removed: 20 });
  return { times: [...seen.values()], metrics: simulation.getWaveMetrics(1) };
}

test("a single southern entry enforces real spacing for fixed and burst deployments", () => {
  const cases = [
    { deployment: undefined, gap: 200, blockedMs: 0 },
    { deployment: { intervalMs: 150 }, gap: 150, blockedMs: 0 },
    { deployment: { intervalMs: 100 }, gap: 150, blockedMs: 19 * 50 },
    { deployment: { intervalMs: 100, burst: { count: 8, pauseMs: 300 } }, gap: 150, blockedMs: 17 * 50 },
  ];
  for (const { deployment, gap, blockedMs } of cases) {
    const { times, metrics } = simulateDeployment(deployment);
    assert.deepEqual(times.map((time, index) => index === 0 ? time : time - times[index - 1]),
      times.map((_, index) => index === 0 ? 0 : deployment?.burst && index % deployment.burst.count === 0
        ? deployment.burst.pauseMs : gap));
    assert.equal(metrics.plannedSpawnIntervalMs, deployment?.intervalMs ?? DEFENSE_CONFIG.spawnIntervalMs);
    assert.equal(metrics.lastSpawnAtMs, times.at(-1));
    assert.equal(metrics.actualSpawnsPerSecond, 19 * 1_000 / times.at(-1));
    assert.equal(metrics.entryBlockedMs, blockedMs);
    assert.equal(metrics.entryTerrainBlocks, 0);
    assert.equal(metrics.entryOccupancyBlocks > 0, blockedMs > 0);
    assert.equal(metrics.spawnedPerSecond.reduce((total, bucket) => total + bucket.count, 0), 20);
    assert.equal(metrics.towerEntriesPerSecond.reduce((total, bucket) => total + bucket.count, 0), metrics.towerExposed);
    assert.ok(metrics.towerExposed > 0 && metrics.firstTowerExposureAtMs > metrics.firstSpawnAtMs);
    assert.ok(metrics.wallImpacts > 0 && metrics.firstWallImpactAtMs > metrics.firstTowerExposureAtMs);
    assert.equal(metrics.wallImpacts + metrics.towerKills, 20);
    assert.ok(metrics.peakActive > 1 && metrics.peakActive <= 20);
  }
});

test("a blocked earlier request keeps its own deployment ahead of a later wave", () => {
  const { map, simulation } = scenario({ sealed: true });
  const first = { intervalMs: 100 };
  assert.equal(simulation.requestWave(1, order(3), first), 3);
  first.intervalMs = 2_000;
  for (let elapsed = 0; elapsed < 200; elapsed += tickMs) simulation.step(tickMs);
  assert.equal(simulation.requestWave(2, order(2), { intervalMs: 200 }), 2);
  const blocked = simulation.getWaveMetrics(1);
  assert.deepEqual(simulation.spawnCounts, { requested: 5, spawned: 1, pending: 4, removed: 0 });
  assert.equal(blocked.entryBlockedMs, 100);
  assert.equal(simulation.getWaveMetrics(2).entryBlockedMs, 0);
  assert.deepEqual(simulation.getWaveMetrics(2).spawnedPerSecond, []);

  assert.ok(map.applyDigDamage(entry, exit, 100).cleared);
  for (let elapsed = 0; elapsed < 800; elapsed += tickMs) simulation.step(tickMs);
  assert.deepEqual([...simulation.enemies].map(({ waveId, spawnedAtMs }) => [waveId, spawnedAtMs]),
    [[1, 0], [1, 350], [1, 500], [2, 650], [2, 850]]);
  assert.equal(simulation.getWaveMetrics(1).entryBlockedMs, 300);
  assert.equal(simulation.getWaveMetrics(2).entryBlockedMs, 50);
  assert.equal(blocked.entryBlockedMs, 100, "A report already read remains immutable");
  assert.deepEqual(blocked.spawnedPerSecond, [{ second: 0, count: 1 }]);

  simulation.reset();
  assert.deepEqual(simulation.waveMetrics, []);
  assert.equal(simulation.requestWave(1, order(2)), 2);
  for (let elapsed = 0; elapsed < 200; elapsed += tickMs) simulation.step(tickMs);
  assert.equal(simulation.getWaveMetrics(1).lastSpawnAtMs, 200, "Reset restores the default interval");
});

test("entry terrain blocks remain distinct from occupied entry and invalid plans cannot create a cohort", () => {
  const { map, simulation } = scenario();
  assert.equal(simulation.requestWave(1, order(2), { intervalMs: 0 }), 0);
  assert.equal(simulation.requestWave(1, order(2), { intervalMs: 100, burst: { count: 0, pauseMs: 300 } }), 0);
  assert.deepEqual(simulation.waveMetrics, []);
  assert.ok(map.placeBuilding("wall", entry));
  assert.equal(simulation.requestWave(1, order(2), { intervalMs: 150 }), 2);
  for (let elapsed = 0; elapsed < 200; elapsed += tickMs) simulation.step(tickMs);
  const blocked = simulation.getWaveMetrics(1);
  assert.equal(blocked.entryBlockedMs, 200);
  assert.equal(blocked.entryOccupancyBlocks, 0);
  assert.ok(blocked.entryTerrainBlocks > 0);
  assert.equal(blocked.spawned, 0);
  assert.equal(blocked.pending, 2);
  assert.ok(map.removeBuilding(entry));
  simulation.step(tickMs);
  assert.equal(simulation.getWaveMetrics(1).firstSpawnAtMs, 225);
  assert.equal(simulation.getWaveMetrics(1).entryBlockedMs, 225);
  assert.deepEqual(blocked.spawnedPerSecond, []);
});

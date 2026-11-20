import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_CONFIG } from "../src/defense-simulation.ts";
import { runMidgameDensity } from "./midgame-density.mjs";

test("matched cadence experiments retain one legal south entry and measure its throughput", () => {
  const { rows } = runMidgameDensity();
  assert.equal(rows.length, 12);
  const southern = rows.filter(({ defense }) => defense === "south-two-towers");
  const cohorts = Object.fromEntries(southern.map(({ cadence, waves }) => [cadence, waves[1]]));
  const original = cohorts["fixed-200"];
  const faster = cohorts["fixed-150"];
  const occupied = cohorts["fixed-100"];
  const bursting = cohorts["burst-100"];
  assert.equal(original.actualSpawnRate, 5);
  assert.equal(original.entryBlockedMs, 0);
  assert.equal(faster.actualSpawnRate, 1_000 / DEFENSE_CONFIG.travelMs);
  assert.equal(faster.entryBlockedMs, 0);
  assert.equal(occupied.actualSpawnRate, faster.actualSpawnRate);
  assert.ok(occupied.entryBlockedMs > 0);
  assert.ok(occupied.entryOccupancyBlocks > 0);
  assert.ok(bursting.actualSpawnRate < occupied.actualSpawnRate);
  assert.ok(bursting.spawnTimes.some((at, i, all) => i > 0 && at - all[i - 1] >= 400));
  assert.ok(bursting.spawnTimes.some((at, i, all) => i > 0 && at - all[i - 1] === DEFENSE_CONFIG.travelMs));

  for (const row of rows) {
    const reference = rows.find(({ defense, cadence }) => defense === row.defense && cadence === "fixed-200");
    assert.equal(row.seed, reference.seed);
    assert.deepEqual(row.startingBuildings, reference.startingBuildings);
    assert.equal(row.spawnCounters.spawned, row.waves.reduce((total, wave) => total + wave.spawned, 0));
    for (const wave of row.waves) {
      const matched = reference.waves.find(({ waveId }) => waveId === wave.waveId);
      if (matched) assert.deepEqual(wave.order, matched.order);
      assert.equal(wave.plannedSpawnIntervalMs, row.deployment.intervalMs);
      assert.equal(wave.overlapAtEntrySamples, 0);
      assert.equal(wave.entryTerrainBlocks, 0);
      if (wave.spawned > 1) assert.equal(wave.actualSpawnRate, wave.actualSpawnsPerSecond);
      assert.equal(wave.spawnTimes.length, wave.spawned);
      assert.equal(wave.spawnedPerSecond.reduce((sum, bin) => sum + bin.count, 0), wave.spawned);
      assert.equal(wave.towerEntriesPerSecond.reduce((sum, bin) => sum + bin.count, 0), wave.towerExposed);
      if (wave.wallImpacts > 0) assert.equal(wave.firstWallImpactAtMs, wave.firstWallAtMs);
    }
  }
});

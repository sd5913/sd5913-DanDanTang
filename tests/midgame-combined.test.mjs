import assert from "node:assert/strict";
import test from "node:test";
import { runMidgameCombined } from "./midgame-combined.mjs";

test("matched midgame profiles exercise dense mixed waves and real late defensive outcomes", () => {
  const { runs } = runMidgameCombined();
  assert.equal(runs.length, 32);
  for (const run of runs) {
    const original = runs.find(({ name, long, profile }) => name === run.name && long === run.long && profile === "control");
    assert.deepEqual(run.startingBuildings, original.startingBuildings);
    for (const wave of run.waves) {
      assert.equal(wave.spawned + wave.pending + wave.cancelledPending, wave.planned);
      assert.equal(wave.enemyKinds.armored.spawned + wave.enemyKinds.normal.spawned, wave.spawned);
      assert.equal(wave.spawnTimes.length, wave.spawned);
      assert.equal(wave.overlapAtEntrySamples, 0);
      if (wave.waveId <= 2) {
        assert.equal(wave.plannedSpawnIntervalMs, 200);
        assert.equal(wave.enemyKinds.armored.planned, 0);
      }
    }
    assert.ok(run.final.uncoveredApproachCells >= 0 && run.final.uncoveredApproachCells <= run.final.approachCells);
  }
  const combined = runs.filter(({ profile }) => profile === "combined");
  assert.ok(combined.some(({ waves }) => waves.some(({ waveId, wallImpacts }) => waveId >= 3 && wallImpacts > 0)));
  assert.ok(combined.some(({ waves }) => waves.some(({ waveId, towerKills }) => waveId === 10 && towerKills > 0)));
  assert.ok(combined.some(({ waves }) => waves.some(({ waveId, enemyKinds }) =>
    waveId >= 6 && enemyKinds.armored.spawned > 0 && enemyKinds.normal.spawned > 0)));
});

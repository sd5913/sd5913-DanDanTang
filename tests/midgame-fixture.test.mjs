import assert from "node:assert/strict";
import test from "node:test";
import { GENERATED_ENEMY_ENTRY } from "../src/generated-map.ts";
import { runMidgameFixture } from "./midgame-fixture.mjs";

test("unchanged Challenge control reproduces steady income and an untouched mature southern defense", () => {
  const run = runMidgameFixture();
  assert.deepEqual(run.entry, GENERATED_ENEMY_ENTRY);
  const originalTowers = run.startingBuildings.filter(({ kind, level }) => kind === "tower" && level === 2);
  const originalTowerIds = new Set(originalTowers.map(({ id }) => id));
  assert.equal(originalTowers.length, 2);
  assert.equal(run.startingBuildings.filter(({ kind }) => kind === "economy").length, 4);
  const originalWall = run.startingBuildings.find(({ kind }) => kind === "wall");
  assert.deepEqual(run.waves.map(({ planned }) => planned), [8, 16, 24, 34, 46, 60, 74, 88, 102, 116]);
  for (const wave of run.waves) {
    assert.equal(wave.spawned, wave.planned);
    assert.equal(wave.towerKills, wave.spawned);
    assert.equal(wave.towerExposed, wave.spawned);
    assert.equal(wave.exposureSamples, wave.towerExposed);
    assert.equal(wave.actualSpawnRate, 5);
    assert.equal(wave.pending, 0);
    assert.equal(wave.overlapAtEntrySamples, 0);
    assert.equal(wave.entryBlockSampleMs, 0);
    assert.equal(wave.wallImpacts, 0);
    assert.equal(wave.firstWallAtMs, null);
    assert.equal(wave.playerDamage, 0);
    assert.ok(wave.peakActive > 0);
    assert.equal(Object.values(wave.towerEntrantsPerSecond).reduce((sum, count) => sum + count, 0), wave.towerExposed);
    assert.equal(wave.attackEnd.wallHp, originalWall.hp);
    assert.ok(Object.keys(wave.shotsByTower).every((id) => originalTowerIds.has(id)));
  }
  assert.equal(run.final.playerHp, 4);
  assert.equal(run.final.toolLevel, 2);
  assert.equal(run.final.buildings.towerLevel2, 2);
  const { totals, cards } = run.final;
  assert.equal(totals.balance, totals.miningIncome + totals.killIncome + totals.productionIncome
    - totals.cardSpend - totals.technologySpend - totals.researchSpend);
  assert.equal(totals.cardSpend, 3 * totals.cardsMade);
  assert.equal(run.transactions.filter(({ kind }) => kind === "craft").length, totals.cardsMade);
  assert.ok(totals.productionIncome > totals.cardSpend * 5);
  assert.ok(Object.values(cards).reduce((sum, count) => sum + count, 0) > run.final.legalNearbySlots);
  assert.equal(run.intervals.reduce((sum, interval) => sum + interval.income - interval.spending, 0), totals.balance);

  // Remove all paid rear placements. The exact two-tower defense is unchanged.
  const hold = runMidgameFixture({ spending: "none" });
  assert.equal(hold.final.buildings.tower, 2);
  const defense = ({ waves }) => waves.map(({ spawnTimes, towerEntrantsPerSecond, shotsByTower, wallImpacts }) => ({
    spawnTimes, towerEntrantsPerSecond, shotsByTower, wallImpacts,
  }));
  assert.deepEqual(defense(run), defense(hold));
});

test("real map travel changes later cohorts and a two-tower array can fall after entering level-two territory", () => {
  const run = runMidgameFixture({ stage: 1, long: true, spending: "none", stageAfterWave: 2 });
  assert.deepEqual(run.waves.map(({ order }) => order.enemyHp), [4, 4, 7, 7, 7]);
  assert.equal(run.final.stage, 1);
  assert.ok(run.waves[2].wallImpacts > 0);
  assert.ok(run.waves.some(({ losses }) => losses.some(({ kind }) => kind === "wall")));
  assert.ok(run.defeatAtMs > 0);
  assert.equal(run.final.playerHp, 0);
});

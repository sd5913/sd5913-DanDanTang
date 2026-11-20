import assert from "node:assert/strict";
import test from "node:test";
import { DIFFICULTY_PROFILES } from "../src/expedition-difficulty.ts";
import { ECONOMY_PROTOTYPE } from "../src/expedition-economy.ts";
import { replayDifficultyScenario, runDifficultyMatrix } from "./h-difficulty-matrix.mjs";

const matrix = runDifficultyMatrix();
const sum = (items, select) => items.reduce((total, item) => total + select(item), 0);

test("H-E uses four distinctly measured maps and the same slate of input for each profile", () => {
  const [reference, short, detour, rocky] = matrix.seeds;
  assert.equal(reference.seed, 12);
  assert.equal(new Set(matrix.seeds.map(({ fingerprint }) => fingerprint)).size, 4);
  assert.ok(matrix.seeds.filter((map) => map !== short).every((map) => short.estimatedTravelAndMiningMs < map.estimatedTravelAndMiningMs));
  assert.ok(matrix.seeds.filter((map) => map !== detour).every((map) => detour.shortestCarvableSteps > map.shortestCarvableSteps));
  assert.ok(matrix.seeds.filter((map) => map !== rocky).every((map) => rocky.interiorRocks > map.interiorRocks));
  assert.equal(matrix.scripts.length, 24);
  assert.equal(matrix.cases.length, 72);
  for (const { seed, strategy, clock, digest, actions, geometry } of matrix.scripts) {
    const trials = matrix.cases.filter((run) => run.seed === seed && run.strategy === strategy && run.clock === clock);
    assert.deepEqual(trials.map(({ profile }) => profile), ["baseline", "a", "b"]);
    assert.ok(trials.every((run) => run.inputDigest === digest && run.fingerprint === matrix.seeds.find((map) => map.seed === seed).fingerprint));
    assert.ok(trials.every((run) => run.failures.length === 0), JSON.stringify(trials.flatMap((run) => run.failures)));
    if (strategy === "no-defense") {
      assert.ok(actions.every(({ type }) => ["move", "wait"].includes(type)));
    } else {
      assert.deepEqual(actions.filter(({ type }) => type === "place").map(({ kind }) => kind).sort(),
        ["economy", "tower", "tower", "wall"]);
      assert.equal(actions.filter(({ type }) => type === "research").length, 1);
      assert.equal(actions.filter(({ type }) => type === "draw").length, 2);
    }
    if (strategy === "tunnel") {
      assert.equal(geometry.startingEntryRoute, 13);
      assert.equal(geometry.approachSteps, 23);
    }
  }
  for (const accelerated of matrix.scripts.filter(({ clock }) => clock === "wait-test")) {
    const normal = matrix.scripts.find((script) => script.seed === accelerated.seed && script.strategy === accelerated.strategy && script.clock === "normal");
    const withoutIdle = (script) => script.actions.filter(({ type }) => type !== "wait");
    assert.deepEqual(withoutIdle(normal), withoutIdle(accelerated));
  }
});

test("H-E real model produces victories and defeats for every profile with either clock", () => {
  for (const clock of ["normal", "wait-test"]) {
    for (const profile of ["baseline", "a", "b"]) {
      const runs = matrix.cases.filter((run) => run.clock === clock && run.profile === profile);
      const wins = runs.filter(({ outcome }) => outcome === "won");
      const losses = runs.filter(({ outcome }) => outcome === "lost");
      assert.equal(wins.length + losses.length, runs.length, "Every replay must reach a terminal outcome");
      for (const { seed } of matrix.seeds) {
        assert.equal(runs.find((run) => run.seed === seed && run.strategy === "basic")?.outcome, "won");
        assert.equal(runs.find((run) => run.seed === seed && run.strategy === "no-defense")?.outcome, "lost");
      }
      for (const run of wins) {
        assert.ok(run.player.hp > 0);
        assert.equal(run.player.stage, 2);
        assert.ok(run.wave >= 1);
        assert.ok(run.elapsedMs > (clock === "normal" ? DIFFICULTY_PROFILES[profile].normal.preparingMs : 2_500));
        assert.equal(run.economy.researchSpend, 10);
      }
      for (const run of losses) {
        assert.equal(run.player.hp, 0);
        assert.ok(Number.isFinite(run.firstPlayerDamageAtMs));
        assert.ok(run.firstPlayerDamageAtMs >= run.firstSpawnAtMs);
        assert.equal(sum(run.waves, ({ playerDamage }) => playerDamage), 4);
      }
    }
  }
});

test("H-E authentic cohort, damage and economy counters reconcile for every run", () => {
  for (const run of matrix.cases) {
    const profile = DIFFICULTY_PROFILES[run.profile];
    const first = run.waves[0];
    assert.equal(first.order.issuedAtMs, run.clock === "normal" ? profile.normal.preparingMs : 2_500);
    assert.equal(sum(run.waves, ({ planned }) => planned), run.spawnTotals.requested);
    assert.equal(sum(run.waves, ({ spawned }) => spawned), run.spawnTotals.spawned);
    assert.equal(sum(run.waves, ({ towerKills }) => towerKills), run.counters.towerKills);
    assert.equal(sum(run.waves, ({ wallImpacts }) => wallImpacts), run.counters.wallImpacts);
    assert.equal(run.economy.balance, ECONOMY_PROTOTYPE.initialBalance + run.economy.killIncome + run.economy.productionIncome
      - run.economy.cardSpend - run.economy.researchSpend);
    for (const wave of run.waves) {
      const { enemyHp, wallDamage, contactDamage } = profile.stages[wave.order.stage];
      assert.equal(wave.order.enemyHp, enemyHp);
      assert.equal(wave.order.wallDamage, wallDamage);
      assert.equal(wave.order.contactDamage, contactDamage);
      assert.equal(wave.planned, wave.order.count);
      assert.equal(wave.planned, wave.spawned + wave.pending + wave.cancelledPending);
      assert.equal(wave.spawned, wave.active + wave.cancelledActive + wave.wallImpacts + wave.playerContacts + wave.towerKills);
      assert.ok(wave.peakActive >= wave.active && wave.peakActive <= wave.spawned);
      assert.ok(run.peakActiveSampled >= wave.active);
      assert.equal(wave.economy.waveId, wave.waveId);
      assert.equal(wave.economy.cohortKillIncome, wave.towerKills * ECONOMY_PROTOTYPE.towerKillReward);
      assert.equal(wave.economy.net, wave.economy.killIncome + wave.economy.productionIncome
        - wave.economy.cardSpend - wave.economy.researchSpend);
    }
    const economies = [run.preWaveEconomy, ...run.waves.map(({ economy }) => economy)];
    for (const field of ["killIncome", "productionIncome", "cardsMade", "cardSpend", "researchSpend"]) {
      assert.equal(sum(economies, (period) => period[field]), run.economy[field]);
    }
  }
});

test("H-E seed 12 demonstrates real, seed-matched space and HP differences", () => {
  const find = (profile, strategy) => matrix.cases.find((run) =>
    run.clock === "normal" && run.seed === 12 && run.profile === profile && run.strategy === strategy);
  const damage = (run) => sum(run.waves, ({ wallDamage, buildingDamage }) => wallDamage + buildingDamage);
  let delayedDamagePairs = 0;
  for (const profile of ["baseline", "a", "b"]) {
    const basic = find(profile, "basic");
    const tunnel = find(profile, "tunnel");
    assert.ok(Number.isFinite(basic.firstThreatAtMs) && Number.isFinite(tunnel.firstThreatAtMs));
    assert.ok(tunnel.firstThreatAtMs > basic.firstThreatAtMs);
    assert.ok(Number.isFinite(basic.firstBuildingDamageAtMs));
    if (tunnel.firstBuildingDamageAtMs === null) {
      assert.equal(damage(tunnel), 0, "An absent first hit means the plan avoided all building damage");
    } else {
      assert.ok(tunnel.firstBuildingDamageAtMs > basic.firstBuildingDamageAtMs);
      delayedDamagePairs += 1;
    }
    assert.ok(damage(tunnel) < damage(basic));
  }
  assert.ok(delayedDamagePairs > 0, "At least one matched pair must measure delayed damage");
  const [a] = find("a", "tunnel").waves;
  const [b] = find("b", "tunnel").waves;
  assert.equal(a.planned, b.planned);
  assert.ok(a.towerKills > b.towerKills && b.towerKills > 0);
  assert.ok(b.averageTowerHitsOnKill > a.averageTowerHitsOnKill, "Stronger B units take more tower hits in the same first cohort");
});

test("H-E replay matches a full run apart from host execution time", () => {
  const script = matrix.scripts.find((item) => item.clock === "wait-test" && item.seed === 12 && item.strategy === "tunnel");
  const original = matrix.cases.find((item) => item.inputDigest === script.digest && item.profile === "b");
  const deterministic = ({ modelPerformance: { navigationSearches }, ...data }) => ({ navigationSearches, ...data });
  assert.deepEqual(deterministic(replayDifficultyScenario(script, "b")), deterministic(original));
});

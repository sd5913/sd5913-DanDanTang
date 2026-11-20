import assert from "node:assert/strict";
import test from "node:test";
import { ECONOMY_PROTOTYPE, toEconomyTenths } from "../src/expedition-economy.ts";
import { DEFAULT_MAP_SEED } from "../src/generated-map.ts";
import { replayChallengeFunding, replayChallengeResearch, replayOpeningBattle, replayOpeningStrategies } from "./challenge-opening.mjs";

const sessions = replayOpeningStrategies();
const find = (difficulty, strategy) => sessions.find((run) => run.difficulty === difficulty && run.strategy === strategy);
const isDefense = (card) => card === "wall" || card === "tower";

test("generated maps fund three real paid Challenge draws from legal starter excavation", () => {
  for (const seed of [0, 9, 12, 512, 1091, DEFAULT_MAP_SEED, 0xffff_ffff]) {
    const trial = replayChallengeFunding(seed);
    assert.equal(trial.effectiveSeed, seed);
    assert.equal(trial.start.totals.balance, 0);
    assert.deepEqual(trial.start.cards, { wall: 0, tower: 0, economy: 0 });
    assert.equal(trial.start.technologyHp, null);
    assert.equal(trial.start.toolLevel, 1);
    assert.ok(trial.initialStarterDirt >= 18);
    assert.equal(trial.firstIncomeAtMs, 0);
    assert.equal(trial.firstCanDrawAtMs, trial.budgets[0].atMs);
    assert.equal(trial.facility.cost, 10);
    assert.equal(trial.facility.balanceBefore, 10);
    assert.equal(trial.facility.balanceAfter, 0);
    assert.ok(trial.facility.atMs < trial.budgets[0].atMs);
    assert.deepEqual(trial.budgets.map(({ availableBefore }) => availableBefore), [3, 3, 3]);
    assert.ok(trial.budgets.some(({ card }) => isDefense(card)));
    assert.ok(trial.budgets[2].atMs < 60_000);
    assert.ok(trial.budgets[0].atMs < trial.budgets[1].atMs && trial.budgets[1].atMs < trial.budgets[2].atMs);
    assert.equal(trial.miningActions.length, 38);
    assert.ok(trial.miningActions.every(({ from, target, damage, incomeTenths }) =>
      Math.abs(from.col - target.col) + Math.abs(from.row - target.row) === 1 && damage === 5 && incomeTenths === 5));
    assert.equal(trial.finish.totals.miningIncome, 19);
    assert.equal(trial.finish.totals.technologySpend, 10);
    assert.equal(trial.finish.totals.cardSpend, 9);
    assert.equal(trial.finish.totals.killIncome, 0);
    assert.equal(trial.finish.totals.productionIncome, 0);
    assert.equal(trial.finish.totals.balance, 0);
    if (seed === 1091) {
      assert.deepEqual(trial.budgets.map(({ card }) => card), ["economy", "economy", "tower"]);
      assert.equal(trial.firstDefenseDrawAtMs, trial.budgets[2].atMs);
    }
  }
});

test("the first paid card is timely and makes early Lv.2 research a meaningful trade-off", () => {
  for (const seed of [12, 9, 512, 1091]) {
    const optimized = replayChallengeResearch(seed, 0);
    const withDeliberation = replayChallengeResearch(seed, 250);
    const exposed = replayChallengeResearch(seed, 375);
    for (const replay of [optimized, withDeliberation]) {
      assert.ok(replay.facilityAtMs < replay.cardAtMs && replay.cardAtMs < 60_000);
      assert.equal(replay.researchCost, 20);
      assert.equal(replay.income, 33);
      assert.equal(replay.toolLevel, 2);
      assert.ok(replay.researchAtMs - replay.cardAtMs > 20_000);
    }
    assert.ok(optimized.researchAtMs < 60_000, "A brisk player can prioritize research");
    assert.ok(withDeliberation.researchAtMs >= 58_000, "Deliberate excavation takes most of the preparation window");
    assert.ok(exposed.facilityAtMs < exposed.cardAtMs && exposed.cardAtMs < 60_000);
    assert.equal(exposed.firstWaveAtMs, 60_000);
    assert.equal(exposed.researchAtMs, null, "Continuing to mine without deploying the card leaves the facility exposed");
  }
});

test("a seed-matched unarmed player encounters Challenge first wave 30 seconds before Profile B", () => {
  const challenge = find("challenge", "unarmed");
  const profileB = find("b", "unarmed");
  assert.deepEqual(challenge.playerCell, profileB.playerCell);
  assert.equal(challenge.fingerprint, profileB.fingerprint);
  assert.equal(challenge.firstWave.issuedAtMs, 60_000);
  assert.equal(profileB.firstWave.issuedAtMs, 90_000);
  assert.deepEqual(challenge.firstWave.order, { count: 8, enemyHp: 4, wallDamage: 1, contactDamage: 1 });
  assert.deepEqual(profileB.firstWave.order, { ...challenge.firstWave.order, count: 10 });
  for (const run of [challenge, profileB]) {
    assert.equal(run.result, "lost");
    assert.equal(run.finish.playerHp, 0);
    assert.equal(run.firstWave.firstActualExchange.type, "playerHit");
    assert.equal(run.firstWave.combatAtEnd.playerDamage, 4);
    assert.equal(run.firstWave.earnedDuringAttack.miningShare, null);
    assert.equal(run.afterWave, null);
  }
  assert.equal(profileB.firstWave.firstActualExchange.atMs - challenge.firstWave.firstActualExchange.atMs, 30_000);
});

test("natural cards support wall-only, tower-only and mixed Challenge defense into wave two", () => {
  const wall = find("challenge", "wall");
  const tower = find("challenge", "tower");
  const mixed = find("challenge", "mixed");
  const outcomes = [wall, tower, mixed];
  assert.deepEqual(outcomes.map(({ firstWave }) => [firstWave.initialWallCount, firstWave.initialTowerCount]),
    [[1, 0], [0, 2], [1, 2]]);
  assert.equal(wall.firstWave.combatAtEnd.wallImpacts, 8);
  assert.equal(wall.firstWave.combatAtEnd.wallDamage, 8);
  assert.equal(wall.firstWave.firstAttackEnd.buildings.find(({ kind }) => kind === "wall").hp, 42);
  assert.equal(wall.firstWave.earnedDuringAttack.killShare, null);
  assert.equal(tower.firstWave.combatAtEnd.towerKills, 8);
  assert.equal(tower.firstWave.firstActualExchange.type, "towerShot");
  assert.ok(mixed.firstWave.combatAtEnd.towerKills > 0);
  assert.ok(mixed.firstWave.combatAtEnd.wallImpacts > 0);
  for (const run of outcomes) {
    assert.equal(run.facility.cost, 10);
    assert.equal(run.result, "wave-2");
    assert.equal(run.firstWave.issuedAtMs, 60_000);
    assert.equal(run.firstWave.combatAtEnd.spawned, 8);
    assert.equal(run.firstWave.firstAttackEnd.recoveryMs, 20_000);
    assert.equal(run.firstWave.firstAttackEnd.playerHp, 4);
    assert.equal(run.waves[1].order.count, 16);
    assert.equal(run.waves[1].atMs, run.firstWave.firstAttackEnd.atMs + 20_000);
    assert.ok(run.afterWave.additionalMining > 0);
    assert.ok(run.afterWave.paidCard);
    assert.ok(run.construction.every(({ kind, atMs, from, target }) => {
      const inRange = Math.max(Math.abs(from.col - target.col), Math.abs(from.row - target.row)) === 1;
      return inRange && run.draws.some((draw) => draw.card === kind && draw.atMs <= atMs);
    }));
    assert.equal(run.firstWave.earnedDuringAttack.mining, 0);
    assert.ok(run.firstWave.earnedThroughAttack.mining > 0);
    assert.equal(run.firstWave.earnedDuringAttack.kills,
      run.firstWave.combatAtEnd.towerKills * ECONOMY_PROTOTYPE.towerKillReward);
    assert.equal(toEconomyTenths(run.firstWave.entireWavePeriod.miningIncome), toEconomyTenths(run.afterWave.additionalMining));
  }
});

test("Profile B still deploys starting stock while Challenge earns matched placements and replays identically", () => {
  const challenge = find("challenge", "mixed");
  const profileB = find("b", "starting-stock");
  assert.equal(challenge.fingerprint, profileB.fingerprint);
  assert.deepEqual(challenge.construction.map(({ kind, target }) => ({ kind, target })),
    profileB.construction.map(({ kind, target }) => ({ kind, target })));
  assert.deepEqual(profileB.start.cards, { wall: 4, tower: 2, economy: 1 });
  assert.equal(profileB.start.totals.balance, 8);
  assert.equal(profileB.draws.length, 0);
  assert.ok(challenge.construction[0].atMs > profileB.construction[0].atMs);
  assert.ok(challenge.firstWave.initialBalance < profileB.firstWave.initialBalance);
  assert.deepEqual(replayOpeningBattle({ seed: 12, strategy: "mixed" }), challenge);
});

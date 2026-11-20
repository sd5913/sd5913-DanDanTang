import assert from "node:assert/strict";
import test from "node:test";
import { ECONOMY_PROTOTYPE } from "../src/expedition-economy.ts";
import { runChallengeTowerBalance } from "./challenge-tower-balance.mjs";

const comparison = runChallengeTowerBalance();
const { dispersed, merged } = comparison;

test("matched Challenge formations use only earned resources and four naturally drawn tower cards", () => {
  assert.equal(comparison.seed, 515);
  assert.equal(comparison.balance, "w25");
  assert.equal(merged.effectiveSeed, comparison.seed);
  assert.deepEqual(dispersed.preparation, merged.preparation);
  assert.equal(merged.preparation.start.totals.balance, 0);
  assert.deepEqual(merged.preparation.start.buildings, []);
  assert.deepEqual(Object.values(merged.preparation.start.cards), [0, 0, 0]);
  assert.deepEqual(merged.preparation.draws.map(({ card }) => card), ["tower", "tower", "tower", "tower"]);
  const funding = merged.preparation.funded.totals;
  assert.deepEqual([funding.miningIncome, funding.technologySpend, funding.cardSpend, funding.balance], [22, 10, 12, 0]);
  assert.equal(funding.productionIncome + funding.killIncome, 0);

  for (const { deployment } of [dispersed, merged]) {
    assert.equal(deployment.construction.length, 4);
    assert.ok(deployment.construction.every(({ from, target }) =>
      Math.max(Math.abs(from.col - target.col), Math.abs(from.row - target.row)) === 1));
    assert.equal(deployment.cards.tower, 0);
    assert.ok(deployment.atMs < 60_000);
  }
  assert.equal(dispersed.deployment.synthesisCount, 0);
  assert.equal(merged.deployment.synthesisCount, 1);
  assert.equal(merged.deployment.construction.at(-1).id, merged.deployment.construction[0].id);
  assert.equal(merged.deployment.releasedTiles.length, 3);
  assert.ok(dispersed.deployment.coverage.coveredTiles > merged.deployment.coverage.coveredTiles);
});

test("the paired real waves reconcile shots, receipts, cards and true terminal outcomes", (t) => {
  for (const result of [dispersed, merged]) {
    assert.equal(result.waves[0].atMs, 60_000);
    assert.equal(result.waves[0].combat.towerKills, 8);
    assert.ok(result.waves.length >= 2);
    if (result.outcome === "lost") assert.equal(result.finish.playerHp, 0);
    else assert.ok(result.outcome === "won" || result.waves.length === 3);

    for (const { order, combat, ledger, shots, appliedTowerDamage } of result.waves) {
      assert.equal(combat.planned, order.count);
      assert.equal(combat.planned, combat.spawned + combat.pending + combat.cancelledPending);
      assert.equal(combat.spawned,
        combat.active + combat.cancelledActive + combat.towerKills + combat.playerContacts + combat.wallImpacts);
      assert.equal(combat.towerHits, shots);
      assert.ok(appliedTowerDamage >= combat.towerKills * order.enemyHp);
      assert.equal(ledger.cohortKillIncome, combat.towerKills * ECONOMY_PROTOTYPE.towerKillReward);
      assert.equal(ledger.balance - ledger.openingBalance,
        ledger.miningIncome + ledger.productionIncome + ledger.killIncome
        - ledger.cardSpend - ledger.researchSpend - ledger.technologySpend);
    }
    assert.equal(result.recoveryDraws[0]?.waveId, 1);
    assert.equal(result.recoveryDraws[0]?.balanceBefore - result.recoveryDraws[0]?.balanceAfter, 3);
  }
  assert.ok(merged.waves[1].combat.towerKills > dispersed.waves[1].combat.towerKills);
  t.diagnostic(JSON.stringify([dispersed, merged].map(({ outcome, waves, finish }) => ({
    outcome, killsByWave: waves.map(({ combat }) => combat.towerKills),
    finalBalance: finish.totals.balance, finalKillIncome: finish.totals.killIncome,
  }))));
});

test("accelerating only inactive waits reproduces the paid Challenge pair", () => {
  assert.deepEqual(runChallengeTowerBalance({ accelerated: true }), comparison);
});

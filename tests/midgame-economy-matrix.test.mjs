import assert from "node:assert/strict";
import test from "node:test";
import { runMidgameEconomyMatrix } from "./midgame-economy-matrix.mjs";

test("matched economy policies isolate actual paid prices and actual per-cohort rewards", () => {
  const { rows } = runMidgameEconomyMatrix();
  assert.equal(rows.length, 4);
  const baseline = rows[0];
  const input = ({ transactions }) => transactions.map(({ cost, ...action }) => action);
  const combat = ({ waves }) => waves.map(({ planned, spawnRoster, towerKills, wallEvents, losses }) => (
    { planned, spawnRoster, towerKills, wallEvents, losses }
  ));

  for (const row of rows) {
    assert.deepEqual(input(row), input(baseline), "only effective prices or rewards may change");
    assert.deepEqual(combat(row), combat(baseline), "the physical battlefield is matched");
    assert.deepEqual(row.final.cards, baseline.final.cards);
    assert.deepEqual(row.final.buildings, baseline.final.buildings);
    assert.equal(row.final.legalNearbySlots, baseline.final.legalNearbySlots);

    const paid = row.transactions.filter(({ kind }) => kind === "craft");
    const expectedCosts = paid.map((_, index) => !row.rules.tieredCraft || index < 3 ? 3 : index < 8 ? 6 : 9);
    assert.deepEqual(paid.map(({ cost }) => cost), expectedCosts);
    assert.ok(paid.length >= 9, "the script must exercise both price increases");
    assert.equal(row.final.totals.cardsMade, paid.length);
    assert.equal(row.final.totals.cardSpend, expectedCosts.reduce((sum, value) => sum + value, 0));

    let expectedKillIncome = 0;
    for (const wave of row.waves) {
      const kills = wave.towerKills;
      const reward = row.rules.killDecay ? Math.min(kills, 8) * 2 + Math.max(kills - 8, 0) : kills * 2;
      assert.equal(row.waveEconomy.find(({ waveId }) => waveId === wave.waveId).cohortKillIncome, reward);
      expectedKillIncome += reward;
    }
    assert.equal(row.final.totals.killIncome, expectedKillIncome);
    assert.equal(row.intervals.reduce((sum, interval) => sum + interval.income - interval.spending, 0), row.final.totals.balance);
  }

  assert.ok(rows.find(({ group }) => group === "tier-and-kill-decay").final.totals.balance < baseline.final.totals.balance);
  assert.ok(rows.every(({ final }) => final.totals.balance > 0), "stock and scheduled deployment still cap use of funds");
});

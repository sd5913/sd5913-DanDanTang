import assert from "node:assert/strict";
import { test } from "node:test";
import { replayEndgame, replayWithoutTowers } from "./endgame-replay.mjs";

function checkFinalAccounting(run) {
  assert.equal(run.start.totals.balance, 0);
  assert.deepEqual(run.start.cards, { wall: 0, tower: 0, economy: 0 });
  assert.deepEqual(run.start.buildings, []);
  assert.ok(run.arrivedAt !== null && run.activatedAt >= run.arrivedAt);
  assert.deepEqual(run.batches.map(({ planned, spawned }) => [planned, spawned]), [[12, 12], [20, 20]]);
  for (const batch of run.batches) {
    assert.equal(batch.resolved, batch.wallImpacts + batch.towerKills + batch.deviceContacts + batch.playerContacts);
    assert.equal(batch.spawned, batch.resolved + batch.active + batch.cancelledActive);
    assert.equal(batch.pending, 0);
    assert.equal(batch.cancelledPending, 0);
  }
  assert.equal(run.evacuation.maxHp - run.evacuation.hp,
    run.batches.reduce((damage, batch) => damage + batch.deviceDamage, 0));
}

test("zero-resource mining rush reaches and activates extraction on four fixed worlds but cannot save the device", () => {
  for (const seed of [9, 12, 515, 1091]) {
    const run = replayEndgame(seed, "B1");
    checkFinalAccounting(run);
    assert.equal(run.outcome, "lost", `seed ${seed}`);
    assert.equal(run.lossReason, "evacuation");
    assert.ok(run.final.playerHp > 0);
    assert.equal(run.evacuation.hp, 0);
    assert.equal(run.construction.length, 0);
    assert.equal(run.draws.length, 0);
    assert.equal(run.facilities.length, 1);
    assert.equal(run.final.totals.killIncome, 0);
  }
});

test("a single paid W25 wall stops some pursuers without saving the device", () => {
  const run = replayEndgame(12, "B2");
  checkFinalAccounting(run);
  assert.deepEqual(run.construction.map(({ kind, hp }) => [kind, hp]), [["wall", 25]]);
  const impacts = run.batches.reduce((total, batch) => total + batch.wallImpacts, 0);
  assert.ok(impacts > 0 && impacts <= 9);
  assert.equal(run.lossReason, "evacuation");
  assert.ok(run.final.playerHp > 0);
});

test("a paid four-wall two-tower defense finishes both final cohorts and protects the device", () => {
  const run = replayEndgame(12, "B3");
  checkFinalAccounting(run);
  assert.equal(run.outcome, "won");
  assert.equal(run.evacuation.hp, 6);
  assert.ok(run.final.playerHp > 0);
  assert.deepEqual(run.batches.map(({ resolved }) => resolved), [12, 20]);
  assert.equal(run.construction.filter(({ kind }) => kind === "tower").length, 2);
  assert.equal(run.construction.filter(({ kind }) => kind === "wall").length, 4);
});

test("a real four-card Burst merge prevents the last fatal device hit and earns one ordinary kill reward", () => {
  const run = replayEndgame(60, "B4");
  checkFinalAccounting(run);
  assert.equal(run.outcome, "won");
  assert.equal(run.evacuation.hp, 2);
  assert.ok(run.final.playerHp > 0);
  assert.deepEqual(run.batches.map(({ resolved }) => resolved), [12, 20]);
  const [merge] = run.merges;
  assert.equal(run.merges.length, 1);
  assert.equal(merge.building.evolution.kind, "burst");
  assert.equal(merge.released.length, 3);
  const strikes = run.combat.filter(({ type, evacuationBatch, towerId }) =>
    type === "towerShot" && evacuationBatch && towerId === merge.building.id);
  assert.equal(strikes.length, 6);
  assert.equal(strikes.reduce((amount, strike) => amount + strike.damage, 0), 15);
  assert.equal(run.batches.reduce((total, b) => total + b.towerKills, 0), 1);
  assert.equal(run.finalKillIncome, 2);
  const reference = replayWithoutTowers(run);
  checkFinalAccounting(reference);
  assert.equal(reference.activatedAt, run.activatedAt);
  assert.equal(reference.final.totals.cardSpend, run.final.totals.cardSpend);
  assert.deepEqual(reference.batches.map(({ wallImpacts }) => wallImpacts), run.batches.map(({ wallImpacts }) => wallImpacts));
  assert.equal(reference.lossReason, "evacuation");
  assert.equal(reference.evacuation.hp, 0);
  assert.equal(reference.finalKillIncome, 0);
});

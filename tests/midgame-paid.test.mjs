import assert from "node:assert/strict";
import test from "node:test";
import { toEconomyTenths } from "../src/expedition-economy.ts";
import { runMidgamePaid } from "./midgame-paid.mjs";

test("genuine paid Challenge reaches wave ten under Control and both combined profiles", () => {
  const tryProfile = (experiment) => runMidgamePaid({ seed: 515, policy: "balanced", experiment });
  const original = tryProfile("control");
  const pressure = tryProfile("combat-combined");
  const combined = tryProfile("combined");
  assert.equal(original.matchedOpening, pressure.matchedOpening, "free-economy pressure keeps exact early inputs");
  for (const row of [original, pressure, combined]) {
    assert.equal(row.fingerprint, original.fingerprint);
    assert.equal(row.start.totals.balance, 0);
    assert.equal(row.start.buildings.length, 0);
    assert.equal(row.outcome, "held-wave-10");
    assert.equal(row.wave, 10);
    assert.ok(row.focusWaves[10].end);
    assert.ok(row.focusWaves[6].combat.spawned > 0);
    assert.ok(row.finish.totals.miningIncome > row.facility.cost);
    assert.equal(row.finish.toolLevel, 2);
    assert.equal(row.stage, 1);
    assert.equal(row.finish.totals.killIncome, row.waves.reduce((sum, { ledger }) => sum + ledger.cohortKillIncome, 0));
  }
  assert.equal(original.focusWaves[6].combat.enemyKinds.armored.spawned, 0);
  assert.ok(pressure.focusWaves[6].combat.enemyKinds.armored.spawned > 0);
  assert.ok(combined.focusWaves[6].combat.enemyKinds.armored.spawned > 0);
  assert.equal(original.focusWaves[10].combat.attackEndReason, "resolved");
  assert.equal(combined.focusWaves[10].combat.attackEndReason, "time-limit");
  assert.equal(combined.finalDefenseCoverage.remainingEnemies.length, combined.focusWaves[10].combat.active);
  assert.ok(combined.finalDefenseCoverage.remainingEnemies.length > 0);
  assert.ok(combined.finish.totals.balance < pressure.finish.totals.balance);
  assert.deepEqual(combined.draws.filter(({ card }) => card).slice(0, 9).map(({ balanceBefore, balanceAfter }) =>
    (toEconomyTenths(balanceBefore) - toEconomyTenths(balanceAfter)) / 10), [3, 3, 3, 6, 6, 6, 6, 6, 9]);
});

test("paid focus actually merges a tower, and paid maze digs an opposing route with greater firing coverage", () => {
  const focus = runMidgamePaid({ seed: 515, policy: "tower-focus", experiment: "control" });
  const maze = runMidgamePaid({ seed: 515, policy: "maze", experiment: "control" });
  assert.ok(focus.construction.some(({ kind, level }) => kind === "tower" && level === 2));
  assert.equal(focus.outcome, "lost");
  assert.ok(maze.detour.complete);
  assert.ok(maze.detour.digs.length > 0);
  assert.ok(maze.detour.finalSteps > maze.detour.originalSteps);
  assert.ok(maze.detour.finalCovered > maze.detour.originalCovered);
  assert.ok(maze.focusWaves[6].combat.spawned > 0);
  assert.equal(maze.focusWaves[10], null, "later unmet milestones remain explicit");
});

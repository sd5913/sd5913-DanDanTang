import assert from "node:assert/strict";
import test from "node:test";
import { ExpeditionRound, PROTOTYPE_ONLY } from "../src/expedition-round.ts";

const { normal, fast, profiles, baseWaveCount, maxWaveCount, playerHp } = PROTOTYPE_ONLY;
const south = 92;
const middle = 63;
const north = 31;

function state(round) {
  return {
    phase: round.phase, wave: round.wave, pressure: round.pressure,
    remainingMs: round.remainingMs, playerHp: round.playerHp, stage: round.stage,
  };
}

test("normal preparation lasts two minutes and a drained attack starts the full one-minute recovery", () => {
  const round = new ExpeditionRound();
  assert.deepEqual(state(round), {
    phase: "preparing", wave: 0, pressure: 0, remainingMs: 120_000, playerHp: 4, stage: 0,
  });
  assert.equal(round.update(119_999, south, 0, 0), undefined);
  assert.equal(round.remainingMs, 1);
  const first = round.update(1, south, 0, 0);
  assert.deepEqual(first, { count: baseWaveCount + Math.floor(120_000 / normal.pressureStepMs), ...profiles[0] });
  assert.equal(round.phase, "attacking");
  assert.equal(round.wave, 1);
  assert.equal(round.remainingMs, normal.attackTimeoutMs);

  round.update(1, south, 3, 0);
  round.update(1, south, 0, 0);
  assert.equal(round.phase, "recovering");
  assert.equal(round.remainingMs, 60_000);
  assert.equal(round.update(59_999, south, 0, 0), undefined);
  assert.equal(round.remainingMs, 1);
  assert.ok(round.update(1, south, 0, 0).count > first.count);
  assert.equal(round.wave, 2);
});

test("a pending spawn prevents early recovery and surviving or blocked groups cannot stall the clock", () => {
  const round = new ExpeditionRound(true);
  assert.deepEqual(round.update(fast.preparingMs, south, 0, 0), { count: baseWaveCount, ...profiles[0] });
  assert.equal(round.update(1, south, 0, 2), undefined);
  assert.equal(round.phase, "attacking");
  assert.equal(round.update(fast.attackTimeoutMs - 2, south, 3, 0), undefined);
  assert.equal(round.remainingMs, 1);
  assert.equal(round.update(1, south, 3, 2), undefined);
  assert.equal(round.phase, "recovering");
  assert.equal(round.remainingMs, fast.recoveringMs);
  assert.equal(round.update(fast.recoveringMs - 1, south, 3, 2), undefined);
  const second = round.update(1, south, 3, 2);
  assert.deepEqual(second, { count: baseWaveCount + 1, ...profiles[0] });
  assert.equal(round.phase, "attacking");
  assert.equal(round.wave, 2);
});

test("northward thresholds are monotonic and affect new profiles only", () => {
  const round = new ExpeditionRound(true);
  const southernOrder = round.update(fast.preparingMs, south, 0, 0);
  assert.deepEqual(southernOrder, { count: baseWaveCount, ...profiles[0] });
  round.update(1, 64, 0, 0);
  assert.equal(round.stage, 0);
  round.update(1_000, middle, 0, 0);
  assert.equal(round.stage, 1);
  const middleOrder = round.update(fast.recoveringMs - 1_000, 91, 0, 0);
  assert.equal(round.stage, 1);
  assert.deepEqual(middleOrder, { count: baseWaveCount, ...profiles[1] });
  assert.deepEqual(southernOrder, { count: baseWaveCount, ...profiles[0] });
  round.update(1, 32, 1, 0);
  assert.equal(round.stage, 1);
  round.update(1, north, 0, 0);
  assert.equal(round.stage, 2);
  const northernOrder = round.update(fast.recoveringMs, south, 0, 0);
  assert.equal(round.stage, 2);
  assert.deepEqual(northernOrder, { count: baseWaveCount, ...profiles[2] });
  assert.deepEqual(middleOrder, { count: baseWaveCount, ...profiles[1] });
});

test("advancing beyond a seam resets fractional lingering time and keeps existing pressure", () => {
  const round = new ExpeditionRound(true);
  round.update(fast.pressureStepMs, south, 0, 0);
  assert.equal(round.pressure, 1);
  round.update(fast.pressureStepMs - 1, south, 1, 0);
  assert.equal(round.pressure, 1);
  round.update(1, middle, 1, 0);
  assert.equal(round.stage, 1);
  assert.equal(round.pressure, 1);
  round.update(fast.pressureStepMs - 2, south, 1, 0);
  assert.equal(round.stage, 1);
  assert.equal(round.pressure, 1);
  round.update(1, south, 1, 0);
  assert.equal(round.pressure, 2);
});

test("a large elapsed tick emits only one bounded wave and invalid ticks are inert", () => {
  const round = new ExpeditionRound(true);
  const initial = state(round);
  for (const delta of [0, -1, NaN, Infinity]) {
    assert.equal(round.update(delta, north, 0, 0), undefined);
    assert.deepEqual(state(round), initial);
  }
  const wave = round.update(fast.pressureStepMs * 100, -1, 0, 0);
  assert.deepEqual(wave, { count: maxWaveCount, ...profiles[0] });
  assert.equal(round.stage, 0);
  assert.equal(round.wave, 1);
  assert.equal(round.pressure, 100);
  assert.equal(round.remainingMs, fast.attackTimeoutMs);
});

test("goal completion requires level two and terminal phases suspend all further changes", () => {
  const round = new ExpeditionRound(true);
  round.update(fast.preparingMs, north, 0, 0);
  assert.equal(round.phase, "attacking");
  for (const invalid of [0, 1, 1.9, NaN, Infinity]) assert.equal(round.reachGoal(invalid), false);
  round.hitPlayer(1);
  assert.equal(round.playerHp, playerHp - 1);
  assert.equal(round.reachGoal(2), true);
  assert.equal(round.phase, "won");
  assert.equal(round.remainingMs, 0);
  const won = state(round);
  assert.equal(round.update(fast.recoveringMs, south, 3, 2), undefined);
  round.hitPlayer(100);
  assert.equal(round.reachGoal(2), false);
  assert.deepEqual(state(round), won);
});

test("positive contact damage can lose a round, and reset restores the same timing profile", () => {
  const round = new ExpeditionRound(true);
  const initial = state(round);
  for (const invalid of [0, -1, 0.5, NaN, Infinity]) round.hitPlayer(invalid);
  assert.deepEqual(state(round), initial);
  round.update(fast.pressureStepMs, north, 0, 0);
  round.hitPlayer(1);
  assert.equal(round.playerHp, 3);
  round.hitPlayer(99);
  assert.equal(round.phase, "lost");
  assert.equal(round.playerHp, 0);
  assert.equal(round.remainingMs, 0);
  const lost = state(round);
  round.update(fast.preparingMs * 10, south, 0, 0);
  assert.equal(round.reachGoal(2), false);
  round.hitPlayer(100);
  assert.deepEqual(state(round), lost);

  round.reset();
  assert.deepEqual(state(round), initial);
  assert.equal(round.update(fast.preparingMs - 1, south, 0, 0), undefined);
  assert.deepEqual(round.update(1, south, 0, 0), { count: baseWaveCount, ...profiles[0] });
});

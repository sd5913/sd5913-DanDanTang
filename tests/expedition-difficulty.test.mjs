import assert from "node:assert/strict";
import test from "node:test";
import { DIFFICULTY_PROFILES, PROTOTYPE_ONLY, readDifficulty } from "../src/expedition-difficulty.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";

const south = 92;
const firstSix = [10, 16, 24, 34, 46, 60];

test("missing or invalid difficulty selects the exact legacy Baseline", () => {
  for (const value of [null, "", "unknown", "__proto__", "constructor"]) {
    assert.equal(readDifficulty(value), "baseline");
  }
  for (const id of ["baseline", "a", "b"]) assert.equal(readDifficulty(id), id);
  assert.deepEqual(DIFFICULTY_PROFILES.baseline.normal, {
    preparingMs: 120_000, recoveringMs: 60_000, attackTimeoutMs: 45_000, pressureStepMs: 45_000,
  });
  assert.deepEqual(DIFFICULTY_PROFILES.baseline.fast, {
    preparingMs: 2_500, recoveringMs: 2_500, attackTimeoutMs: 4_500, pressureStepMs: 8_000,
  });
  assert.deepEqual(DIFFICULTY_PROFILES.baseline.stages.map(({ enemyHp }) => enemyHp), [2, 3, 4]);
  assert.deepEqual(new ExpeditionRound().upcoming, { count: 5, ...PROTOTYPE_ONLY.profiles[0] });
  assert.deepEqual(new ExpeditionRound(true).upcoming, { count: 3, ...PROTOTYPE_ONLY.profiles[0] });
});

test("A and B schedule the same counts, including bounded growth beyond wave six", () => {
  const counts = [...firstSix, 74, 88, 102, 116, 120, 120];
  const strengths = { a: 2, b: 4 };
  for (const id of ["a", "b"]) {
    const round = new ExpeditionRound(false, id);
    assert.equal(round.remainingMs, 90_000);
    for (const [index, count] of counts.entries()) {
      const waiting = index === 0 ? 90_000 : 25_000;
      const expectedOrder = { count, enemyHp: strengths[id], wallDamage: 1, contactDamage: 1 };
      assert.deepEqual(round.upcoming, expectedOrder);
      assert.equal(round.update(waiting - 1, south, 0, 0), undefined);
      assert.deepEqual(round.update(1, south, 0, 0), expectedOrder);
      assert.equal(round.wave, index + 1);
      assert.equal(round.remainingMs, 60_000);
      round.update(1, south, 0, 0);
      assert.equal(round.phase, "recovering");
      assert.equal(round.remainingMs, 25_000);
    }
    round.reset();
    assert.equal(round.difficulty, id);
    assert.equal(round.wave, 0);
    assert.deepEqual(round.upcoming, { count: 10, enemyHp: strengths[id], wallDamage: 1, contactDamage: 1 });
  }
});

test("experimental acceleration changes waiting times while preserving attack limit and orders", () => {
  for (const id of ["a", "b"]) {
    const normal = new ExpeditionRound(false, id);
    const fast = new ExpeditionRound(true, id);
    assert.equal(fast.remainingMs, 2_500);
    assert.deepEqual(fast.update(2_500, south, 0, 0), normal.update(90_000, south, 0, 0));
    assert.equal(normal.remainingMs, 60_000);
    assert.equal(fast.remainingMs, 60_000);

    for (const round of [normal, fast]) {
      round.update(59_999, south, 1, 9);
      assert.equal(round.phase, "attacking", "a queued cohort may still be active");
      round.update(1, south, 1, 9);
      assert.equal(round.phase, "recovering", "timing transition does not depend on draining the queue");
    }
    assert.equal(fast.remainingMs, 2_500);
    assert.equal(normal.remainingMs, 25_000);
    assert.deepEqual(fast.update(2_500, south, 1, 9), normal.update(25_000, south, 1, 9));
  }
});

test("B raises only HP at existing depth stages; north retains the implemented terrain tier", () => {
  const stages = [south, 63, 31];
  for (const [index, row] of stages.entries()) {
    const a = new ExpeditionRound(false, "a").update(90_000, row, 0, 0);
    const b = new ExpeditionRound(false, "b").update(90_000, row, 0, 0);
    assert.equal(a.enemyHp, PROTOTYPE_ONLY.profiles[index].enemyHp);
    assert.deepEqual(b, { ...a, enemyHp: [4, 7, 7][index] });
  }
});

test("wait-test preserves normal attack caps, enemy strength and pressure cadence for all profiles", () => {
  for (const id of ["baseline", "a", "b"]) {
    const timing = DIFFICULTY_PROFILES[id].normal;
    const round = new ExpeditionRound("wait-test", id);
    assert.equal(round.remainingMs, 2_500);
    const wave = round.update(2_500, south, 0, 0);
    assert.equal(wave.count, id === "baseline" ? 3 : 10);
    assert.equal(wave.enemyHp, DIFFICULTY_PROFILES[id].stages[0].enemyHp);
    assert.equal(round.remainingMs, timing.attackTimeoutMs);
    round.update(timing.attackTimeoutMs - 1, south, 1, 1);
    assert.equal(round.phase, "attacking");
    assert.equal(round.pressure, 1);
    round.update(1, south, 1, 1);
    assert.equal(round.phase, "recovering");
    assert.equal(round.remainingMs, 2_500);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { armoredSlots, MIDGAME_EXPERIMENTS, readMidgameExperiment, waveDeployment } from "../src/midgame-experiments.ts";

test("the default and unknown midgame profiles leave legacy deployment alone", () => {
  for (const value of [null, "unknown", "constructor", "toString"]) {
    assert.equal(readMidgameExperiment(value), "control");
    assert.equal(waveDeployment(readMidgameExperiment(value), 10), undefined);
  }
});

test("density stages preserve the opening and only add burst pauses in the late burst profile", () => {
  assert.deepEqual([1, 2, 3, 5, 6, 10].map((wave) => waveDeployment("dense", wave).intervalMs),
    [200, 200, 150, 150, 100, 100]);
  assert.deepEqual(waveDeployment("dense-burst", 5), { intervalMs: 150 });
  assert.deepEqual(waveDeployment("dense-burst", 6), { intervalMs: 100, burst: { count: 8, pauseMs: 400 } });
});

test("armor starts at tier-two depth and its exact slots reproduce across separate runs", () => {
  const context = { seed: 515, stage: 0, count: 46 };
  assert.equal(waveDeployment("armored", 5, context), undefined);
  const advanced = { ...context, stage: 1 };
  const plan = waveDeployment("armored", 5, advanced);
  assert.equal(plan.intervalMs, 200);
  assert.equal(plan.armor.hp, 14);
  assert.equal(plan.armor.slots.length, 12);
  assert.deepEqual(waveDeployment("armored", 5, advanced), plan);
  assert.notDeepEqual(waveDeployment("armored", 6, advanced).armor.slots, plan.armor.slots);
  assert.notDeepEqual(waveDeployment("armored", 5, { ...advanced, seed: 12 }).armor.slots, plan.armor.slots);
  for (const percent of [15, 25, 40]) {
    const slots = armoredSlots(0xffff_ffff, 10, 116, percent);
    assert.equal(slots.length, Math.round(116 * percent / 100));
    assert.deepEqual([...new Set(slots)].sort((a, b) => a - b), slots);
    assert.ok(slots.every((slot) => slot >= 0 && slot < 116));
  }
});

test("pressures and economic constraints are independently selectable", () => {
  const context = { seed: 12, stage: 1, count: 60 };
  for (const profile of ["control", "tier", "kill-decay", "economy-combined"]) {
    assert.equal(waveDeployment(profile, 6, context), undefined);
  }
  assert.deepEqual(MIDGAME_EXPERIMENTS.tier.economy, { tieredCraft: true });
  assert.deepEqual(MIDGAME_EXPERIMENTS["kill-decay"].economy, { killDecay: true });
  assert.equal(MIDGAME_EXPERIMENTS["combat-combined"].economy, undefined);
  assert.deepEqual(MIDGAME_EXPERIMENTS.combined.economy, { tieredCraft: true, killDecay: true });
  const plan = waveDeployment("combined", 6, context);
  assert.equal(plan.intervalMs, 100);
  assert.equal(plan.armor.slots.length, 15);
  assert.deepEqual(plan, waveDeployment("combat-combined", 6, context));
});

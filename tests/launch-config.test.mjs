import assert from "node:assert/strict";
import test from "node:test";
import { BUILDING_BALANCE_PROFILES, CONTROL_TOWER_TUNING, PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";
import { DIFFICULTY_PROFILES } from "../src/expedition-difficulty.ts";
import { resolveLaunch } from "../src/launch-config.ts";
import { MIDGAME_EXPERIMENTS, waveDeployment } from "../src/midgame-experiments.ts";

const publicLaunch = {
  diagnostics: false, mode: "play", fixture: null,
  difficulty: "challenge", buildingBalance: "w25", midgame: "combined",
  fogEnabled: true, roundSpeed: false, debugControls: false, towerEvolution: true,
  towerTuning: PLAYTEST_TOWER_TUNING,
};

test("production opens the unified playtest and ignores experiment URLs", () => {
  assert.deepEqual(resolveLaunch(new URLSearchParams(), "production"), publicLaunch);
  assert.deepEqual(publicLaunch.towerTuning, { burstRadius: 2, piercingIntervalMs: 750 });
  assert.deepEqual(CONTROL_TOWER_TUNING, { burstRadius: 1.25, piercingIntervalMs: 900 });
  const overrides = new URLSearchParams(
    "diagnostics=1&mode=defense&map=single&difficulty=baseline&build=w15&midgame=tier&fog=off&speed=test&debug=1&evolution=0&burstRadius=2&piercingIntervalMs=123",
  );
  assert.deepEqual(resolveLaunch(overrides, "production"), publicLaunch);
});

test("the unified profile resolves to the existing opening, defense and midgame settings", () => {
  const { difficulty, buildingBalance, midgame } = resolveLaunch(new URLSearchParams(), "production");
  const { economy, normal, schedule } = DIFFICULTY_PROFILES[difficulty];
  assert.equal(economy.initialBalance, 0);
  assert.deepEqual(economy.initialCards, { wall: 0, tower: 0, economy: 0 });
  assert.equal(normal.preparingMs, 60_000);
  assert.equal(schedule.initial[0], 8);
  assert.equal(BUILDING_BALANCE_PROFILES[buildingBalance].wallHp, 25);
  assert.deepEqual(MIDGAME_EXPERIMENTS[midgame].economy, { tieredCraft: true, killDecay: true });
  const wave = waveDeployment(midgame, 6, { seed: 515, stage: 1, count: 60 });
  assert.equal(wave.intervalMs, 100);
  assert.equal(wave.armor.hp, 14);
  assert.equal(wave.armor.slots.length, 15);
});

test("development requires an opt-in while a dedicated regression build accepts historical URLs", () => {
  const flags = "mode=play&difficulty=challenge&build=w35&midgame=armored&fog=off&speed=wait-test&debug=1";
  assert.deepEqual(resolveLaunch(new URLSearchParams(flags), "development"), publicLaunch);
  const development = resolveLaunch(new URLSearchParams("diagnostics=1&" + flags), "development");
  assert.deepEqual(development, {
    diagnostics: true, mode: "play", fixture: null, difficulty: "challenge",
    buildingBalance: "w35", midgame: "armored", fogEnabled: false, roundSpeed: "wait-test",
    debugControls: true, towerEvolution: false, towerTuning: CONTROL_TOWER_TUNING,
  });
  assert.deepEqual(resolveLaunch(new URLSearchParams(flags), "regression"), development);
  assert.equal(resolveLaunch(new URLSearchParams(flags + "&evolution=1"), "regression").towerEvolution, true);
  const baseline = resolveLaunch(new URLSearchParams("mode=play&difficulty=b&build=w15&midgame=combined"), "regression");
  assert.deepEqual([baseline.difficulty, baseline.buildingBalance, baseline.midgame], ["b", "control", "control"]);
  assert.equal(resolveLaunch(new URLSearchParams("map=single"), "regression").fixture, "single");
});

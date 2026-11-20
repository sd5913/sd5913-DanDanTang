import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_CONFIG } from "../src/defense-simulation.ts";
import { ECONOMY_PROTOTYPE } from "../src/expedition-economy.ts";
import { ARMORED_ENEMY_HP } from "../src/midgame-experiments.ts";
import { runMidgameArmorMatrix } from "./midgame-armor-matrix.mjs";

test("matched armor tests keep the two early waves and isolate armor on real tower and wall contacts", () => {
  const { rows } = runMidgameArmorMatrix();
  assert.equal(rows.length, 32);
  const mixed = rows.filter(({ defense }) => defense === "mixed-level-one-and-two");
  const four = rows.filter(({ defense }) => defense === "four-level-two");
  assert.ok(mixed.some(({ armorPercent, summary }) => armorPercent && summary.defeatAtMs));
  assert.ok(four.some(({ armorPercent, summary }) => armorPercent && summary.waveReached === 10 && !summary.defeatAtMs));
  const armoredKills = rows.filter(({ armorPercent }) => armorPercent > 0)
    .reduce((sum, { summary }) => sum + summary.group.armored.kills, 0);
  assert.ok(armoredKills > 0);
  const wellCovered = four.find(({ long, armorPercent }) => !long && armorPercent === 25);
  const { normal, armored } = wellCovered.summary.group;
  assert.equal(normal.meanHitsOnKill, 2);
  assert.equal(armored.meanHitsOnKill, 3);
  assert.ok(armored.meanExposureToKillMs > normal.meanExposureToKillMs);
  assert.equal(armored.kills, armored.spawned);

  for (const row of rows) {
    const baseline = rows.find(({ armorPercent, defense, long }) => armorPercent === 0 && defense === row.defense && long === row.long);
    assert.deepEqual(row.startingBuildings, baseline.startingBuildings);
    assert.deepEqual(row.waves.slice(0, 2), baseline.waves.slice(0, 2));

    for (const wave of row.waves) {
      const expected = wave.order.enemyHp;
      assert.equal(wave.plannedSpawnIntervalMs, DEFENSE_CONFIG.spawnIntervalMs);
      assert.equal(wave.spawnRoster.length, wave.spawned);
      assert.ok(wave.spawnRoster.every(({ kind, hp }) => hp === (kind === "armored" ? ARMORED_ENEMY_HP : expected)));
      assert.equal(wave.killsByKind.normal?.count ?? 0, wave.enemyKinds.normal.towerKills);
      assert.equal(wave.killsByKind.armored?.count ?? 0, wave.enemyKinds.armored.towerKills);
      const normal = wave.kindCounts.normal ?? 0;
      const armor = wave.kindCounts.armored ?? 0;
      assert.equal(armor, wave.enemyKinds.armored.spawned);
      assert.equal(normal + armor, wave.spawned);
      const armoredSlots = new Set(wave.deployment?.armor?.slots);
      assert.ok(wave.spawnRoster.every(({ kind }, index) => (kind === "armored") === armoredSlots.has(index)));
      if (expected === 4 || row.armorPercent === 0) assert.equal(armor, 0);
    }
    assert.equal(row.final.totals.killIncome, row.waves.reduce((sum, wave) => sum + wave.towerKills, 0) * ECONOMY_PROTOTYPE.towerKillReward);
  }
});

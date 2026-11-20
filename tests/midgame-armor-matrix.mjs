import { pathToFileURL } from "node:url";
import { DEFENSE_CONFIG } from "../src/defense-simulation.ts";
import { armoredSlots, ARMORED_ENEMY_HP } from "../src/midgame-experiments.ts";
import { runMidgameFixture } from "./midgame-fixture.mjs";

const armorPercentages = [0, 15, 25, 40];
const towerGroups = {
  "one-level-two": { towerCount: 1 },
  "two-level-two": { towerCount: 2 },
  "four-level-two": { towerCount: 4 },
  "mixed-level-one-and-two": { towerCount: 2, mixed: true },
};

function average(total, count) {
  return count > 0 ? total / count : null;
}

function lateSummary({ waves, final, defeatAtMs }) {
  const tierTwo = waves.filter(({ order }) => order.enemyHp === 7);
  const group = Object.fromEntries(["normal", "armored"].map((kind) => {
    let spawned = 0;
    let kills = 0;
    let hitsOnKills = 0;
    let exposureToKillMs = 0;
    let exposureKills = 0;
    let wallContacts = 0;
    let killIncome = 0;
    for (const wave of tierTwo) {
      const combat = wave.enemyKinds[kind];
      spawned += combat.spawned;
      kills += combat.towerKills;
      hitsOnKills += combat.towerHitsOnKills;
      exposureToKillMs += combat.totalTowerExposureToKillMs;
      exposureKills += combat.towerExposureKills;
      wallContacts += combat.wallImpacts;
      killIncome += wave.killsByKind[kind]?.reward ?? 0;
    }
    return [kind, {
      spawned, kills, hitsOnKills, wallContacts, killIncome,
      meanHitsOnKill: average(hitsOnKills, kills),
      meanExposureToKillMs: average(exposureToKillMs, exposureKills),
      towerKillShare: average(kills, spawned),
      wallContactShare: average(wallContacts, spawned),
    }];
  }));
  const late = Object.fromEntries(tierTwo.filter(({ waveId }) => [3, 6, 8, 10].includes(waveId)).map((wave) => [
    wave.waveId, {
      spawned: wave.spawned, activePeak: wave.peakActive, exposed: wave.towerExposed,
      kills: wave.towerKills, wallContacts: wave.wallImpacts, firstWallAtMs: wave.firstWallAtMs,
      reserveHp: wave.attackEnd?.wallHp ?? null, playerHp: wave.attackEnd?.playerHp ?? null,
    },
  ]));
  return {
    waveReached: waves.at(-1).waveId, finalWallHp: final.wallHp, playerHp: final.playerHp, defeatAtMs,
    group, late, firstWallLostAtMs: tierTwo.flatMap(({ losses }) => losses).find(({ kind }) => kind === "wall")?.atMs ?? null,
    allLosses: waves.flatMap(({ losses }) => losses),
  };
}

export function runMidgameArmorMatrix() {
  const rows = [];
  for (const long of [false, true]) {
    for (const [defense, inventory] of Object.entries(towerGroups)) {
      for (const armorPercent of armorPercentages) {
        const replay = runMidgameFixture({
          ...inventory, stage: 1, long, spending: "none",
          waveDeployment: ({ order, stage, waveId, seed }) => armorPercent && stage > 0 ? {
            intervalMs: DEFENSE_CONFIG.spawnIntervalMs,
            armor: { hp: ARMORED_ENEMY_HP, slots: armoredSlots(seed, waveId, order.count, armorPercent) },
          } : undefined,
        });
        rows.push({ armorPercent, defense, ...replay, summary: lateSummary(replay) });
      }
    }
  }
  return {
    fixture: "controlled tier-two battle; stage advanced after wave two, all at 200ms",
    rows,
  };
}

const command = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (command) console.log(JSON.stringify(runMidgameArmorMatrix(), null, 2));

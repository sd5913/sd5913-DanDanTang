import { pathToFileURL } from "node:url";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { MIDGAME_EXPERIMENTS, waveDeployment } from "../src/midgame-experiments.ts";
import { runMidgameFixture } from "./midgame-fixture.mjs";

const profiles = ["control", "dense", "armored", "tier", "kill-decay", "economy-combined", "combat-combined", "combined"];
const defenses = [
  { name: "mixed", towerCount: 2, mixed: true },
  { name: "four-level-two", towerCount: 4, mixed: false },
];

export function runMidgameCombined() {
  const seed = 515;
  return {
    fixture: "matched mature defenses with a paid tier-two trip, normal Challenge timing",
    seed,
    runs: defenses.flatMap(({ name, ...defense }) =>
      [false, true].flatMap((long) => profiles.map((profile) => ({
        name, profile,
        ...runMidgameFixture({
          seed, stage: 1, long, ...defense,
          waveDeployment: ({ waveId, stage, order }) => waveDeployment(profile, waveId, { seed, stage, count: order.count }),
          createEconomy: (map) => new ExpeditionEconomy(map, seed, undefined, "challenge", MIDGAME_EXPERIMENTS[profile].economy),
        }),
      })))),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(runMidgameCombined(), null, 2));
}

import { pathToFileURL } from "node:url";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { runMidgameFixture } from "./midgame-fixture.mjs";

const groups = {
  control: { tieredCraft: false, killDecay: false },
  "tier-only": { tieredCraft: true, killDecay: false },
  "kill-decay-only": { tieredCraft: false, killDecay: true },
  "tier-and-kill-decay": { tieredCraft: true, killDecay: true },
};
const seed = 515;

export function runMidgameEconomyMatrix() {
  const rows = Object.entries(groups).map(([group, rules]) => ({
    group, rules,
    ...runMidgameFixture({
      seed, createEconomy: (map) => new ExpeditionEconomy(map, seed, undefined, "challenge", rules),
    }),
  }));
  return {
    fixture: "same mature defense with a fixed interval between legal purchases and rear placements",
    rows,
  };
}

const command = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (command) console.log(JSON.stringify(runMidgameEconomyMatrix(), null, 2));

import { pathToFileURL } from "node:url";
import { runMidgameFixture } from "./midgame-fixture.mjs";

const deployments = {
  "fixed-200": { intervalMs: 200 },
  "fixed-150": { intervalMs: 150 },
  "fixed-100": { intervalMs: 100 },
  "burst-100": { intervalMs: 100, burst: { count: 8, pauseMs: 400 } },
};

const defenses = {
  "south-two-towers": {},
  "tier-two-mixed-short": { stage: 1, mixed: true },
  "tier-two-mixed-long": { stage: 1, mixed: true, long: true },
};

export function runMidgameDensity() {
  const rows = [];
  for (const [defense, structure] of Object.entries(defenses)) {
    for (const [cadence, deployment] of Object.entries(deployments)) {
      const replay = runMidgameFixture({
        ...structure, spending: "none",
        waveDeployment: () => deployment,
      });
      rows.push({ defense, cadence, deployment, ...replay });
    }
  }
  return {
    fixture: "matched controlled deployments, normal Challenge wave timing",
    rows,
  };
}

const command = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (command) console.log(JSON.stringify(runMidgameDensity(), null, 2));

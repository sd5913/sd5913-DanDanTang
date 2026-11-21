import { CONTROL_TOWER_TUNING, PLAYTEST_TOWER_TUNING, readBuildingBalance } from "./building-balance.ts";
import type { BuildingBalanceId, TowerTuning } from "./building-balance.ts";
import { readDifficulty } from "./expedition-difficulty.ts";
import type { DifficultyId } from "./expedition-difficulty.ts";
import type { RoundSpeed } from "./expedition-round.ts";
import { readMidgameExperiment } from "./midgame-experiments.ts";
import type { MidgameExperimentId } from "./midgame-experiments.ts";

export const PLAYTEST_PROFILE = Object.freeze({
  difficulty: "challenge",
  buildingBalance: "w25",
  midgame: "combined",
  towerTuning: PLAYTEST_TOWER_TUNING,
} as const);

interface LaunchConfig {
  readonly diagnostics: boolean;
  readonly mode: "play" | "defense" | "terrain";
  readonly fixture: string | null;
  readonly difficulty: DifficultyId;
  readonly buildingBalance: BuildingBalanceId;
  readonly midgame: MidgameExperimentId;
  readonly fogEnabled: boolean;
  readonly roundSpeed: RoundSpeed;
  readonly debugControls: boolean;
  readonly towerEvolution: boolean;
  readonly manualMerge: boolean;
  readonly towerTuning: TowerTuning;
}

export function resolveLaunch(params: URLSearchParams, environment: "production" | "development" | "regression"): LaunchConfig {
  const diagnostics = environment === "regression"
    || (environment === "development" && params.get("diagnostics") === "1");
  if (!diagnostics) {
    return {
      ...PLAYTEST_PROFILE,
      diagnostics: false, mode: "play", fixture: null,
      fogEnabled: true, roundSpeed: false, debugControls: false, towerEvolution: true, manualMerge: true,
    };
  }

  const mode = params.get("mode");
  const difficulty = readDifficulty(params.get("difficulty"));
  const speed = params.get("speed");
  return {
    diagnostics: true,
    mode: mode === "play" || mode === "defense" ? mode : "terrain",
    fixture: params.get("map"),
    difficulty,
    buildingBalance: difficulty === "challenge" ? readBuildingBalance(params.get("build")) : "control",
    midgame: difficulty === "challenge" ? readMidgameExperiment(params.get("midgame")) : "control",
    fogEnabled: params.get("fog") !== "off",
    roundSpeed: speed === "wait-test" ? "wait-test" : speed === "test",
    debugControls: params.get("debug") === "1",
    towerEvolution: params.get("evolution") === "1",
    manualMerge: params.get("merge") === "manual",
    towerTuning: CONTROL_TOWER_TUNING,
  };
}

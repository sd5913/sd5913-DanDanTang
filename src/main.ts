import Phaser from "phaser";
import { BUILDING_BALANCE_PROFILES, DEFAULT_CHALLENGE_BUILDING_BALANCE } from "./building-balance.ts";
import { DEFENSE_LAYOUT, DEFENSE_TARGET, ENEMY_ENTRY } from "./defense-map.ts";
import { DENSE_LONG_MAP_LAYOUT } from "./dense-long-map.ts";
import { generateExpeditionBiomes } from "./expedition-biomes.ts";
import { DIFFICULTY_PROFILES } from "./expedition-difficulty.ts";
import { addExpeditionApproach, addExpeditionTiers, PLAY_GENERATOR_VERSION } from "./expedition-terrain.ts";
import {
  GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionWorld,
} from "./generated-map.ts";
import { LONG_MAP_LAYOUT } from "./long-map.ts";
import { resolveLaunch } from "./launch-config.ts";
import { MIDGAME_EXPERIMENTS } from "./midgame-experiments.ts";
import { GridScene } from "./scene.ts";
import { MAP_COLUMNS, MAP_ROWS } from "./terrain.ts";
import { TILE_SIZE } from "./player.ts";
import { TEST_MAP_LAYOUT } from "./test-map.ts";
import { newWorldSeed, selectWorldSeed, worldSeedLabel } from "./world-seed.ts";
import "./style.css";

const params = new URLSearchParams(window.location.search);
const environment = import.meta.env.MODE === "regression" ? "regression" : import.meta.env.DEV ? "development" : "production";
const {
  diagnostics, mode, fixture, difficulty, buildingBalance, midgame, fogEnabled, roundSpeed, debugControls,
  towerEvolution, towerTuning, manualMerge,
} = resolveLaunch(params, environment);
const defense = mode === "defense";
const play = mode === "play";
const wide = play || (fixture !== "fix01" && (defense || (fixture !== "single" && fixture !== "regression")));
const world = wide ? generateExpeditionWorld(selectWorldSeed(params.get("seed"))) : undefined;
const landscape = play && world ? generateExpeditionBiomes(world.layout, world.effectiveSeed) : undefined;

let layout: readonly string[];
let phase: string;
if (world) {
  layout = landscape ? addExpeditionApproach(addExpeditionTiers(landscape.layout, world.effectiveSeed)) : world.layout;
  phase = !diagnostics ? "Playtest Build" : play ? "P0-H" : "P0-B FIX02";
} else if (defense || fixture === "fix01") {
  layout = defense ? DEFENSE_LAYOUT : DENSE_LONG_MAP_LAYOUT;
  phase = "P0-B FIX01";
} else if (fixture === "single") {
  layout = TEST_MAP_LAYOUT;
  phase = "P0-A.1";
} else {
  layout = LONG_MAP_LAYOUT;
  phase = "P0-A.2";
}
const defenseOptions = play && world
  ? {
      entry: GENERATED_ENEMY_ENTRY, target: GENERATED_GOAL, worldSeed: world.effectiveSeed,
      fogEnabled,
      roundSpeed,
      difficulty,
      buildingBalance,
      midgame,
      debugControls,
      towerEvolution,
      towerTuning,
      manualMerge,
    }
  : !defense ? undefined : wide
    ? { entry: GENERATED_ENEMY_ENTRY, target: GENERATED_GOAL }
    : { entry: ENEMY_ENTRY, target: DEFENSE_TARGET };
document.documentElement.classList.toggle("wide-map", wide);
document.title = `${phase} · ${play ? "掘进对局" : defense ? "防御灰盒" : "格子地形与持续挖掘"}`;
const worldDetails = world ? worldSeedLabel(landscape ? { ...world, generatorVersion: PLAY_GENERATOR_VERSION } : world) : "";
if (play) {
  document.querySelector("h1")!.textContent = "掘进式生存塔防";
  document.getElementById("goal-status")!.textContent = "升级至 Lv.2 工具，挖通地形并抵达北端目标区";
}
if (play && diagnostics) {
  const select = document.querySelector<HTMLSelectElement>("#round-difficulty")!;
  for (const [id, profile] of Object.entries(DIFFICULTY_PROFILES)) {
    select.add(new Option(profile.label, id));
  }
  select.value = difficulty;
  document.getElementById("round-difficulty-controls")!.hidden = false;
  select.addEventListener("change", () => {
    const url = new URL(window.location.href);
    if (select.value === "baseline") url.searchParams.delete("difficulty");
    else url.searchParams.set("difficulty", select.value);
    if (select.value !== "challenge") {
      url.searchParams.delete("build");
      url.searchParams.delete("midgame");
    }
    window.location.assign(url);
  });
  if (difficulty === "challenge") {
    const balanceSelect = document.querySelector<HTMLSelectElement>("#challenge-balance")!;
    for (const [id, profile] of Object.entries(BUILDING_BALANCE_PROFILES)) {
      const trial = id === DEFAULT_CHALLENGE_BUILDING_BALANCE ? " · 试玩候选" : id === "control" ? " · 原属性" : "";
      balanceSelect.add(new Option(`${profile.label} · ${profile.wallHp} HP${trial}`, id));
    }
    balanceSelect.value = buildingBalance;
    document.getElementById("challenge-balance-controls")!.hidden = false;
    balanceSelect.addEventListener("change", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("build", balanceSelect.value);
      window.location.assign(url);
    });
    const midgameSelect = document.querySelector<HTMLSelectElement>("#midgame-experiment")!;
    for (const [id, experiment] of Object.entries(MIDGAME_EXPERIMENTS)) {
      midgameSelect.add(new Option(experiment.label, id));
    }
    midgameSelect.value = midgame;
    document.getElementById("midgame-experiment-controls")!.hidden = false;
    midgameSelect.addEventListener("change", () => {
      const url = new URL(window.location.href);
      if (midgameSelect.value === "control") url.searchParams.delete("midgame");
      else url.searchParams.set("midgame", midgameSelect.value);
      window.location.assign(url);
    });
  }
}
document.getElementById("map-size")!.textContent =
  `${phase} / ${layout[0].length} × ${layout.length}${worldDetails ? ` · ${worldDetails}` : ""}`;

if (world) {
  const url = new URL(window.location.href);
  const seed = String(world.requestedSeed);
  if (url.searchParams.get("seed") !== seed) {
    url.searchParams.set("seed", seed);
    window.history.replaceState(window.history.state, "", url);
  }
  const newRoundButton = document.querySelector<HTMLButtonElement>("#new-round")!;
  newRoundButton.hidden = false;
  newRoundButton.addEventListener("click", () => {
    url.searchParams.set("seed", String(newWorldSeed(world)));
    window.location.assign(url);
  });
}

new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "board",
  width: MAP_COLUMNS * TILE_SIZE,
  height: MAP_ROWS * TILE_SIZE,
  backgroundColor: "#142027",
  scale: wide
    ? { mode: Phaser.Scale.RESIZE }
    : { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  audio: { noAudio: true },
  input: { touch: false, gamepad: false },
  scene: new GridScene(layout, defenseOptions, wide, landscape?.biomes),
});

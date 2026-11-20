import Phaser from "phaser";
import { DEFENSE_LAYOUT, DEFENSE_TARGET, ENEMY_ENTRY } from "./defense-map.ts";
import { DENSE_LONG_MAP_LAYOUT } from "./dense-long-map.ts";
import { generateExpeditionBiomes } from "./expedition-biomes.ts";
import { DIFFICULTY_PROFILES, readDifficulty } from "./expedition-difficulty.ts";
import { addExpeditionApproach, addExpeditionTiers, PLAY_GENERATOR_VERSION } from "./expedition-terrain.ts";
import {
  GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionWorld,
} from "./generated-map.ts";
import { LONG_MAP_LAYOUT } from "./long-map.ts";
import { GridScene } from "./scene.ts";
import { MAP_COLUMNS, MAP_ROWS } from "./terrain.ts";
import { TILE_SIZE } from "./player.ts";
import { TEST_MAP_LAYOUT } from "./test-map.ts";
import { newWorldSeed, selectWorldSeed, worldSeedLabel } from "./world-seed.ts";
import "./style.css";

const params = new URLSearchParams(window.location.search);
const defense = params.get("mode") === "defense";
const play = params.get("mode") === "play";
const difficulty = readDifficulty(params.get("difficulty"));
const speed = params.get("speed");
const fixture = params.get("map");
const wide = play || (fixture !== "fix01" && (defense || (fixture !== "single" && fixture !== "regression")));
const world = wide ? generateExpeditionWorld(selectWorldSeed(params.get("seed"))) : undefined;
const landscape = play && world ? generateExpeditionBiomes(world.layout, world.effectiveSeed) : undefined;

let layout: readonly string[];
let phase: string;
if (world) {
  layout = landscape ? addExpeditionApproach(addExpeditionTiers(landscape.layout, world.effectiveSeed)) : world.layout;
  phase = play ? "P0-H" : "P0-B FIX02";
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
      fogEnabled: params.get("fog") !== "off",
      roundSpeed: speed === "wait-test" ? "wait-test" as const : speed === "test",
      difficulty,
      debugControls: params.get("debug") === "1",
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
  const select = document.querySelector<HTMLSelectElement>("#round-difficulty")!;
  for (const [id, profile] of Object.entries(DIFFICULTY_PROFILES)) {
    select.add(new Option(profile.label, id));
  }
  select.value = difficulty;
  select.addEventListener("change", () => {
    const url = new URL(window.location.href);
    if (select.value === "baseline") url.searchParams.delete("difficulty");
    else url.searchParams.set("difficulty", select.value);
    window.location.assign(url);
  });
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

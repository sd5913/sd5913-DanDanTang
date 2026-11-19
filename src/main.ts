import Phaser from "phaser";
import { DEFENSE_LAYOUT } from "./defense-map.ts";
import { DENSE_LONG_MAP_LAYOUT } from "./dense-long-map.ts";
import { LONG_MAP_LAYOUT } from "./long-map.ts";
import { GridScene } from "./scene.ts";
import { MAP_COLUMNS, MAP_ROWS } from "./terrain.ts";
import { TILE_SIZE } from "./player.ts";
import { TEST_MAP_LAYOUT } from "./test-map.ts";
import "./style.css";

const params = new URLSearchParams(window.location.search);
const defense = params.get("mode") === "defense";
let layout: readonly string[] = DENSE_LONG_MAP_LAYOUT;
let phase = "P0-B FIX01";
if (defense) {
  layout = DEFENSE_LAYOUT;
} else if (params.get("map") === "single") {
  layout = TEST_MAP_LAYOUT;
  phase = "P0-A.1";
} else if (params.get("map") === "regression") {
  layout = LONG_MAP_LAYOUT;
  phase = "P0-A.2";
}
document.title = `${phase} · ${defense ? "防御灰盒" : "格子地形与持续挖掘"}`;
document.getElementById("map-size")!.textContent = `${phase} / ${MAP_COLUMNS} × ${layout.length}`;

new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "board",
  width: MAP_COLUMNS * TILE_SIZE,
  height: MAP_ROWS * TILE_SIZE,
  backgroundColor: "#142027",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  audio: { noAudio: true },
  input: { touch: false, gamepad: false },
  scene: new GridScene(layout, defense),
});

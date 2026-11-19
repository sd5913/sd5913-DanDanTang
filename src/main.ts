import Phaser from "phaser";
import { GridScene } from "./scene.ts";
import { MAP_COLUMNS, MAP_ROWS } from "./terrain.ts";
import { TILE_SIZE } from "./player.ts";
import "./style.css";

new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "board",
  width: MAP_COLUMNS * TILE_SIZE,
  height: MAP_ROWS * TILE_SIZE,
  backgroundColor: "#142027",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  audio: { noAudio: true },
  input: { touch: false, gamepad: false },
  scene: GridScene,
});

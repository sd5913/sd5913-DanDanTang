import Phaser from "phaser";
import { PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";
import { TERRAIN_HP_BY_LEVEL } from "../src/mining-config.ts";
import { TILE_SIZE } from "../src/player.ts";
import { GridScene } from "../src/scene.ts";
import "../src/style.css";

const columns = 40;
const rows = 96;
const cell = (col, row) => ({ col, row });
const playerStart = cell(20, 47);
const adjacentDirt = cell(21, 47);
const entry = cell(14, 52);
const goal = cell(25, 52);
const unexplored = cell(37, 90);
const groups = [
  [cell(20, 48), cell(19, 48), cell(18, 48), cell(17, 48)],
  [cell(23, 44), cell(24, 44), cell(23, 45), cell(24, 45)],
  [cell(15, 44), cell(16, 44), cell(17, 44), cell(16, 45)],
  [cell(25, 46), cell(25, 47), cell(25, 48), cell(25, 49)],
];

function sameCell(col, row, position) {
  return col === position.col && row === position.row;
}

const layout = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, col) => {
  if (sameCell(col, row, playerStart)) return "S";
  if (sameCell(col, row, adjacentDirt)) return "+";
  if (sameCell(col, row, goal)) return "G";
  if (col >= 13 && col <= 27 && row >= 42 && row <= 50) return ".";
  // Solid terrain separates the player's build chamber from an active enemy lane.
  if (row === entry.row && col >= entry.col && col <= 27) return ".";
  return "#";
}).join(""));

class MergePerformanceScene extends GridScene {
  create() {
    super.create();
    for (const group of groups) {
      for (const position of group) {
        if (this.terrain.placeBuilding("wall", position)?.level !== 1) {
          throw new Error("Fixture must retain all four level-one walls");
        }
      }
    }
    const simulation = this.defense.simulation;
    const state = () => ({
      ready: groups.filter(([root]) => this.terrain.previewReadySynthesis(root)).length,
      occupied: groups.flat().filter((position) => this.terrain.getBuilding(position)).length,
      knownEntry: this.fog.visibility(entry),
      knownGoal: this.fog.visibility(goal),
      far: this.fog.visibility(unexplored),
      revision: this.terrain.revision,
    });
    window.mergePerformanceFixture = {
      groups,
      state,
      metrics: () => simulation.mergeRouteMetrics,
      start(count) {
        const profile = { hp: 14, contactDamage: 1 };
        const requested = count === "sustained"
          ? simulation.requestWave(6, { count: 180, wallDamage: 1, enemyHp: profile.hp, contactDamage: profile.contactDamage },
            { intervalMs: 100 })
          : simulation.spawn(count, 1, profile);
        const { spawned, removed } = simulation.spawnCounts;
        return { requested, initialActive: spawned - removed };
      },
      dig: () => {
        const before = this.terrain.revision;
        const result = this.terrain.applyDigDamage(this.player.cell, adjacentDirt, TERRAIN_HP_BY_LEVEL[1]);
        return { before, after: this.terrain.revision, cleared: result.effective && result.cleared };
      },
      destroyOne: () => {
        const wall = this.terrain.getBuilding(groups[0][1]);
        const result = wall && this.terrain.impactWall(wall.cell, wall.id, wall.hp);
        return result?.destroyed === true;
      },
    };
  }
}

document.documentElement.classList.add("wide-map");
new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "board",
  width: columns * TILE_SIZE,
  height: rows * TILE_SIZE,
  backgroundColor: "#142027",
  scale: { mode: Phaser.Scale.RESIZE },
  audio: { noAudio: true },
  input: { touch: false, gamepad: false },
  scene: new MergePerformanceScene(layout, {
    entry, target: goal, worldSeed: 515, difficulty: "challenge", buildingBalance: "w25", midgame: "combined",
    fogEnabled: true, manualMerge: true, towerEvolution: true, towerTuning: PLAYTEST_TOWER_TUNING,
  }, true),
});

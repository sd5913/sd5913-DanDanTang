import Phaser from "phaser";
import { TILE_SIZE } from "../src/player.ts";
import { GridScene } from "../src/scene.ts";
import "../src/style.css";

const columns = 64;
const rows = 32;
const entry = { col: 12, row: 15 };
const target = { col: 60, row: 15 };
const towerGroups = [
  { kind: "piercing", positions: [[11, 15], [10, 15], [9, 15], [8, 15]] },
  { kind: "burst", positions: [[17, 14], [17, 13], [18, 13], [18, 14]] },
];
const layout = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, col) => {
  if (col === 14 && row === 12) return "S";
  if (col === target.col && row === target.row) return "G";
  if (row === entry.row && col >= 8 && col <= target.col) return ".";
  if (col >= 8 && col <= 22 && row >= 11 && row <= 17) return ".";
  return "#";
}).join(""));

class TowerPerfScene extends GridScene {
  create() {
    super.create();
    for (const group of towerGroups) {
      const [origin] = group.positions.map(([col, row]) => {
        const tower = this.terrain.placeBuilding("tower", { col, row });
        if (!tower) throw new Error(`Unable to place ${group.kind} fixture tower`);
        return tower.cell;
      });
      if (this.terrain.getBuilding(origin)?.evolution?.kind !== group.kind) {
        throw new Error(`Unable to synthesize ${group.kind} fixture tower`);
      }
    }

    // Test-only sampling of the actual simulation in the unmodified scene update.
    const simulation = this.defense.simulation;
    const step = simulation.step.bind(simulation);
    let stepSamples;
    simulation.step = (delta, player) => {
      if (!stepSamples) {
        step(delta, player);
        return;
      }
      const started = performance.now();
      step(delta, player);
      stepSamples.push(performance.now() - started);
    };
    window.towerEvolutionPerfFixture = {
      start(scopedCount) {
        stepSamples = [];
        const profile = { hp: 14, contactDamage: 1 };
        let requested = 0;
        if (scopedCount === "sustained") {
          requested = simulation.requestWave(6, {
            count: 180, wallDamage: 1, enemyHp: profile.hp, contactDamage: profile.contactDamage,
          }, { intervalMs: 100 });
        } else if (scopedCount > 0) {
          requested = simulation.spawn(scopedCount, 1, profile);
        }
        const { spawned, removed } = simulation.spawnCounts;
        return { requested, initialActive: spawned - removed };
      },
      stop: () => {
        const samples = stepSamples;
        stepSamples = undefined;
        return samples;
      },
      visibility: () => ({
        current: this.fog.visibility(entry),
        far: this.fog.visibility(target),
      }),
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
  scene: new TowerPerfScene(layout, {
    entry, target, buildingBalance: "w25", fogEnabled: true, debugControls: true, towerEvolution: true,
  }, true),
});

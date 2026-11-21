import Phaser from "phaser";
import { PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";
import { enemyPosition } from "../src/defense-simulation.ts";
import { TILE_SIZE } from "../src/player.ts";
import { GridScene } from "../src/scene.ts";
import "../src/style.css";

const mode = new URLSearchParams(location.search).get("fixture");
const corner = mode === "corner" || mode === "legacy-corner";
const edge = mode === "edge";
const short = corner || edge;
const cell = (col, row) => ({ col, row });
const columns = 64;
const rows = 32;
const entry = corner ? cell(12, 9) : cell(12, 15);
const target = corner ? cell(9, 14) : cell(60, 19);
const cornerTower = { kind: "piercing", sites: [[8, 8], [7, 8], [6, 8], [5, 8]] };
const groups = [
  { kind: "piercing", sites: [[11, 15], [10, 15], [9, 15], [8, 15]] },
  { kind: "burst", sites: [[17, 14], [17, 13], [18, 13], [18, 14]] },
  { kind: "piercing", sites: [[21, 14], [21, 13], [21, 12], [21, 11]] },
  { kind: "burst", sites: [[22, 17], [22, 16], [23, 16], [23, 17]] },
];
const profile = { hp: 14, contactDamage: 1 };

function open(col, row) {
  if (edge) return true;
  if (corner) return (col >= 5 && col <= 9 && row === 8)
    || (col >= 8 && col <= 12 && row === 9) || (col === 9 && row >= 10 && row <= 14);
  return (col >= 8 && col <= 20 && row >= 11 && row <= 15) || (col === 20 && row >= 16 && row <= 17)
    || (col === 21 && row >= 11 && row <= 19) || (col >= 22 && col <= 23 && row >= 16 && row <= 17)
    || (row === target.row && col >= 21 && col <= target.col);
}

const playerSpawn = corner ? cell(8, 9) : edge ? cell(17, 12) : cell(14, 12);
const layout = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, col) => {
  if (col === playerSpawn.col && row === playerSpawn.row) return "S";
  if (col === target.col && row === target.row) return "G";
  return open(col, row) ? "." : "#";
}).join(""));

class TargetingFixture extends GridScene {
  create() {
    super.create();
    this.turn = undefined;
    this.shortEvents = [];
    const simulation = this.defense.simulation;
    const stats = document.getElementById("defense-stats").dataset;
    if (short) {
      const noteEvent = this.defense.onEvent.bind(this.defense);
      this.defense.onEvent = (event, metadata) => {
        if (event.type === "towerShot" || event.type === "towerEffect") {
          this.shortEvents.push({ event, metadata, timeMs: simulation.timeMs });
        }
        noteEvent(event, metadata);
      };
    }

    if (edge) {
      this.standard = this.place({ sites: [[8, 8]] });
      this.burst = this.place({ kind: "burst", sites: [[25, 8], [24, 8], [24, 7], [23, 7]] });
    } else if (!corner) {
      for (const group of mode === "single" ? groups.slice(0, 1) : groups) this.place(group);
    }

    window.targetingFixture = {
      start: (count) => {
        if (edge) {
          const positions = [[13.65, 8.5], [13.8, 8.5], [29.65, 8.5], [30.5, 8.5], [31.64, 8.5], [31.75, 8.5]];
          const requested = simulation.spawn(positions.length, 1, profile);
          [...simulation.enemies].forEach((enemy, index) => {
            const [x, y] = positions[index];
            enemy.cell = cell(Math.floor(x), Math.floor(y));
            enemy.point = { x: x * TILE_SIZE, y: y * TILE_SIZE };
            enemy.move = { to: cell(enemy.cell.col, 9), end: { x: enemy.point.x, y: enemy.point.y + TILE_SIZE },
              elapsedMs: 0, durationMs: 1_000 };
          });
          return requested;
        }
        if (corner) return simulation.requestWave(1, { count, wallDamage: 1, enemyHp: 4, contactDamage: 1 },
          { intervalMs: 100, armor: { hp: 14, slots: [0] } });
        return count === "sustained" ? simulation.requestWave(6, {
          count: 180, wallDamage: 1, enemyHp: profile.hp, contactDamage: profile.contactDamage,
        }, { intervalMs: 100 }) : simulation.spawn(count, 1, profile);
      },
      snapshot: () => ({
        turn: this.turn, timeMs: simulation.timeMs, counts: simulation.spawnCounts, visible: Number(stats.visible),
        effects: stats.towerEffects && JSON.parse(stats.towerEffects), shortEvents: this.shortEvents.slice(0, 18),
        health: short ? [...simulation.enemies].map(({ id, hp }) => [id, hp]) : null,
        towers: { standard: this.standard?.id, burst: this.burst?.id },
      }),
      metrics: () => simulation.towerTargetingMetrics,
      visibility: () => ({ current: this.fog.visibility(entry), far: this.fog.visibility(cell(columns - 1, 2)) }),
    };
  }

  place({ kind, sites }) {
    const [origin] = sites.map(([col, row]) => {
      const placed = this.terrain.placeBuilding("tower", cell(col, row));
      if (!placed) throw new Error(`Could not place tower at (${col}, ${row})`);
      return placed.cell;
    });
    const built = this.terrain.getBuilding(origin);
    if (!built || built.evolution?.kind !== kind) throw new Error(`Expected ${kind ?? "ordinary"} tower`);
    return built;
  }

  update(time, delta) {
    if (corner && !this.turn) {
      const simulation = this.defense.simulation;
      const [enemy] = simulation.enemies;
      if (enemy?.move?.to.row === 10 && enemyPosition(enemy).y > 9.55) {
        const tower = this.place(cornerTower);
        this.turn = { timeMs: simulation.timeMs, to: enemy.move.to, enemyId: enemy.id, kind: enemy.kind, hp: enemy.hp,
          center: enemyPosition(enemy), towerId: tower.id };
      }
    }
    super.update(time, delta);
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
  scene: new TargetingFixture(layout, {
    entry, target, buildingBalance: "w25", fogEnabled: true, debugControls: true, towerEvolution: true,
    towerTuning: PLAYTEST_TOWER_TUNING, towerTargeting: mode !== "legacy-corner",
    towerTargetingDiagnostics: short ? "trace" : "metrics",
  }, true),
});

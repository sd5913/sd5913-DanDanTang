import Phaser from "phaser";
import { enemyPosition } from "../src/defense-simulation.ts";
import { PLAYTEST_PROFILE } from "../src/launch-config.ts";
import { TILE_SIZE } from "../src/player.ts";
import "../src/style.css";
import { GridScene } from "../src/scene.ts";

const cell = (col, row) => ({ col, row });
const params = new URLSearchParams(location.search);
const mode = params.get("fixture");
const stress = mode === "stress";
const corner = mode === "corner";
const boundary = mode === "burst-edge" || mode === "burst-outside";
const blocker = mode === "rock" ? "#" : mode === "dirt" ? "+" : undefined;
const legacy = params.get("legacy") === "1";
const tuning = PLAYTEST_PROFILE.towerTuning;
const fallbackRange = tuning.piercingFallbackRange ?? 3;
const burstRange = tuning.burstRange ?? 4;
const columns = 64;
const rows = 32;
const tower = cell(10, 10);
const gate = cell(12, 10);
const turn = cell(corner ? tower.col + fallbackRange : 14, 10);
const entry = stress ? cell(12, 16) : boundary ? cell(17, 10) : cell(turn.col + 3, 10);
const goal = stress ? cell(55, 16) : cell(turn.col, 27);
const player = stress ? cell(16, 15) : cell(11, 11);
const ring = Array.from({ length: 35 }, (_, index) => cell(6 + (index % 7), 8 + Math.floor(index / 7)))
  .filter(({ col, row }) => col === 6 || col === 12 || row === 8 || row === 12);

function mapTile(col, row) {
  if (col === player.col && row === player.row) return "S";
  if (col === goal.col && row === goal.row) return "G";
  if (blocker && col === 13 && row === 10) return blocker;
  if (boundary) return col > 2 && col < 30 && row > 3 && row < 25 ? "." : "#";
  if (stress) return col > 2 && col <= 55 && row >= 9 && row <= 23 ? "." : "#";
  if (col >= 6 && col <= 12 && row >= 8 && row <= 12) return ".";
  if (row === 10 && col >= 13 && col <= entry.col) return ".";
  if (col === turn.col && row > 10 && row <= goal.row) return ".";
  return "#";
}

const layout = Array.from({ length: rows }, (_, row) =>
  Array.from({ length: columns }, (_, col) => mapTile(col, row)).join(""));

class WallFixture extends GridScene {
  create() {
    super.create();
    const simulation = this.defense.simulation;
    this.turnCapture = undefined;
    this.hitTrace = [];
    this.landings = new Map();
    const original = this.defense.onEvent.bind(this.defense);
    this.defense.onEvent = (event, metadata) => {
      if (event.type === "towerShot" || event.type === "towerEffect" || event.type === "wallImpact") {
        if (!stress) this.hitTrace.push({ at: simulation.timeMs, event, metadata });
        if (event.type === "towerEffect") {
          const { kind } = event.effect;
          const current = this.landings.get(kind) ?? { fires: 0, maxTargets: 0 };
          current.fires += 1;
          current.maxTargets = Math.max(current.maxTargets, event.enemyIds.length);
          this.landings.set(kind, current);
        }
      }
      original(event, metadata);
    };
    if (stress) {
      this.placeTower([[9, 16], [8, 16], [7, 16], [6, 16]]);
      this.placeTower([[19, 13], [19, 12], [19, 11], [19, 10]]);
      this.placeTower([[16, 13], [16, 12], [17, 12], [17, 13]]);
      for (const [col, row] of [[10, 16], [19, 14], [17, 14], [16, 14]]) this.placeWall(cell(col, row));
    } else {
      for (const position of ring) this.placeWall(position);
      if (!corner) this.placeTower(boundary ? [[10, 10], [9, 10], [9, 9], [8, 9]]
        : [[10, 10], [9, 10], [8, 10], [7, 10]]);
    }

    window.wallFixture = {
      start: (count) => {
        if (boundary) return this.startBurst();
        if (corner || blocker) {
          return simulation.requestWave(1, { count: 1, wallDamage: 1, enemyHp: 4, contactDamage: 1 },
            { intervalMs: 100, armor: { hp: 14, slots: [0] } });
        }
        if (count === "sustained") {
          return simulation.requestWave(6, { count: 180, wallDamage: 1, enemyHp: 14, contactDamage: 1 }, { intervalMs: 100 });
        }
        return simulation.spawn(count, 1, { hp: 14, contactDamage: 1 });
      },
      snapshot: (trace = false) => ({
        turn: this.turnCapture, timeMs: simulation.timeMs, counts: simulation.spawnCounts, landings: Object.fromEntries(this.landings),
        visible: Number(document.querySelector("#defense-stats").dataset.visible),
        currentVisibility: this.fog.visibility(entry), farVisibility: this.fog.visibility(cell(columns - 1, 2)),
        wallHp: this.terrain.getBuilding(gate)?.hp,
        health: stress ? null : [...simulation.enemies].map(({ id, hp }) => [id, hp]),
        hitTrace: stress ? undefined : this.hitTrace,
        targeting: trace ? simulation.towerTargetingTrace : undefined,
        metrics: trace || stress ? simulation.towerTargetingMetrics : undefined,
      }),
    };
  }

  placeWall(position) {
    if (!this.terrain.placeBuilding("wall", position)) throw Error("Could not build the controlled friendly wall");
  }

  placeTower(positions) {
    for (const [col, row] of positions) {
      if (!this.terrain.placeBuilding("tower", cell(col, row))) throw Error("Controlled tower site is occupied");
    }
    const [col, row] = positions[0];
    const tower = this.terrain.synthesizeBuilding(cell(col, row));
    if (!tower?.evolution) throw Error("Controlled tower did not synthesize");
    return tower;
  }

  startBurst() {
    const simulation = this.defense.simulation;
    const startX = tower.col + 0.5 + burstRange;
    const positions = mode === "burst-outside" ? [[startX + 0.28, 10.5]]
      : [[startX + 0.15, 10.5], [startX + 0.95, 11.1], [startX + 1.55, 11.4], [startX + 2.4, 11.5]];
    const count = simulation.spawn(positions.length, 1, { hp: 14, contactDamage: 1 });
    // Stage this controlled boundary sample at precise fractional positions, then let the scene move each unit normally.
    for (const [index, enemy] of [...simulation.enemies].entries()) {
      const [x, y] = positions[index];
      enemy.cell = cell(Math.floor(x), Math.floor(y));
      enemy.point = { x: x * TILE_SIZE, y: y * TILE_SIZE };
      enemy.move = { to: cell(enemy.cell.col, 12), end: { x: enemy.point.x, y: 12.5 * TILE_SIZE },
        elapsedMs: 0, durationMs: 1_000 };
    }
    return count;
  }

  update(time, delta) {
    if (corner && !this.turnCapture) {
      const simulation = this.defense.simulation;
      const [enemy] = simulation.enemies;
      if (enemy?.move?.to.row === 11 && enemyPosition(enemy).y > 10.77) {
        const retained = this.placeTower([[10, 10], [9, 10], [8, 10], [7, 10]]);
        this.turnCapture = { at: simulation.timeMs, center: enemyPosition(enemy), hp: enemy.hp,
          towerId: retained.id, enemyId: enemy.id, to: enemy.move.to, gateHp: this.terrain.getBuilding(gate).hp };
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
  scene: new WallFixture(layout, {
    entry, target: goal, buildingBalance: PLAYTEST_PROFILE.buildingBalance, fogEnabled: true,
    debugControls: false, towerEvolution: true, manualMerge: true, towerTuning: tuning,
    towerTargeting: true, towerWallSynergy: !legacy, towerTargetingDiagnostics: stress ? "metrics" : "trace",
  }, true),
});

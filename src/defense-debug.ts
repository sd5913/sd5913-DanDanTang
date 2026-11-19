import Phaser from "phaser";
import type { BuildingKind } from "./buildings.ts";
import { DefenseSimulation, enemyPosition, sameCell } from "./defense-simulation.ts";
import type { DefenseEvent } from "./defense-simulation.ts";
import { cellCenter, PLAYER_HALF_SIZE, TILE_SIZE } from "./player.ts";
import type { Player } from "./player.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

const SHOT_VISIBLE_MS = 140;

function field<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing defense field #${id}`);
  return element as T;
}

function write(field: HTMLElement, text: string): void {
  if (field.textContent !== text) field.textContent = text;
}

function coordinates({ col, row }: GridPosition): string { return `(${col}, ${row})`; }

type Shot = Extract<DefenseEvent, { type: "towerShot" }>;

interface DefenseScenario {
  readonly entry: GridPosition;
  readonly target: GridPosition;
}

export class DefenseDebug {
  private readonly map: TerrainMap;
  private readonly player: Player;
  private readonly scenario: DefenseScenario;
  private readonly simulation: DefenseSimulation;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly labelLayer: Phaser.GameObjects.Layer;
  private readonly labels: Phaser.GameObjects.Text[] = [];
  private readonly stats = field("defense-stats");
  private readonly combatStats = field("defense-combat-stats");
  private readonly status = field("defense-feedback");
  private readonly hover = field("defense-hover");
  private readonly count = field<HTMLSelectElement>("spawn-count");
  private readonly damage = field<HTMLSelectElement>("spawn-damage");
  private readonly playerTarget = field<HTMLInputElement>("test-player-target");
  private readonly keys: Record<"B" | "T" | "X", Phaser.Input.Keyboard.Key>;
  private shots: { readonly event: Shot; readonly expires: number }[] = [];
  private timeMs = 0;

  constructor(scene: Phaser.Scene, map: TerrainMap, player: Player, scenario: DefenseScenario) {
    this.map = map;
    this.player = player;
    this.scenario = scenario;
    this.simulation = new DefenseSimulation(map, scenario.entry, scenario.target, (event) => this.onEvent(event));
    this.graphics = scene.add.graphics().setDepth(1.5);
    this.labelLayer = scene.add.layer().setDepth(2.5);
    this.keys = scene.input.keyboard!.addKeys("B,T,X", false) as typeof this.keys;
    const panel = field("defense-panel");
    const spawn = field<HTMLButtonElement>("spawn-enemies");
    panel.hidden = false;
    spawn.addEventListener("click", this.spawn);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      spawn.removeEventListener("click", this.spawn);
      panel.hidden = true;
    });
  }

  update(deltaMs: number, cell: GridPosition | null): void {
    if (Phaser.Input.Keyboard.JustDown(this.keys.B)) this.place("wall", cell);
    if (Phaser.Input.Keyboard.JustDown(this.keys.T)) this.place("tower", cell);
    if (Phaser.Input.Keyboard.JustDown(this.keys.X) && cell) {
      const removed = this.map.removeBuilding(cell);
      write(this.status, removed ? `已拆除 ${coordinates(cell)}` : "指向格没有建筑");
    }
    const elapsed = Math.min(deltaMs, 50);
    this.timeMs += elapsed;
    this.simulation.step(elapsed, this.playerTarget.checked ? this.player.cell : undefined);
  }

  render(view: Phaser.Geom.Rectangle, cell: GridPosition | null): void {
    const graphics = this.graphics.clear();
    let labelCount = 0;
    for (const building of this.map.getBuildings()) {
      const { x, y } = cellCenter(building.cell);
      if (x < view.left - TILE_SIZE / 2 || x > view.right + TILE_SIZE / 2
        || y < view.top - TILE_SIZE / 2 || y > view.bottom + TILE_SIZE / 2) continue;
      if (building.kind === "wall") {
        graphics.fillStyle(0x82563d).fillRect(x - 10, y - 10, 20, 20);
        graphics.lineStyle(1, 0xecc69b).strokeRect(x - 10, y - 10, 20, 20);
        this.wallLabel(labelCount++, x, y, building.hp);
      } else {
        graphics.fillStyle(0x73d4cc).fillTriangle(x, y - 9, x + 9, y + 8, x - 9, y + 8);
      }
    }
    for (let i = labelCount; i < this.labels.length; i += 1) this.labels[i].setVisible(false);

    this.shots = this.shots.filter((trace) => trace.expires > this.timeMs);
    for (const { event } of this.shots) {
      const start = cellCenter(event.from);
      const endX = event.to.x * TILE_SIZE;
      const endY = event.to.y * TILE_SIZE;
      if (Math.max(start.x, endX) < view.left || Math.min(start.x, endX) > view.right
        || Math.max(start.y, endY) < view.top || Math.min(start.y, endY) > view.bottom) continue;
      graphics.lineStyle(2, 0x9af5ff).lineBetween(start.x, start.y, endX, endY);
    }

    let active = 0;
    let visible = 0;
    let northRow = Infinity;
    let unreachable = 0;
    for (const enemy of this.simulation.enemies) {
      active += 1;
      northRow = Math.min(northRow, enemy.cell.row);
      if (enemy.unreachable) unreachable += 1;
      const point = enemyPosition(enemy);
      const x = point.x * TILE_SIZE;
      const y = point.y * TILE_SIZE;
      if (!view.contains(x, y)) continue;
      visible += 1;
      graphics.fillStyle(0xec817a).fillCircle(x, y, 5);
      graphics.lineStyle(1, 0x582c35).strokeCircle(x, y, 5);
    }

    this.showStats(active, visible, Number.isFinite(northRow) ? northRow : -1, unreachable);
    const building = cell && this.map.getBuilding(cell);
    const name = building?.kind === "wall" ? "城墙" : "测试塔";
    write(this.hover, building ? `${name} ${coordinates(building.cell)} · ${building.hp} HP` : "—");
  }

  reset(): void {
    this.simulation.reset();
    this.timeMs = 0;
    this.shots = [];
    write(this.status, "等待布防或生成敌人");
  }

  private readonly spawn = (): void => {
    const count = this.simulation.requestSpawn(Number(this.count.value), Number(this.damage.value));
    write(this.status, count ? `已请求 ${count} 只从南端生成` : "出兵请求无效");
  };

  private place(kind: BuildingKind, cell: GridPosition | null): void {
    if (!cell || sameCell(cell, this.scenario.entry) || sameCell(cell, this.scenario.target)
      || this.overlapsPlayer(cell) || this.simulation.occupies(cell)) {
      write(this.status, "请选择未被占用的空地");
      return;
    }
    const building = this.map.placeBuilding(kind, cell, kind === "wall" ? 50 : 1);
    const name = kind === "wall" ? "城墙" : "测试塔";
    write(this.status, building ? `已建造${name} ${coordinates(cell)}` : "只能在未占用的空地建造");
  }

  private overlapsPlayer(cell: GridPosition): boolean {
    const { x, y } = this.player.position;
    const left = cell.col * TILE_SIZE;
    const top = cell.row * TILE_SIZE;
    return x + PLAYER_HALF_SIZE > left && x - PLAYER_HALF_SIZE < left + TILE_SIZE
      && y + PLAYER_HALF_SIZE > top && y - PLAYER_HALF_SIZE < top + TILE_SIZE;
  }

  private onEvent(event: DefenseEvent): void {
    if (event.type === "towerShot") this.shots.push({ event, expires: this.timeMs + SHOT_VISIBLE_MS });
    if (event.type === "wallImpact") {
      const result = event.destroyed ? "墙已毁" : `墙剩 ${event.hp} HP`;
      write(this.status, `撞墙 · -${event.damage} HP · ${result}`);
    }
    if (event.type === "towerKill") write(this.status, `测试塔击杀敌人 ${event.enemyId}`);
  }

  private wallLabel(index: number, x: number, y: number, hp: number): void {
    let label = this.labels[index];
    if (!label) {
      label = this.graphics.scene.add.text(0, 0, "", { fontFamily: "Consolas, monospace", fontSize: "12px", color: "#ffffff" })
        .setOrigin(0.5);
      this.labelLayer.add(label);
      this.labels.push(label);
    }
    label.setPosition(x, y).setVisible(true).setText(String(hp));
  }

  private showStats(active: number, visible: number, northRow: number, unreachable: number): void {
    const { requested, spawned, pending, removed } = this.simulation.spawnCounts;
    const stats = { requested, spawned, pending, active, visible, removed, northRow, unreachable,
      searches: this.simulation.searchCount, ...this.simulation.counters };
    for (const [key, value] of Object.entries(stats)) {
      const text = String(value);
      if (this.stats.dataset[key] !== text) this.stats.dataset[key] = text;
    }
    write(this.stats, `请求 ${requested} · 已生成 ${spawned} · 待生成 ${pending} · 存活 ${active} · 可见 ${visible} · 已移除 ${removed}`);
    write(this.combatStats, `无路 ${unreachable} · 撞墙 ${stats.wallImpacts} · 塔击杀 ${stats.towerKills}`);
  }
}

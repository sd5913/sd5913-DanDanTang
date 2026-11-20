import Phaser from "phaser";
import { overlapsCell, placementFailure } from "./build-placement.ts";
import type { PlacementFailure, PlacementPreview } from "./build-placement.ts";
import { DefenseSimulation, enemyPosition, sameCell } from "./defense-simulation.ts";
import type { DefenseEvent, DefenseEventMetadata } from "./defense-simulation.ts";
import type { BuildingKind } from "./buildings.ts";
import { BUILDING_NAMES, ExpeditionControls } from "./expedition-controls.ts";
import type { CardKind } from "./expedition-economy.ts";
import type { DifficultyId } from "./expedition-difficulty.ts";
import { ExpeditionRound } from "./expedition-round.ts";
import type { RoundSpeed } from "./expedition-round.ts";
import type { BiomeId } from "./expedition-biomes.ts";
import { cellCenter, TILE_SIZE } from "./player.ts";
import type { Player } from "./player.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";
import { WaveEconomyHistory } from "./wave-economy-history.ts";

const SHOT_VISIBLE_MS = 140;
const METRICS_REFRESH_MS = 200;
const ATTACK_NOTICE_COOLDOWN_MS = 3_000;
const BREACH_NOTICE_MS = 4_500;

function field<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing defense field #${id}`);
  return element as T;
}

function write(field: HTMLElement, text: string): void {
  if (field.textContent !== text) field.textContent = text;
}

function coordinates({ col, row }: GridPosition): string { return `(${col}, ${row})`; }

function relativeDirection(player: GridPosition, building: GridPosition): string {
  const dx = building.col - player.col;
  const dy = building.row - player.row;
  if (dx === 0 && dy === 0) return "附近";
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? "南侧" : "北侧";
  return dx > 0 ? "东侧" : "西侧";
}

type Shot = Extract<DefenseEvent, { type: "towerShot" }>;

export interface DefenseScenario {
  readonly entry: GridPosition;
  readonly target: GridPosition;
  readonly worldSeed?: number;
  readonly fogEnabled?: boolean;
  readonly roundSpeed?: RoundSpeed;
  readonly difficulty?: DifficultyId;
  readonly debugControls?: boolean;
}

export class DefenseDebug {
  private readonly map: TerrainMap;
  private readonly player: Player;
  private readonly scenario: DefenseScenario;
  private readonly isVisible: (cell: GridPosition) => boolean;
  private readonly simulation: DefenseSimulation;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly labelLayer: Phaser.GameObjects.Layer;
  private readonly labels: Phaser.GameObjects.Text[] = [];
  private readonly stats = field("defense-stats");
  private readonly combatStats = field("defense-combat-stats");
  private readonly status = field("defense-feedback");
  private readonly breach = field("round-breach");
  private readonly hover = field("defense-hover");
  private readonly count = field<HTMLSelectElement>("spawn-count");
  private readonly damage = field<HTMLSelectElement>("spawn-damage");
  private readonly playerTarget = field<HTMLInputElement>("test-player-target");
  private readonly keys?: Record<"B" | "T" | "X", Phaser.Input.Keyboard.Key>;
  private readonly expedition?: ExpeditionControls;
  private readonly round?: ExpeditionRound;
  private readonly economyHistory?: WaveEconomyHistory;
  private shots: { readonly event: Shot; readonly expires: number }[] = [];
  private timeMs = 0;
  private nextMetricsAtMs = 0;
  private readonly attackNoticeAt = new Map<string, number>();
  private breachExpiresAtMs = 0;

  constructor(scene: Phaser.Scene, map: TerrainMap, player: Player, scenario: DefenseScenario,
    isVisible: (cell: GridPosition) => boolean) {
    this.map = map;
    this.player = player;
    this.scenario = scenario;
    this.isVisible = isVisible;
    this.simulation = new DefenseSimulation(
      map, scenario.entry, scenario.target, (event, metadata) => this.onEvent(event, metadata), scenario.worldSeed !== undefined,
    );
    this.graphics = scene.add.graphics().setDepth(1.5);
    this.labelLayer = scene.add.layer().setDepth(2.5);
    if (scenario.worldSeed !== undefined) {
      this.round = new ExpeditionRound(scenario.roundSpeed, scenario.difficulty);
      this.expedition = new ExpeditionControls(scene, map, scenario.worldSeed, this.round, {
        debug: scenario.debugControls === true,
        spawnEnemy: () => this.spawnPrototypeEnemy(),
        spawnStress: (count) => this.spawnStress(count),
        checkPlacement: (cell, kind) => this.checkPlacement(cell, kind),
      });
      this.economyHistory = new WaveEconomyHistory(this.expedition.economy.totals);
      this.publishWaveMetrics(true);
      return;
    }
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
    if (this.roundEnded) return;
    if (this.keys && Phaser.Input.Keyboard.JustDown(this.keys.B)) this.place("wall", cell);
    if (this.keys && Phaser.Input.Keyboard.JustDown(this.keys.T)) this.place("tower", cell);
    if (this.keys && Phaser.Input.Keyboard.JustDown(this.keys.X) && cell) {
      const removed = this.map.removeBuilding(cell);
      write(this.status, removed ? `已拆除 ${coordinates(cell)}` : "指向格没有建筑");
    }
    const elapsed = Math.min(deltaMs, 50);
    this.timeMs += elapsed;
    if (!this.breach.hidden && this.timeMs >= this.breachExpiresAtMs) this.clearBreach();
    if (this.round && this.expedition) {
      const { spawned, removed, pending } = this.simulation.spawnCounts;
      const phase = this.round.phase;
      const wave = this.round.update(elapsed, this.player.cell.row, spawned - removed, pending);
      if (wave) {
        this.economyHistory?.startWave(this.round.wave, this.expedition.economy.totals);
        this.simulation.requestWave(this.round.wave, wave);
      }
      if (phase === "attacking" && this.round.phase === "recovering") {
        this.simulation.finishAttackPhase(this.round.wave, spawned === removed && pending === 0 ? "resolved" : "time-limit");
      }
      this.expedition.economy.advance(elapsed);
      this.simulation.step(elapsed, this.player.cell);
      this.expedition.showRound(this.round);
      this.expedition.refresh();
      this.publishWaveMetrics(phase !== this.round.phase);
    } else {
      this.simulation.step(elapsed, this.playerTarget.checked ? this.player.cell : undefined);
    }
  }

  render(view: Phaser.Geom.Rectangle, cell: GridPosition | null): PlacementPreview | undefined {
    const { isVisible } = this;
    const graphics = this.graphics.clear();
    let labelCount = 0;
    for (const building of this.map.getBuildings()) {
      if (!isVisible(building.cell)) continue;
      const { x, y } = cellCenter(building.cell);
      if (x < view.left - TILE_SIZE / 2 || x > view.right + TILE_SIZE / 2
        || y < view.top - TILE_SIZE / 2 || y > view.bottom + TILE_SIZE / 2) continue;
      if (building.kind === "wall") {
        graphics.fillStyle(0x82563d).fillRect(x - 10, y - 10, 20, 20);
        graphics.lineStyle(1, 0xecc69b).strokeRect(x - 10, y - 10, 20, 20);
        this.wallLabel(labelCount++, x, y, building.hp);
      } else if (building.kind === "tower") {
        graphics.fillStyle(0x73d4cc).fillTriangle(x, y - 9, x + 9, y + 8, x - 9, y + 8);
      } else {
        const color = building.kind === "economy" ? 0x927137 : 0x676299;
        graphics.fillStyle(color).fillRoundedRect(x - 10, y - 10, 20, 20, 3);
        this.wallLabel(labelCount++, x, y, building.hp);
      }
      if (building.level === 2) graphics.lineStyle(1, 0x8de6ca).strokeRect(x - 11, y - 11, 22, 22);
    }
    for (let i = labelCount; i < this.labels.length; i += 1) this.labels[i].setVisible(false);

    this.shots = this.shots.filter((trace) => trace.expires > this.timeMs);
    for (const { event } of this.shots) {
      if (!isVisible(event.from) || !isVisible({ col: Math.floor(event.to.x), row: Math.floor(event.to.y) })) continue;
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
      if (!isVisible({ col: Math.floor(point.x), row: Math.floor(point.y) })) continue;
      const x = point.x * TILE_SIZE;
      const y = point.y * TILE_SIZE;
      if (!view.contains(x, y)) continue;
      visible += 1;
      graphics.fillStyle(0xec817a).fillCircle(x, y, 5);
      graphics.lineStyle(1, 0x582c35).strokeCircle(x, y, 5);
    }

    this.showStats(active, visible, Number.isFinite(northRow) ? northRow : -1, unreachable);
    const building = cell && isVisible(cell) ? this.map.getBuilding(cell) : undefined;
    const name = building && (building.kind === "tower" && !this.expedition ? "测试塔" : BUILDING_NAMES[building.kind]);
    const level = building?.level === 2 ? " · Lv.2" : "";
    const description = building ? `${name} ${coordinates(building.cell)} · ${building.hp} HP${level}` : "—";
    write(this.hover, description);
    this.expedition?.showBuilding(description);
    return this.expedition?.previewPlacement(cell);
  }

  reset(): void {
    this.simulation.reset();
    this.timeMs = 0;
    this.nextMetricsAtMs = 0;
    this.attackNoticeAt.clear();
    this.clearBreach();
    this.shots = [];
    if (this.round && this.expedition) {
      this.round.reset();
      this.expedition.showRound(this.round);
      this.expedition.reset();
      this.economyHistory?.reset(this.expedition.economy.totals);
      this.publishWaveMetrics(true);
    }
    write(this.status, "等待布防或生成敌人");
  }

  placeSelectedCard(cell: GridPosition): boolean {
    return this.expedition?.placeSelected(cell) ?? false;
  }

  get roundEnded(): boolean { return this.round?.phase === "won" || this.round?.phase === "lost"; }

  reachGoal(): boolean {
    if (!this.round) return true;
    if (!this.round.reachGoal(this.toolLevel)) return false;
    this.stopCombat();
    return true;
  }

  get toolLevel(): 1 | 2 { return this.expedition?.economy.toolLevel ?? 1; }

  creditMiningDamage(damage: number): number {
    const expedition = this.expedition;
    if (!expedition) return 0;
    const income = expedition.economy.creditMiningDamage(damage);
    if (income > 0) expedition.refresh();
    return income;
  }

  showBiome(biome: BiomeId): void { this.expedition?.showBiome(biome); }

  private readonly spawn = (): void => {
    const count = this.simulation.requestSpawn(Number(this.count.value), Number(this.damage.value));
    write(this.status, count ? `已请求 ${count} 只从南端生成` : "出兵请求无效");
  };

  private spawnPrototypeEnemy(): void {
    if (this.simulation.requestSpawn(1, 1)) this.expedition?.showFeedback("已请求 1 只从南端生成");
  }

  private spawnStress(count: number): void {
    if (count === 50 || count === 100 || count === 250) this.simulation.spawn(count, 1);
  }

  private stopCombat(): void {
    this.simulation.clearBattle();
    this.publishWaveMetrics(true);
    this.shots = [];
    if (!this.round || !this.expedition) return;
    this.expedition.showRound(this.round);
    this.expedition.refresh();
  }

  private place(kind: "wall" | "tower", cell: GridPosition | null): void {
    if (!cell || !this.canPlaceAt(cell)) {
      write(this.status, "请选择未被占用的空地");
      return;
    }
    const building = this.map.placeBuilding(kind, cell, kind === "wall" ? 50 : 1);
    const name = kind === "wall" ? "城墙" : "测试塔";
    if (!building) {
      write(this.status, "只能在未占用的空地建造");
      return;
    }
    write(this.status, building.level === 2
      ? `已合成${name} Lv.2 ${coordinates(building.cell)}`
      : `已建造${name} ${coordinates(cell)}`);
  }

  private canPlaceAt(cell: GridPosition): boolean {
    return !sameCell(cell, this.scenario.entry) && !sameCell(cell, this.scenario.target)
      && !overlapsCell(this.player.position, cell) && !this.simulation.occupies(cell);
  }

  private readonly enemyOccupies = (cell: GridPosition): boolean => this.simulation.occupies(cell);

  private checkPlacement(cell: GridPosition, kind: CardKind | "technology"): PlacementFailure | undefined {
    const economy = this.expedition?.economy;
    const reserved = sameCell(cell, this.scenario.entry) || sameCell(cell, this.scenario.target)
      || (kind !== "technology" && economy !== undefined && sameCell(cell, economy.technologyCell));
    return placementFailure(this.map, cell, {
      playerPosition: this.player.position,
      roundEnded: this.roundEnded,
      visible: this.isVisible(cell),
      reserved,
      enemyOccupies: this.enemyOccupies,
      cardCount: kind === "technology" ? undefined : economy?.cards[kind] ?? 0,
    });
  }

  private publishWaveMetrics(force = false): void {
    if (!this.scenario.debugControls || (!force && this.nextMetricsAtMs > this.timeMs)) return;
    this.nextMetricsAtMs = this.timeMs + METRICS_REFRESH_MS;
    const text = JSON.stringify(this.simulation.waveMetrics);
    if (this.stats.dataset.waveCombat !== text) this.stats.dataset.waveCombat = text;
    if (this.expedition && this.economyHistory) {
      const economy = JSON.stringify(this.economyHistory.snapshot(this.expedition.economy.totals));
      if (this.stats.dataset.waveEconomy !== economy) this.stats.dataset.waveEconomy = economy;
    }
  }

  private onEvent(event: DefenseEvent, metadata: DefenseEventMetadata): void {
    const credit = this.expedition?.economy.handleEvent(event) ?? 0;
    this.economyHistory?.creditKill(metadata.waveId, credit);
    if (event.type === "towerShot") this.shots.push({ event, expires: this.timeMs + SHOT_VISIBLE_MS });
    if (event.type === "wallImpact") {
      const result = event.destroyed ? "墙已毁" : `墙剩 ${event.hp} HP`;
      write(this.status, `撞墙 · -${event.damage} HP · ${result}`);
      if (metadata.cell) this.showBuildingAttack("wall", metadata.cell, event.hp, event.destroyed);
    }
    if (event.type === "towerKill") write(this.status, `测试塔击杀敌人 ${event.enemyId}`);
    if (event.type === "buildingHit") this.showBuildingAttack(event.buildingKind, event.cell, event.hp, event.destroyed);
    if (event.type === "playerHit" && this.round) {
      const previousHp = this.round.playerHp;
      this.round.hitPlayer(event.damage);
      const damage = previousHp - this.round.playerHp;
      this.simulation.recordPlayerDamage(metadata.waveId, damage);
      if (damage > 0) this.expedition?.showFeedback(`玩家受袭 · -${damage} HP`);
      if (this.roundEnded) this.stopCombat();
    }
  }

  private showBuildingAttack(kind: BuildingKind, cell: GridPosition, hp: number, destroyed: boolean): void {
    if (!this.expedition) return;
    const position = coordinates(cell);
    if (destroyed) {
      this.attackNoticeAt.delete(position);
    } else {
      if (this.timeMs < (this.attackNoticeAt.get(position) ?? 0)) return;
      this.attackNoticeAt.set(position, this.timeMs + ATTACK_NOTICE_COOLDOWN_MS);
    }

    const name = BUILDING_NAMES[kind];
    if (kind === "wall" && destroyed) {
      this.breachExpiresAtMs = this.timeMs + BREACH_NOTICE_MS;
      this.breach.hidden = false;
      write(this.breach, `${relativeDirection(this.player.cell, cell)}防线被突破 · ${name} ${position} 已摧毁`);
      return;
    }
    this.expedition.showFeedback(`${name} ${position} 受袭 · ${destroyed ? "已摧毁" : `剩 ${hp} HP`}`);
  }

  private clearBreach(): void {
    this.breach.hidden = true;
    this.breachExpiresAtMs = 0;
    write(this.breach, "");
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
      searches: this.simulation.searchCount, searchMs: this.simulation.searchTimeMs.toFixed(3), ...this.simulation.counters };
    for (const [key, value] of Object.entries(stats)) {
      const text = String(value);
      if (this.stats.dataset[key] !== text) this.stats.dataset[key] = text;
    }
    write(this.stats, `请求 ${requested} · 已生成 ${spawned} · 待生成 ${pending} · 存活 ${active} · 可见 ${visible} · 已移除 ${removed}`);
    write(this.combatStats, `无路 ${unreachable} · 撞墙 ${stats.wallImpacts} · 塔击杀 ${stats.towerKills}`);
  }
}

import Phaser from "phaser";
import { evolvedTowerAttributes, productionAttributes, towerAttributes } from "./building-balance.ts";
import type { BuildingBalanceId, TowerTuning } from "./building-balance.ts";
import { overlapsCell, placementFailure } from "./build-placement.ts";
import type { PlacementFailure, PlacementPreview } from "./build-placement.ts";
import { DefenseSimulation, enemyWorldPosition, sameCell } from "./defense-simulation.ts";
import type { DefenseEvent, DefenseEventMetadata, EnemyKind, TowerEffect } from "./defense-simulation.ts";
import { ENEMY_RADIUS } from "./enemy-contact.ts";
import { EvacuationHud } from "./evacuation-hud.ts";
import type { Building, BuildingKind, BuildingSynthesisPreview, TowerEvolution } from "./buildings.ts";
import { BUILDING_NAMES, evolutionDirection, evolutionName, ExpeditionControls } from "./expedition-controls.ts";
import type { CardKind } from "./expedition-economy.ts";
import type { DifficultyId } from "./expedition-difficulty.ts";
import { ExpeditionRound } from "./expedition-round.ts";
import type { RoundSpeed, WaveOrder } from "./expedition-round.ts";
import type { BiomeId } from "./expedition-biomes.ts";
import { MergeControls } from "./merge-controls.ts";
import type { MergeRouteKnowledge } from "./merge-route-preview.ts";
import { evacuationDeployment, MIDGAME_EXPERIMENTS, waveDeployment } from "./midgame-experiments.ts";
import type { MidgameExperimentId } from "./midgame-experiments.ts";
import { cellCenter, TILE_SIZE, worldToCell } from "./player.ts";
import type { Player, Point } from "./player.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";
import { buildEvolvedTowerCoverage, PIERCING_FALLBACK } from "./tower-attack.ts";
import { WaveEconomyHistory } from "./wave-economy-history.ts";

const SHOT_VISIBLE_MS = 140;
const METRICS_REFRESH_MS = 200;
const ATTACK_NOTICE_COOLDOWN_MS = 3_000;
const BREACH_NOTICE_MS = 4_500;
const HIT_MARKER_MS = 160;
const MAX_CONTACT_RECORDS = 24;
const MAX_TOWER_EFFECT_RECORDS = 12;
const MERGE_RELEASE_MS = 1_800;

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

type Shot = Extract<DefenseEvent, { type: "towerShot" | "towerEffect" }>;
type TowerEffectTrace = { readonly timeMs: number } & Omit<Extract<Shot, { type: "towerEffect" }>, "type">;
type HitTrace = NonNullable<DefenseEventMetadata["contact"]> & {
  readonly timeMs: number;
  readonly enemyId: number;
  readonly hpBefore: number;
  readonly hpAfter: number;
  readonly playerCell: GridPosition;
};

export interface DefenseScenario {
  readonly entry: GridPosition;
  readonly target: GridPosition;
  readonly worldSeed?: number;
  readonly fogEnabled?: boolean;
  readonly roundSpeed?: RoundSpeed;
  readonly difficulty?: DifficultyId;
  readonly buildingBalance?: BuildingBalanceId;
  readonly midgame?: MidgameExperimentId;
  readonly debugControls?: boolean;
  readonly towerEvolution?: boolean;
  readonly manualMerge?: boolean;
  readonly towerTuning?: TowerTuning;
  readonly evacuation?: boolean;
  readonly towerTargeting?: boolean;
  readonly towerTargetingDiagnostics?: "trace" | "metrics";
}

export class DefenseDebug {
  private readonly map: TerrainMap;
  private readonly player: Player;
  private readonly scenario: DefenseScenario;
  private readonly midgame: MidgameExperimentId;
  private readonly isVisible: (cell: GridPosition) => boolean;
  private readonly simulation: DefenseSimulation;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly labelLayer: Phaser.GameObjects.Layer;
  private readonly labels: Phaser.GameObjects.Text[] = [];
  private readonly stats = field("defense-stats");
  private readonly combatStats = field("defense-combat-stats");
  private readonly contactTrace = field<HTMLTextAreaElement>("player-contact-trace");
  private readonly status = field("defense-feedback");
  private readonly breach = field("round-breach");
  private readonly hover = field("defense-hover");
  private readonly buildingStats = field("expedition-building-stats");
  private readonly count = field<HTMLSelectElement>("spawn-count");
  private readonly damage = field<HTMLSelectElement>("spawn-damage");
  private readonly playerTarget = field<HTMLInputElement>("test-player-target");
  private readonly keys?: Record<"B" | "T" | "X", Phaser.Input.Keyboard.Key>;
  private readonly expedition?: ExpeditionControls;
  private readonly merge?: MergeControls;
  private mergeRelease?: { readonly cells: readonly GridPosition[]; readonly untilMs: number };
  private readonly round?: ExpeditionRound;
  private readonly evacuationHud?: EvacuationHud;
  private readonly economyHistory?: WaveEconomyHistory;
  private shots: { readonly event: Shot; readonly expires: number }[] = [];
  private hitMarkers: { readonly world: Point; readonly kind: EnemyKind; readonly expires: number }[] = [];
  private readonly towerEffectTrace: TowerEffectTrace[] = [];
  private readonly evolvedShots = { piercing: 0, burst: 0, piercingFallback: 0 };
  private readonly pendingContacts: HitTrace[] = [];
  private readonly contactRecords: unknown[] = [];
  private timeMs = 0;
  private nextMetricsAtMs = 0;
  private readonly attackNoticeAt = new Map<string, number>();
  private breachExpiresAtMs = 0;

  constructor(scene: Phaser.Scene, map: TerrainMap, player: Player, scenario: DefenseScenario,
    knowledge: MergeRouteKnowledge) {
    this.map = map;
    this.player = player;
    this.scenario = scenario;
    this.midgame = scenario.difficulty === "challenge" ? scenario.midgame ?? "control" : "control";
    this.isVisible = knowledge.isVisible;
    this.simulation = new DefenseSimulation(
      map, scenario.entry, scenario.target, (event, metadata) => this.onEvent(event, metadata), scenario.worldSeed !== undefined,
      { towerTuning: scenario.towerTuning, towerTargeting: scenario.towerTargeting,
        towerTargetingDiagnostics: scenario.towerTargetingDiagnostics },
    );
    this.graphics = scene.add.graphics().setDepth(1.5);
    this.labelLayer = scene.add.layer().setDepth(2.5);
    if (scenario.worldSeed !== undefined) {
      this.round = new ExpeditionRound(scenario.roundSpeed, scenario.difficulty, scenario.evacuation);
      this.expedition = new ExpeditionControls(scene, map, scenario.worldSeed, this.round, {
        debug: scenario.debugControls === true,
        manualMerge: scenario.manualMerge,
        economyExperiment: MIDGAME_EXPERIMENTS[this.midgame].economy,
        spawnEnemy: () => this.spawnPrototypeEnemy(),
        spawnStress: (count) => this.spawnStress(count),
        checkPlacement: (cell, kind) => this.checkPlacement(cell, kind),
      });
      if (scenario.manualMerge) {
        this.merge = new MergeControls(map, {
          playerCell: () => player.cell,
          isVisible: this.isVisible,
          isKnown: knowledge.isKnown,
          roundEnded: () => this.roundEnded,
          previewRoute: (plan, force) => this.simulation.previewMergeRoute(plan.released, player.cell, knowledge, force),
          describe: (building) => ({
            name: building.evolution ? evolutionName(building.evolution) : `${BUILDING_NAMES[building.kind]} Lv.2`,
            attributes: building.kind === "wall" && !this.isVisible(building.cell)
              ? `最大耐久 ${building.maxHp} HP · 继承保留墙的受损状态` : this.buildingStatsText(building),
          }),
          feedback: (message) => this.expedition?.showFeedback(message),
          merged: (building, released) => this.onManualMerge(building, released),
        }, scene);
      }
      if (scenario.evacuation) {
        this.evacuationHud = new EvacuationHud(scene, () => this.activateEvacuation());
        this.showEvacuation();
      }
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
        const deployment = this.scenario.worldSeed !== undefined
          ? waveDeployment(this.midgame, this.round.wave, {
              seed: this.scenario.worldSeed, stage: this.round.stage, count: wave.count,
            })
          : undefined;
        this.simulation.requestWave(this.round.wave, wave, deployment);
      }
      if (phase === "attacking" && this.round.phase === "recovering") {
        this.simulation.finishAttackPhase(this.round.wave, spawned === removed && pending === 0 ? "resolved" : "time-limit");
      }
      this.expedition.economy.advance(elapsed);
      this.simulation.step(elapsed, this.player);
      if (this.round.phase === "evacuating") {
        const batch = this.round.updateEvacuation(elapsed, this.simulation.evacuationBatches);
        if (batch) this.queueEvacuation(batch.batch, batch.order);
        if (this.roundEnded) this.stopCombat(false);
      }
      this.showEvacuation();
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
    if (this.evacuationHud && isVisible(this.scenario.target)) {
      const { x, y } = cellCenter(this.scenario.target);
      if (view.contains(x, y)) {
        const color = this.round?.lossReason === "evacuation" ? 0xf0a18c
          : this.round?.evacuation ? 0xffcf90 : 0x8ce9ff;
        graphics.lineStyle(2, color).strokeCircle(x, y, 10).strokeRect(x - 5, y - 5, 10, 10);
      }
    }
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
        if (building.evolution) {
          this.drawEvolutionMark(building.evolution, x, y, building.evolution.kind === "piercing" ? 0x73d4cc : 0xf9bd7a);
        } else {
          graphics.fillStyle(0x73d4cc).fillTriangle(x, y - 9, x + 9, y + 8, x - 9, y + 8);
        }
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
      if (event.type === "towerEffect") {
        this.drawEvolvedShot(event.effect, view);
        continue;
      }
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
      const world = enemyWorldPosition(enemy);
      if (!this.enemyVisibility(world, view).drawn) continue;
      visible += 1;
      this.drawEnemyDot(world, enemy.kind);
    }
    this.renderPlayerContacts(view);

    this.showStats(active, visible, Number.isFinite(northRow) ? northRow : -1, unreachable);
    const building = cell && isVisible(cell) ? this.map.getBuilding(cell) : undefined;
    const name = building && (building.evolution ? evolutionName(building.evolution)
      : building.kind === "tower" && !this.expedition ? "测试塔" : BUILDING_NAMES[building.kind]);
    const level = building?.level === 2 && !building.evolution ? " · Lv.2" : "";
    const description = building ? `${name} ${coordinates(building.cell)} · ${building.hp} HP${level}` : "—";
    write(this.hover, description);
    this.expedition?.showBuilding(description);
    this.showBuildingStats(this.expedition ? building : undefined);
    const placement = this.expedition?.previewPlacement(cell);
    const synthesis = this.merge?.render(cell, this.expedition?.placing === true) ?? this.expedition?.synthesisPreview;
    if (synthesis) this.drawSynthesisPreview(synthesis);
    else if (this.scenario.towerTargeting && !placement && building?.kind === "tower") this.drawTowerRange(building, view);
    this.drawReleasedTiles();
    return placement;
  }

  private onManualMerge(building: Building, released: readonly GridPosition[]): void {
    this.mergeRelease = { cells: released, untilMs: this.timeMs + MERGE_RELEASE_MS };
    const name = building.evolution ? evolutionName(building.evolution) : BUILDING_NAMES[building.kind] + " Lv.2";
    const direction = building.evolution ? " · " + evolutionDirection(building.evolution) : "";
    this.expedition?.showFeedback("已合成 " + name + " " + coordinates(building.cell) + direction);
  }

  private drawReleasedTiles(): void {
    const highlight = this.mergeRelease;
    if (!highlight) return;
    const remaining = highlight.untilMs - this.timeMs;
    if (remaining <= 0) {
      this.mergeRelease = undefined;
      return;
    }
    for (const cell of highlight.cells) {
      if (!this.isVisible(cell) || this.map.getBuilding(cell)) continue;
      const { x, y } = cellCenter(cell);
      this.graphics.lineStyle(3, 0x9ff7d4, Math.min(1, remaining / 600))
        .strokeRect(x - 11, y - 11, 22, 22);
    }
  }

  private drawSynthesisPreview(preview: BuildingSynthesisPreview): void {
    const { retained, released, evolution } = preview;
    const graphics = this.graphics;
    if (this.isVisible(retained)) {
      const { x, y } = cellCenter(retained);
      graphics.lineStyle(2.5, 0x9ff7d4).strokeRect(x - 13, y - 13, 26, 26);
      if (evolution) this.drawEvolutionMark(evolution, x, y, 0x9ff7d4);
    }
    for (const cell of released) {
      if (!this.isVisible(cell)) continue;
      const { x, y } = cellCenter(cell);
      graphics.lineStyle(2, 0xffd897, 0.9)
        .lineBetween(x - 11, y - 11, x + 11, y + 11)
        .lineBetween(x - 11, y + 11, x + 11, y - 11);
    }
  }

  private drawEvolutionMark(evolution: TowerEvolution, x: number, y: number, color: number): void {
    const graphics = this.graphics;
    graphics.lineStyle(2.5, color);
    if (evolution.kind === "burst") {
      graphics.strokeCircle(x, y, 8);
      graphics.fillStyle(color).fillCircle(x, y, 2);
    } else if (evolution.axis === "horizontal") {
      graphics.lineBetween(x - 10, y, x + 10, y);
    } else {
      graphics.lineBetween(x, y - 10, x, y + 10);
    }
  }

  private drawEvolvedShot(effect: TowerEffect, view: Phaser.Geom.Rectangle): void {
    const { from } = effect;
    if (!this.isVisible({ col: Math.floor(from.x), row: Math.floor(from.y) })) return;
    if (effect.kind === "piercing") {
      this.drawPiercingLine(from, effect.to, view, effect.halfWidth === undefined ? 3 : effect.halfWidth * TILE_SIZE * 2, 1);
      return;
    }
    if (effect.kind === "piercingFallback") {
      const { to } = effect;
      if (!this.isVisible({ col: Math.floor(to.x), row: Math.floor(to.y) })) return;
      this.graphics.lineStyle(2, 0xffc88b).lineBetween(from.x * TILE_SIZE, from.y * TILE_SIZE, to.x * TILE_SIZE, to.y * TILE_SIZE);
      return;
    }

    const { center, radius } = effect;
    const x = center.x * TILE_SIZE;
    const y = center.y * TILE_SIZE;
    const r = radius * TILE_SIZE;
    if (x + r < view.left || x - r > view.right || y + r < view.top || y - r > view.bottom
      || !this.isVisible({ col: Math.floor(center.x), row: Math.floor(center.y) })) return;
    this.drawRangeCircle(x, y, r, 0xf9bd7a, 1);
  }

  private drawPiercingLine(from: Point, to: Point, view: Phaser.Geom.Rectangle, width: number, alpha: number): void {
    const horizontal = from.y === to.y;
    const origin = horizontal ? from.x : from.y;
    const end = horizontal ? to.x : to.y;
    const direction = Math.sign(end - origin);
    let visibleEnd = origin;
    while ((end - visibleEnd) * direction > 0) {
      const tile = direction > 0 ? Math.floor(visibleEnd) : Math.ceil(visibleEnd) - 1;
      const along = horizontal ? { col: tile, row: Math.floor(from.y) } : { col: Math.floor(from.x), row: tile };
      if (!this.isVisible(along)) break;
      visibleEnd = direction > 0 ? Math.min(end, tile + 1) : Math.max(end, tile);
    }
    const x = from.x * TILE_SIZE;
    const y = from.y * TILE_SIZE;
    const endX = (horizontal ? visibleEnd : from.x) * TILE_SIZE;
    const endY = (horizontal ? from.y : visibleEnd) * TILE_SIZE;
    if (Math.max(x, endX) < view.left || Math.min(x, endX) > view.right
      || Math.max(y, endY) < view.top || Math.min(y, endY) > view.bottom) return;
    this.graphics.lineStyle(width, 0xa4faff, alpha).lineBetween(x, y, endX, endY);
  }

  private drawRangeCircle(x: number, y: number, r: number, color: number, alpha: number): void {
    this.graphics.lineStyle(2, color, alpha);
    let previousX = x + r;
    let previousY = y;
    for (let segment = 1; segment <= 32; segment += 1) {
      const angle = segment * Math.PI / 16;
      const nextX = x + r * Math.cos(angle);
      const nextY = y + r * Math.sin(angle);
      let visible = true;
      for (let row = Math.floor(Math.min(previousY, nextY) / TILE_SIZE); row <= Math.floor(Math.max(previousY, nextY) / TILE_SIZE); row += 1) {
        for (let col = Math.floor(Math.min(previousX, nextX) / TILE_SIZE); col <= Math.floor(Math.max(previousX, nextX) / TILE_SIZE); col += 1) {
          if (!this.isVisible({ col, row })) visible = false;
        }
      }
      if (visible) this.graphics.lineBetween(previousX, previousY, nextX, nextY);
      previousX = nextX;
      previousY = nextY;
    }
  }

  private drawTowerRange(tower: Building, view: Phaser.Geom.Rectangle): void {
    const { x, y } = cellCenter(tower.cell);
    const biome = this.map.getBiome(tower.cell);
    const evolution = tower.evolution;
    if (evolution?.kind === "piercing") {
      const attributes = evolvedTowerAttributes(evolution, biome, this.scenario.towerTuning);
      const { origin, axis, negativeReach, positiveReach } = buildEvolvedTowerCoverage(this.map, tower.cell, attributes, true);
      const onAxis = (distance: number): Point => axis === "horizontal" ? { x: origin.x + distance, y: origin.y }
        : { x: origin.x, y: origin.y + distance };
      this.drawPiercingLine(origin, onAxis(-negativeReach), view, 2, 0.65);
      this.drawPiercingLine(origin, onAxis(positiveReach), view, 2, 0.65);
      this.drawRangeCircle(x, y, PIERCING_FALLBACK.range * TILE_SIZE, 0xffc88b, 0.65);
      return;
    }
    const { range } = evolution ? evolvedTowerAttributes(evolution, biome, this.scenario.towerTuning)
      : towerAttributes(this.map.buildingBalance, tower.level, biome);
    this.drawRangeCircle(x, y, range * TILE_SIZE, 0x8ce9ff, 0.6);
  }


  private showBuildingStats(building?: Building): void {
    this.buildingStats.hidden = !building;
    if (building) write(this.buildingStats, this.buildingStatsText(building));
  }

  private buildingStatsText(building: Building): string {
    const { kind, cell, level } = building;
    const { buildingBalance } = this.map;
    const biome = this.map.getBiome(cell);
    const prefix = `Lv.${level}`;
    if (kind === "wall") {
      return `${prefix} · 耐久 ${building.hp}/${building.maxHp} HP`;
    } else if (building.evolution) {
      const { evolution } = building;
      const attack = evolvedTowerAttributes(evolution, biome, this.scenario.towerTuning);
      const range = attack.range > attack.baseRange ? `${attack.range} 格（${attack.baseRange} + 高山 ${attack.range - attack.baseRange}）`
        : `${attack.range} 格`;
      const damage = attack.kind === "piercing" ? `伤害 ${attack.damage} · 最多 ${attack.maxTargets} 个目标`
        : `主伤害 ${attack.damage} · 溅射 ${attack.splashDamage} · 半径 ${attack.radius} 格`;
      const fallback = this.scenario.towerTargeting && attack.kind === "piercing"
        ? ` · 备用 ${PIERCING_FALLBACK.range} 格 / ${PIERCING_FALLBACK.damage} 点（与主攻共用冷却）` : "";
      return `${evolutionDirection(evolution)} · ${damage} · 射程 ${range} · 间隔 ${attack.intervalMs} ms${fallback}`;
    } else if (kind === "tower") {
      const { damage, range, intervalMs } = towerAttributes(buildingBalance, level, biome);
      return `${prefix} · 伤害 ${damage} · 射程 ${range} 格 · 间隔 ${intervalMs} ms`;
    } else if (kind === "economy") {
      const { amount, intervalMs } = productionAttributes(buildingBalance, level, biome);
      return `${prefix} · 每 ${intervalMs} ms 产出 ${amount} 经济`;
    }
    return prefix;
  }

  reset(): void {
    this.merge?.clearSelection();
    this.mergeRelease = undefined;
    this.simulation.reset();
    this.timeMs = 0;
    this.nextMetricsAtMs = 0;
    this.attackNoticeAt.clear();
    this.clearBreach();
    this.shots = [];
    this.hitMarkers = [];
    this.towerEffectTrace.length = 0;
    this.evolvedShots.piercing = 0;
    this.evolvedShots.burst = 0;
    this.evolvedShots.piercingFallback = 0;
    delete this.stats.dataset.towerEffects;
    this.pendingContacts.length = 0;
    this.contactRecords.length = 0;
    this.contactTrace.value = "";
    if (this.round && this.expedition) {
      this.round.reset();
      this.showEvacuation();
      this.expedition.showRound(this.round);
      this.expedition.reset();
      this.economyHistory?.reset(this.expedition.economy.totals);
      this.publishWaveMetrics(true);
    }
    write(this.status, "等待布防或生成敌人");
  }

  handleBoardClick(cell: GridPosition, keepPlacing: boolean): boolean {
    if (this.expedition?.placeSelected(cell, keepPlacing)) return true;
    return this.merge?.selectAt(cell) ?? false;
  }

  get roundEnded(): boolean { return this.round?.phase === "won" || this.round?.phase === "lost"; }

  private canActivateEvacuation(): boolean {
    if (!this.evacuationHud || this.roundEnded || this.round?.evacuation || this.toolLevel < 2) return false;
    const { col, row } = this.player.cell;
    return Math.abs(col - this.scenario.target.col) + Math.abs(row - this.scenario.target.row) <= 1;
  }

  activateEvacuation(): boolean {
    if (!this.canActivateEvacuation()) return false;
    const batch = this.round?.activateEvacuation(this.toolLevel, this.player.cell.row);
    if (!batch) return false;
    this.queueEvacuation(batch.batch, batch.order);
    this.showEvacuation();
    if (this.round) this.expedition?.showRound(this.round);
    return true;
  }

  private queueEvacuation(batch: 1 | 2, order: WaveOrder): void {
    if (!this.round || this.scenario.worldSeed === undefined) return;
    // Final cohorts use the active deployment rules at the mature-wave cadence.
    const deployment = evacuationDeployment(this.midgame, batch, {
      seed: this.scenario.worldSeed, stage: this.round.stage, count: order.count,
    });
    this.simulation.requestEvacuationBatch(batch, order, deployment);
  }

  private showEvacuation(): void {
    if (!this.evacuationHud || !this.round) return;
    this.evacuationHud.update(this.round, this.simulation.evacuationBatches, this.canActivateEvacuation(),
      this.round.phase === "evacuating" && this.simulation.evacuationRouteBlocked, this.simulation.evacuationPeakActive);
  }

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

  private stopCombat(clearBattle = true): void {
    this.merge?.clearSelection();
    this.mergeRelease = undefined;
    if (clearBattle) this.simulation.clearBattle();
    this.publishWaveMetrics(true);
    this.shots = [];
    if (!this.round || !this.expedition) return;
    this.expedition.showRound(this.round);
    this.expedition.refresh();
    this.showEvacuation();
  }

  private place(kind: "wall" | "tower", cell: GridPosition | null): void {
    if (!cell || !this.canPlaceAt(cell)) {
      write(this.status, "请选择未被占用的空地");
      return;
    }
    const building = this.map.placeBuilding(kind, cell);
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
    const technologyCell = economy?.technologyCell;
    const reserved = sameCell(cell, this.scenario.entry) || sameCell(cell, this.scenario.target)
      || (kind !== "technology" && technologyCell !== undefined && sameCell(cell, technologyCell));
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
    const batch = metadata.evacuationBatch;
    const rewardCohort = batch === undefined ? metadata.waveId : -batch;
    const credit = this.expedition?.economy.handleEvent(event, rewardCohort) ?? 0;
    if (batch === undefined) this.economyHistory?.creditKill(metadata.waveId, credit);
    if (event.type === "evacuationHit" && this.round && batch !== undefined) {
      const damage = this.round.hitEvacuation(event.damage);
      this.simulation.recordEvacuationDamage(batch, damage);
      if (this.roundEnded) this.stopCombat();
    }
    if (event.type === "towerEffect" || (event.type === "towerShot" && (metadata.towerHit?.kind ?? "standard") === "standard")) {
      this.shots.push({ event, expires: this.timeMs + SHOT_VISIBLE_MS });
    }
    if (event.type === "towerEffect" && this.scenario.debugControls) {
      const { towerId, effect, enemyIds } = event;
      this.evolvedShots[effect.kind] += 1;
      this.towerEffectTrace.push({ timeMs: this.timeMs, towerId, effect, enemyIds });
      if (this.towerEffectTrace.length > MAX_TOWER_EFFECT_RECORDS) this.towerEffectTrace.shift();
      this.stats.dataset.towerEffects = JSON.stringify({ ...this.evolvedShots, recent: this.towerEffectTrace });
    }
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
      this.simulation.recordPlayerDamage(metadata.waveId, damage, metadata.timeMs);
      if (metadata.contact && metadata.cell) {
        const { enemyWorld } = metadata.contact;
        this.hitMarkers.push({ world: enemyWorld, kind: metadata.enemyKind ?? "normal",
          expires: this.graphics.scene.time.now + HIT_MARKER_MS });
        if (this.scenario.debugControls) {
          this.pendingContacts.push({ ...metadata.contact, enemyId: event.enemyId, timeMs: metadata.timeMs,
            hpBefore: previousHp, hpAfter: this.round.playerHp, playerCell: metadata.cell });
        }
      }
      if (damage > 0) this.expedition?.showFeedback(`玩家受袭 · -${damage} HP`);
      if (this.roundEnded) this.stopCombat();
    }
  }

  private enemyVisibility(world: Point, view: Phaser.Geom.Rectangle) {
    const cameraVisible = view.contains(world.x, world.y);
    const fogVisible = this.isVisible(worldToCell(world.x, world.y));
    return { cameraVisible, fogVisible, drawn: cameraVisible && fogVisible };
  }

  private drawEnemyDot({ x, y }: Point, kind: EnemyKind): void {
    this.graphics.fillStyle(kind === "armored" ? 0xe2b365 : 0xec817a).fillCircle(x, y, ENEMY_RADIUS);
    this.graphics.lineStyle(1, 0x582c35).strokeCircle(x, y, ENEMY_RADIUS);
    if (kind === "armored") this.graphics.lineStyle(1.5, 0x3b3321).strokeCircle(x, y, ENEMY_RADIUS - 2.5);
  }

  private renderPlayerContacts(view: Phaser.Geom.Rectangle): void {
    const now = this.graphics.scene.time.now;
    this.hitMarkers = this.hitMarkers.filter(({ expires }) => expires > now);
    for (const { world, kind } of this.hitMarkers) {
      if (this.enemyVisibility(world, view).drawn) this.drawEnemyDot(world, kind);
    }
    if (this.pendingContacts.length === 0) return;
    const camera = this.graphics.scene.cameras.main;
    for (const contact of this.pendingContacts) {
      const redDotWorld = contact.enemyWorld;
      const visibility = this.enemyVisibility(redDotWorld, view);
      this.contactRecords.push({ ...contact, redDotWorld,
        canvasPoint: { x: camera.x + (redDotWorld.x - view.x) * camera.zoom,
          y: camera.y + (redDotWorld.y - view.y) * camera.zoom }, ...visibility });
    }
    this.pendingContacts.length = 0;
    this.contactRecords.splice(0, Math.max(0, this.contactRecords.length - MAX_CONTACT_RECORDS));
    this.contactTrace.value = JSON.stringify(this.contactRecords, null, 2);
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

import { EnemyNavigation } from "./enemy-navigation.ts";
import type { NavigationAction, NavigationMap } from "./enemy-navigation.ts";
import { MergeRouteForecaster, pursuitTargetKey } from "./merge-route-preview.ts";
import type { MergeRouteKnowledge, MergeRouteMetrics, MergeRoutePreview, MergeRouteWorld } from "./merge-route-preview.ts";
import { TOWER_LEVEL_ONE, evolvedTowerAttributes, towerAttributes } from "./building-balance.ts";
import type { BurstTowerAttributes, PiercingTowerAttributes, TowerTuning } from "./building-balance.ts";
import type { Building, BuildingKind } from "./buildings.ts";
import { boxDistance, ENEMY_RADIUS, sweepPlayerContact } from "./enemy-contact.ts";
import type { PlayerContact } from "./enemy-contact.ts";
import type { WaveOrder } from "./expedition-round.ts";
import { EvacuationCombatLedger } from "./evacuation.ts";
import type { EvacuationBatch, EvacuationBatchProgress, EvacuationResolution } from "./evacuation.ts";
import { cellCenter, TILE_SIZE, worldToCell } from "./player.ts";
import type { Point } from "./player.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";
import {
  buildEvolvedTowerCoverage, evolvedTargetDistanceSquared, hasTowerLineOfSight, PIERCING_FALLBACK,
  TARGET_DISTANCE_EPSILON, towerSearchRadius,
} from "./tower-attack.ts";
import { TowerTargetingDiagnostics } from "./tower-targeting-diagnostics.ts";
import type { PiercingCoverage } from "./tower-attack.ts";
import { TowerCombatDiagnostics } from "./tower-combat-diagnostics.ts";
import type { TowerCombatSnapshot, TowerHitRole } from "./tower-combat-diagnostics.ts";
import { WaveCombatMetrics } from "./wave-combat-metrics.ts";
import type { AttackEndReason, TowerExposureAnchor, WaveCombatSnapshot } from "./wave-combat-metrics.ts";

export const DEFENSE_CONFIG = {
  enemyHp: 2,
  spawnIntervalMs: 200,
  travelMs: 150,
  towerDamage: TOWER_LEVEL_ONE.damage,
  towerRange: TOWER_LEVEL_ONE.range,
  towerIntervalMs: TOWER_LEVEL_ONE.intervalMs,
  playerSight: 6,
} as const;

export interface EnemyProfile {
  readonly hp: number;
  readonly contactDamage: number;
}

export type EnemyKind = "normal" | "armored";

export interface WaveDeployment {
  readonly intervalMs: number;
  readonly burst?: { readonly count: number; readonly pauseMs: number };
  readonly armor?: { readonly hp: number; readonly slots: readonly number[] };
}

const DEFAULT_ENEMY_PROFILE: EnemyProfile = { hp: DEFENSE_CONFIG.enemyHp, contactDamage: 1 };
const DEFAULT_DEPLOYMENT: WaveDeployment = { intervalMs: DEFENSE_CONFIG.spawnIntervalMs };
const SPLASH_DISTANCE_EPSILON = 1e-9;
export const EVACUATION_DEVICE_HALF_SIZE = TILE_SIZE / 4;

interface EnemyMove {
  readonly to: GridPosition;
  readonly end: Point;
  readonly durationMs: number;
  elapsedMs: number;
}

export interface EnemyState {
  readonly id: number;
  readonly kind: EnemyKind;
  readonly spawnedAtMs: number;
  readonly waveId?: number;
  readonly evacuationBatch?: EvacuationBatch;
  cell: GridPosition;
  point: Point;
  hp: number;
  readonly wallDamage: number;
  readonly contactDamage: number;
  move?: EnemyMove;
  unreachable: boolean;
  hasTargetedBuilding: boolean;
  targetKey?: string;
  contacted: boolean;
}

interface Target {
  readonly kind: "building" | "player" | "evacuation";
  readonly cell: GridPosition;
  readonly buildingId?: string;
}

interface Position {
  readonly x: number;
  readonly y: number;
}

interface PlayerTarget {
  readonly cell: GridPosition;
  readonly position: Point;
}

interface SpawnRequest {
  remaining: number;
  released: number;
  readonly wallDamage: number;
  readonly profile: EnemyProfile;
  readonly waveId?: number;
  readonly enqueuedAtMs: number;
  readonly deployment: WaveDeployment;
  readonly evacuationBatch?: EvacuationBatch;
}

/** Visual attack geometry in fractional tile coordinates. */
export type TowerEffect =
  | { readonly kind: "piercing"; readonly from: Point; readonly to: Point; readonly halfWidth?: number }
  | { readonly kind: "piercingFallback"; readonly from: Point; readonly to: Point }
  | { readonly kind: "burst"; readonly from: Point; readonly center: Point; readonly radius: number };

interface TowerStrike {
  readonly enemy: EnemyState;
  readonly position: Position;
  readonly rawDamage: number;
}

interface PiercingHit extends TowerStrike {
  readonly distance: number;
}

export type DefenseEvent =
  | { type: "targetSelected"; enemyId: number; target: Target }
  | { type: "playerContact" | "buildingContact"; enemyId: number; target: GridPosition }
  | { type: "playerHit"; enemyId: number; damage: number }
  | { type: "evacuationHit"; enemyId: number; cell: GridPosition; damage: number; enemyWorld: Point }
  | { type: "buildingHit"; enemyId: number; buildingId: string; buildingKind: BuildingKind; cell: GridPosition;
      damage: number; hp: number; destroyed: boolean }
  | { type: "wallImpact"; enemyId: number; wallId: string; damage: number; hp: number; destroyed: boolean }
  | { type: "towerShot"; enemyId: number; towerId: string; from: GridPosition; to: Position; damage: number }
  | { type: "towerEffect"; towerId: string; effect: TowerEffect; readonly enemyIds: readonly number[] }
  | { type: "towerKill"; enemyId: number; towerId: string };

export interface DefenseEventMetadata {
  readonly waveId?: number;
  readonly evacuationBatch?: EvacuationBatch;
  readonly enemyKind: EnemyKind;
  readonly timeMs: number;
  readonly cell?: GridPosition;
  readonly towerHit?: {
    readonly kind: "standard" | "piercing" | "burst";
    readonly rawDamage: number;
    readonly overkill: number;
    readonly enemyCell: GridPosition;
  };
  readonly contact?: PlayerContact & {
    readonly enemyCell: GridPosition;
    readonly navigationTarget?: string;
    readonly source: "enemy-body-contact";
  };
}

type DefenseEmitter = (event: DefenseEvent, metadata: DefenseEventMetadata) => void;

export interface DefenseSimulationOptions {
  readonly towerTuning?: TowerTuning;
  readonly towerDiagnostics?: boolean;
  readonly towerTargeting?: boolean;
  readonly towerTargetingDiagnostics?: "trace" | "metrics";
}

function newCounters() {
  return { wallImpacts: 0, wallsDestroyed: 0, towerKills: 0, shots: 0, playerContacts: 0, buildingContacts: 0 };
}

function validSpawnRequest(count: number, wallDamage: number, { hp, contactDamage }: EnemyProfile): boolean {
  return [count, wallDamage, hp, contactDamage].every((value) => Number.isSafeInteger(value) && value > 0);
}

function validDeployment({ intervalMs, burst, armor }: WaveDeployment, count: number, normalHp: number): boolean {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return false;
  if (burst && (!Number.isSafeInteger(burst.count) || burst.count <= 0
    || !Number.isSafeInteger(burst.pauseMs) || burst.pauseMs < intervalMs)) return false;
  if (!armor) return true;
  if (!Number.isSafeInteger(armor.hp) || armor.hp <= normalHp) return false;
  let previous = -1;
  for (const slot of armor.slots) {
    if (!Number.isSafeInteger(slot) || slot <= previous || slot >= count) return false;
    previous = slot;
  }
  return true;
}

export function sameCell(a: GridPosition, b: GridPosition): boolean {
  return a.col === b.col && a.row === b.row;
}

export function enemyPosition(enemy: Readonly<EnemyState>): Position {
  const { x, y } = enemyWorldPosition(enemy);
  return { x: x / TILE_SIZE, y: y / TILE_SIZE };
}

export function enemyWorldPosition({ point, move }: Readonly<EnemyState>): Point {
  if (!move) return point;
  const progress = move.elapsedMs / move.durationMs;
  return {
    x: point.x + (move.end.x - point.x) * progress,
    y: point.y + (move.end.y - point.y) * progress,
  };
}

export class DefenseSimulation {
  private readonly map: TerrainMap;
  private readonly entry: GridPosition;
  private readonly buildingTarget: Target;
  private readonly emit: DefenseEmitter;
  private readonly expeditionCombat: boolean;
  private readonly towerTuning?: TowerTuning;
  private readonly combatDiagnostics?: TowerCombatDiagnostics;
  private readonly towerTargeting: boolean;
  private readonly targetingDiagnostics?: TowerTargetingDiagnostics;
  private readonly waveCombat = new WaveCombatMetrics();
  private readonly evacuationCombat = new EvacuationCombatLedger();
  private readonly units = new Map<number, EnemyState>();
  private readonly spawnQueue: SpawnRequest[] = [];
  private towerReadyAt = new WeakMap<GridPosition, number>();
  private towerCoverageRevision = -1;
  private towerCoverage = new WeakMap<GridPosition, PiercingCoverage>();
  private navigation: EnemyNavigation;
  private mergeRouteForecaster?: MergeRouteForecaster;
  private mergeRouteEnemyId?: number;
  private counts = newCounters();
  private timeMs = 0;
  private nextEnemyId = 1;
  private nextSpawnAtMs = 0;
  private requestedSpawns = 0;
  private spawned = 0;
  private cancelledSpawns = 0;
  private buildingRevision = -1;
  private attackableBuildings: Building[] = [];
  private defenseAnchorsRevision = -1;
  private threatBuildings: GridPosition[] = [];
  private exposureTowers: TowerExposureAnchor[] = [];

  constructor(map: TerrainMap, entry: GridPosition, target: GridPosition, emit: DefenseEmitter = () => {},
    expeditionCombat = false, options: DefenseSimulationOptions = {}) {
    this.map = map;
    this.entry = entry;
    this.buildingTarget = { kind: "building", cell: target };
    this.emit = emit;
    this.expeditionCombat = expeditionCombat;
    this.towerTuning = options.towerTuning;
    if (options.towerDiagnostics) this.combatDiagnostics = new TowerCombatDiagnostics(map);
    this.towerTargeting = options.towerTargeting ?? false;
    if (options.towerTargetingDiagnostics) this.targetingDiagnostics = new TowerTargetingDiagnostics(options.towerTargetingDiagnostics);
    this.navigation = new EnemyNavigation(map);
  }

  get enemies(): Iterable<Readonly<EnemyState>> { return this.units.values(); }
  get counters(): Readonly<ReturnType<typeof newCounters>> { return this.counts; }
  get searchCount(): number { return this.navigation.searchCount; }
  get searchTimeMs(): number { return this.navigation.searchTimeMs; }
  get elapsedMs(): number { return this.timeMs; }
  get mergeRouteMetrics(): MergeRouteMetrics {
    return this.mergeRouteForecaster?.metrics ?? { computations: 0, cacheHits: 0, searches: 0, elapsedMs: 0, worstMs: 0 };
  }

  previewMergeRoute(released: readonly GridPosition[], player: GridPosition, knowledge: MergeRouteKnowledge,
    force = false): MergeRoutePreview {
    const visible = (enemy: EnemyState): boolean => {
      const { x, y } = enemyWorldPosition(enemy);
      return knowledge.isVisible(worldToCell(x, y)) && knowledge.isVisible(enemy.move?.to ?? enemy.cell);
    };
    let enemy = this.mergeRouteEnemyId === undefined ? undefined : this.units.get(this.mergeRouteEnemyId);
    if (!enemy || !visible(enemy)) {
      enemy = undefined;
      for (const candidate of this.units.values()) {
        if (visible(candidate)) {
          enemy = candidate;
          break;
        }
      }
    }
    this.mergeRouteEnemyId = enemy?.id;
    const subject = enemy ? { id: enemy.id, cell: enemy.move?.to ?? enemy.cell,
      targetKey: enemy.targetKey, hasTargetedBuilding: enemy.hasTargetedBuilding, evacuationBatch: enemy.evacuationBatch } : undefined;

    this.mergeRouteForecaster ??= new MergeRouteForecaster(this.map, this.entry, this.buildingTarget.cell,
      (selection, stance, world) => this.chooseAction(selection, stance, world).target);
    return this.mergeRouteForecaster.preview(released, player, subject, knowledge, force);
  }
  get waveMetrics(): readonly WaveCombatSnapshot[] { return this.waveCombat.snapshots(this.timeMs); }
  get evacuationBatches(): readonly EvacuationBatchProgress[] { return this.evacuationCombat.snapshots; }
  get evacuationPeakActive(): number { return this.evacuationCombat.peakActive; }
  get evacuationRouteBlocked(): boolean {
    return this.navigation.next(this.entry, this.buildingTarget.cell, true, true).kind === "unreachable";
  }

  recordEvacuationDamage(batch: EvacuationBatch | undefined, actualDamage: number): void {
    if (batch !== undefined) this.evacuationCombat.recordDamage(batch, actualDamage);
  }
  get towerDiagnostics(): readonly TowerCombatSnapshot[] | undefined { return this.combatDiagnostics?.snapshots(this.timeMs); }
  get towerTargetingMetrics() { return this.targetingDiagnostics?.metrics ?? []; }
  get towerTargetingTrace() { return this.targetingDiagnostics?.trace ?? []; }

  getWaveMetrics(waveId: number): WaveCombatSnapshot | undefined { return this.waveCombat.snapshot(waveId, this.timeMs); }

  finishAttackPhase(waveId: number, reason?: AttackEndReason): void {
    this.waveCombat.finishAttackPhase(waveId, this.timeMs, reason);
  }

  recordPlayerDamage(waveId: number | undefined, actualDamage: number, timeMs = this.timeMs): void {
    if (waveId !== undefined) this.waveCombat.recordPlayerDamage(waveId, actualDamage, timeMs);
  }

  get spawnCounts(): { readonly requested: number; readonly spawned: number; readonly pending: number; readonly removed: number } {
    return {
      requested: this.requestedSpawns,
      spawned: this.spawned,
      pending: this.requestedSpawns - this.spawned - this.cancelledSpawns,
      removed: this.spawned - this.units.size,
    };
  }

  occupies(cell: GridPosition): boolean {
    for (const enemy of this.units.values()) {
      if (sameCell(enemy.cell, cell) || (enemy.move && sameCell(enemy.move.to, cell))) return true;
    }
    return false;
  }

  spawn(count: number, wallDamage: number, profile: EnemyProfile = DEFAULT_ENEMY_PROFILE): number {
    if (!validSpawnRequest(count, wallDamage, profile) || !this.map.isWalkable(this.entry)) return 0;
    this.requestedSpawns += count;
    for (let i = 0; i < count; i += 1) this.addEnemy(wallDamage, profile);
    return count;
  }

  requestSpawn(count: number, wallDamage: number, profile: EnemyProfile = DEFAULT_ENEMY_PROFILE): number {
    if (!validSpawnRequest(count, wallDamage, profile)) return 0;
    return this.enqueue(count, wallDamage, profile);
  }

  requestWave(waveId: number, order: WaveOrder, deployment = DEFAULT_DEPLOYMENT): number {
    const { count, wallDamage, enemyHp: hp, contactDamage } = order;
    const profile = { hp, contactDamage };
    if (!validSpawnRequest(count, wallDamage, profile) || !validDeployment(deployment, count, hp)
      || !this.waveCombat.start(waveId, count, this.timeMs, deployment.intervalMs, deployment.armor?.slots.length ?? 0)) return 0;
    return this.enqueue(count, wallDamage, profile, waveId, deployment);
  }

  requestEvacuationBatch(batch: EvacuationBatch, order: WaveOrder, deployment = DEFAULT_DEPLOYMENT): number {
    const { count, wallDamage, enemyHp: hp, contactDamage } = order;
    const profile = { hp, contactDamage };
    if (!validSpawnRequest(count, wallDamage, profile) || !validDeployment(deployment, count, hp)
      || !this.evacuationCombat.start(batch, count)) return 0;
    return this.enqueue(count, wallDamage, profile, undefined, deployment, batch);
  }

  private enqueue(count: number, wallDamage: number, profile: EnemyProfile, waveId?: number,
    { intervalMs, burst, armor }: WaveDeployment = DEFAULT_DEPLOYMENT, evacuationBatch?: EvacuationBatch): number {
    this.requestedSpawns += count;
    const request = {
      remaining: count, released: 0, wallDamage, profile: { ...profile }, waveId, enqueuedAtMs: this.timeMs, evacuationBatch,
      deployment: { intervalMs, burst: burst && { ...burst }, armor: armor && { hp: armor.hp, slots: [...armor.slots] } },
    };
    // Existing ordinary requests remain in order, but the evacuation batch gets the next free release.
    if (evacuationBatch !== undefined) this.spawnQueue.unshift(request);
    else this.spawnQueue.push(request);
    this.releaseSpawn();
    return count;
  }

  clearBattle(): void {
    // Terminal cleanup cancels waiting requests while preserving lifetime spawn totals.
    this.cancelledSpawns += this.spawnCounts.pending;
    this.spawnQueue.length = 0;
    this.combatDiagnostics?.clearBattle(this.timeMs);
    this.units.clear();
    this.waveCombat.clearBattle(this.timeMs);
    this.evacuationCombat.cancelCombat();
  }

  reset(): void {
    this.units.clear();
    this.spawnQueue.length = 0;
    this.towerReadyAt = new WeakMap();
    this.towerCoverageRevision = -1;
    this.navigation = new EnemyNavigation(this.map);
    this.mergeRouteForecaster = undefined;
    this.mergeRouteEnemyId = undefined;
    this.counts = newCounters();
    this.timeMs = 0;
    this.nextSpawnAtMs = 0;
    this.requestedSpawns = 0;
    this.spawned = 0;
    this.cancelledSpawns = 0;
    this.buildingRevision = -1;
    this.attackableBuildings = [];
    this.defenseAnchorsRevision = -1;
    this.threatBuildings = [];
    this.exposureTowers = [];
    this.waveCombat.reset();
    this.evacuationCombat.reset();
    this.combatDiagnostics?.reset();
    this.targetingDiagnostics?.reset();
  }

  step(deltaMs: number, player?: GridPosition | PlayerTarget): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const target = player && ("position" in player ? player : { cell: player, position: cellCenter(player) });
    this.timeMs += deltaMs;
    for (const enemy of this.units.values()) this.advanceEnemy(enemy, deltaMs, target);
    for (const building of this.map.getBuildings()) {
      if (building.kind === "tower") this.fireTower(building);
    }
    this.combatDiagnostics?.finishStep(this.timeMs);
    this.releaseSpawn(target?.cell);
  }

  private addEnemy(wallDamage: number, profile: EnemyProfile, waveId?: number, player?: GridPosition,
    kind: EnemyKind = "normal", evacuationBatch?: EvacuationBatch): void {
    const id = this.nextEnemyId++;
    const enemy: EnemyState = {
      id, kind, spawnedAtMs: this.timeMs, cell: this.entry, point: cellCenter(this.entry),
      hp: profile.hp, wallDamage, contactDamage: profile.contactDamage,
      unreachable: false, hasTargetedBuilding: false, contacted: false,
      ...(waveId === undefined ? {} : { waveId }),
      ...(evacuationBatch === undefined ? {} : { evacuationBatch }),
    };
    this.units.set(id, enemy);
    this.spawned += 1;
    if (evacuationBatch !== undefined) this.evacuationCombat.spawn(evacuationBatch);
    if (waveId !== undefined) {
      this.waveCombat.spawn(waveId, id, this.timeMs, kind);
      const point = enemyPosition(enemy);
      this.refreshDefenseAnchors();
      this.samplePosition(enemy, point, this.timeMs, 0, player);
    }
  }

  private releaseSpawn(player?: GridPosition): void {
    const request = this.spawnQueue[0];
    if (!request || this.timeMs < this.nextSpawnAtMs) return;
    const walkable = this.map.isWalkable(this.entry);
    if (!walkable || this.occupies(this.entry)) {
      if (request.waveId !== undefined) {
        this.waveCombat.recordEntryBlock(request.waveId, Math.max(this.nextSpawnAtMs, request.enqueuedAtMs), walkable);
      }
      return;
    }

    const { intervalMs, burst, armor } = request.deployment;
    const armoredHp = armor?.slots.includes(request.released) ? armor.hp : undefined;
    const profile = armoredHp === undefined ? request.profile : { ...request.profile, hp: armoredHp };
    this.addEnemy(request.wallDamage, profile, request.waveId, player,
      armoredHp === undefined ? "normal" : "armored", request.evacuationBatch);
    request.remaining -= 1;
    request.released += 1;
    if (request.remaining === 0) this.spawnQueue.shift();
    const betweenBursts = burst && request.remaining > 0 && request.released % burst.count === 0;
    // Start the next interval at the actual release time so a blocked entry cannot cause a burst.
    this.nextSpawnAtMs = this.timeMs + (betweenBursts ? burst.pauseMs : intervalMs);
  }

  private advanceEnemy(enemy: EnemyState, deltaMs: number, player?: PlayerTarget): void {
    let budget = deltaMs;
    if (this.needsPositionSample(enemy)) this.samplePosition(enemy, enemyPosition(enemy), this.timeMs - budget, 0, player?.cell);
    while (budget > 0) {
      if (enemy.move && !this.map.isWalkable(enemy.move.to)) enemy.move = undefined;
      const move = enemy.move;
      if (move) {
        const duration = Math.min(budget, move.durationMs - move.elapsedMs);
        const sample = this.needsPositionSample(enemy) ? enemyPosition(enemy) : undefined;
        const previous = this.expeditionCombat && player ? enemyWorldPosition(enemy) : undefined;
        const start = this.timeMs - budget;
        move.elapsedMs += duration;
        const contact = previous && player && this.playerContact(previous, enemyWorldPosition(enemy), player);
        if (contact && player) {
          enemy.point = contact.enemyWorld;
          enemy.move = undefined;
          const elapsed = duration * contact.progress;
          if (sample) this.samplePosition(enemy, sample, start, elapsed, player.cell);
          this.hitPlayer(enemy, player.cell, contact, start + elapsed);
          return;
        }
        if (sample) this.samplePosition(enemy, sample, start, duration, player?.cell);
        if (move.elapsedMs < move.durationMs) return;
        enemy.cell = move.to;
        enemy.point = move.end;
        enemy.move = undefined;
        budget -= duration;
      }

      if (enemy.evacuationBatch !== undefined) {
        const contact = player && this.playerContact(enemy.point, enemy.point, player);
        if (contact && player) {
          this.hitPlayer(enemy, player.cell, contact, this.timeMs - budget);
          return;
        }
        if (this.touchingEvacuation(enemy.point)) {
          this.hitEvacuation(enemy, this.timeMs - budget);
          return;
        }
      }

      const { target, action } = this.chooseAction(enemy, player?.cell);
      const key = pursuitTargetKey(target);
      if (enemy.targetKey !== key) {
        enemy.targetKey = key;
        enemy.contacted = false;
        if (target.buildingId !== undefined) enemy.hasTargetedBuilding = true;
        this.emitFor(enemy, { type: "targetSelected", enemyId: enemy.id, target }, target.cell);
        if (!this.units.has(enemy.id)) return;
      }

      enemy.unreachable = action.kind === "unreachable";
      if (this.expeditionCombat && target.kind === "player" && player) {
        const contact = this.playerContact(enemy.point, enemy.point, player);
        if (contact) {
          this.hitPlayer(enemy, player.cell, contact, this.timeMs - budget);
          return;
        }
        if (action.kind === "arrived") {
          // The shared route field ends next to its target so buildings stay solid.
          // A walkable player target can be approached past that boundary.
          this.startMove(enemy, player.cell, sameCell(enemy.cell, player.cell) ? player.position : cellCenter(player.cell));
          continue;
        }
      }
      if (action.kind === "move") {
        this.startMove(enemy, action.cell, cellCenter(action.cell));
        continue;
      }
      if (action.kind === "wall") {
        if (enemy.evacuationBatch !== undefined && this.approachBuilding(enemy, action.cell)) continue;
        this.impactWall(enemy, action.cell, action.wallId);
      }
      if (action.kind === "arrived" && target.kind === "evacuation") {
        this.startContactMove(enemy, target.cell, EVACUATION_DEVICE_HALF_SIZE);
        continue;
      }
      if (action.kind === "building") {
        if (this.approachBuilding(enemy, action.cell)) continue;
        this.hitBuilding(enemy, action.cell, action.buildingId);
        return;
      }
      if (this.expeditionCombat && action.kind === "arrived" && target.buildingId && !enemy.contacted) {
        if (this.approachBuilding(enemy, target.cell)) continue;
        this.hitBuilding(enemy, target.cell, target.buildingId);
        return;
      }
      if (action.kind === "arrived" && !enemy.contacted) this.contact(enemy, target);
      return;
    }
  }

  private approachBuilding(enemy: EnemyState, cell: GridPosition): boolean {
    if (boxDistance(enemy.point, cellCenter(cell), TILE_SIZE / 2) <= ENEMY_RADIUS) return false;
    this.startContactMove(enemy, cell, TILE_SIZE / 2);
    return true;
  }

  private startContactMove(enemy: EnemyState, cell: GridPosition, halfSize: number): void {
    const center = cellCenter(cell);
    const reach = halfSize + ENEMY_RADIUS;
    const end = {
      x: center.x + (enemy.cell.col - cell.col) * reach,
      y: center.y + (enemy.cell.row - cell.row) * reach,
    };
    this.startMove(enemy, worldToCell(end.x, end.y), end);
  }

  private touchingEvacuation(point: Point): boolean {
    const distance = boxDistance(point, cellCenter(this.buildingTarget.cell), EVACUATION_DEVICE_HALF_SIZE);
    return distance <= ENEMY_RADIUS + 1e-9;
  }

  private hitEvacuation(enemy: EnemyState, timeMs: number): void {
    const batch = enemy.evacuationBatch;
    if (batch === undefined || !this.units.delete(enemy.id)) return;
    this.combatDiagnostics?.endEnemy(enemy.id, timeMs, "device-contact");
    this.evacuationCombat.resolve(batch, "deviceContacts");
    const cell = this.buildingTarget.cell;
    this.emit({ type: "evacuationHit", enemyId: enemy.id, cell, damage: enemy.contactDamage, enemyWorld: enemy.point },
      { evacuationBatch: batch, enemyKind: enemy.kind, timeMs, cell });
  }

  private resolveEvacuationEnemy(enemy: EnemyState, outcome: EvacuationResolution): void {
    if (enemy.evacuationBatch !== undefined) this.evacuationCombat.resolve(enemy.evacuationBatch, outcome);
  }

  private startMove(enemy: EnemyState, to: GridPosition, end: Point): void {
    const distance = Math.hypot(end.x - enemy.point.x, end.y - enemy.point.y);
    enemy.move = { to, end, durationMs: distance / TILE_SIZE * DEFENSE_CONFIG.travelMs, elapsedMs: 0 };
  }

  private playerContact(start: Point, end: Point, player: PlayerTarget): PlayerContact | undefined {
    const contact = sweepPlayerContact(start, end, player.position);
    if (!contact) return;
    const { x, y } = contact.enemyWorld;
    return this.hasPlayerSight(worldToCell(x, y), player.cell) ? contact : undefined;
  }

  private hitPlayer(enemy: EnemyState, cell: GridPosition, contact: PlayerContact, timeMs: number): void {
    this.units.delete(enemy.id);
    this.combatDiagnostics?.endEnemy(enemy.id, timeMs, "player-contact");
    this.counts.playerContacts += 1;
    this.waveCombat.resolve(enemy.id, "playerContacts", timeMs);
    this.resolveEvacuationEnemy(enemy, "playerContacts");
    this.emit({ type: "playerHit", enemyId: enemy.id, damage: enemy.contactDamage }, {
      waveId: enemy.waveId, enemyKind: enemy.kind, timeMs, cell,
      ...(enemy.evacuationBatch === undefined ? {} : { evacuationBatch: enemy.evacuationBatch }),
      contact: { ...contact, enemyCell: enemy.cell, navigationTarget: enemy.targetKey, source: "enemy-body-contact" },
    });
  }

  private needsPositionSample(enemy: EnemyState): boolean {
    if (enemy.waveId === undefined) return false;
    this.refreshDefenseAnchors();
    return this.waveCombat.needsPositionSample(enemy.id, this.exposureTowers.length > 0);
  }

  private refreshDefenseAnchors(): void {
    if (this.defenseAnchorsRevision === this.map.revision) return;
    this.threatBuildings = [];
    this.exposureTowers = [];
    for (const building of this.map.getBuildings()) {
      this.threatBuildings.push(building.cell);
      if (building.kind === "tower") {
        const biome = this.map.getBiome(building.cell);
        const { range } = building.evolution
          ? evolvedTowerAttributes(building.evolution, biome, this.towerTuning)
          : towerAttributes(this.map.buildingBalance, building.level, biome);
        this.exposureTowers.push({ cell: building.cell, radius: range });
      }
    }
    this.defenseAnchorsRevision = this.map.revision;
  }

  private samplePosition(enemy: EnemyState, start: Position, timeMs: number, durationMs: number, player?: GridPosition): void {
    this.waveCombat.samplePosition(enemy.id, start, durationMs === 0 ? start : enemyPosition(enemy),
      timeMs, durationMs, player, this.threatBuildings, this.exposureTowers);
  }

  private emitFor(enemy: EnemyState, event: DefenseEvent, cell?: GridPosition): void {
    this.emit(event, {
      waveId: enemy.waveId, enemyKind: enemy.kind, timeMs: this.timeMs, cell,
      ...(enemy.evacuationBatch === undefined ? {} : { evacuationBatch: enemy.evacuationBatch }),
    });
  }

  private chooseAction(enemy: Pick<EnemyState, "cell" | "hasTargetedBuilding" | "evacuationBatch">, player?: GridPosition,
    world?: MergeRouteWorld): { target: Target; action: NavigationAction } {
    const from = enemy.cell;
    const map = world?.map ?? this.map;
    const navigation = world?.navigation ?? this.navigation;
    if (enemy.evacuationBatch !== undefined) {
      const target: Target = { kind: "evacuation", cell: this.buildingTarget.cell };
      return { target, action: this.actionToward(navigation, from, target.cell, true, true) };
    }
    if (this.expeditionCombat) {
      let playerAction: NavigationAction | undefined;
      if (player && this.hasPlayerSight(from, player, map)) {
        playerAction = this.actionToward(navigation, from, player, false);
        if (playerAction.kind !== "unreachable") return { target: { kind: "player", cell: player }, action: playerAction };
      }

      const result = navigation.nextBuilding(from, world?.attackableBuildings ?? this.liveAttackableBuildings());
      if (result) {
        const { building, action } = result;
        return { target: { kind: "building", cell: building.cell, buildingId: building.id }, action };
      }
      // Retarget existing attackers without alerting new spawns to a hidden player.
      if (player && enemy.hasTargetedBuilding) {
        const action = playerAction ?? this.actionToward(navigation, from, player, false);
        if (action.kind !== "unreachable") return { target: { kind: "player", cell: player }, action };
      }
      return { target: this.buildingTarget, action: this.actionToward(navigation, from, this.buildingTarget.cell) };
    }

    const target: Target = player && this.seesPlayer(from, player, map)
      ? { kind: "player", cell: player }
      : this.buildingTarget;
    return { target, action: this.actionToward(navigation, from, target.cell) };
  }

  private liveAttackableBuildings(): readonly Building[] {
    if (this.buildingRevision !== this.map.revision) {
      this.attackableBuildings = [...this.map.getBuildings()].filter((building) => building.kind !== "wall");
      this.buildingRevision = this.map.revision;
    }
    return this.attackableBuildings;
  }

  private actionToward(navigation: EnemyNavigation, from: GridPosition, target: GridPosition, allowBreach = true,
    allowStructureBreach = false): NavigationAction {
    return sameCell(from, target) ? { kind: "arrived" } : navigation.next(from, target, allowBreach, allowStructureBreach);
  }

  private seesPlayer(from: GridPosition, player: GridPosition, map: NavigationMap): boolean {
    const dc = player.col - from.col;
    const dr = player.row - from.row;
    const distance = Math.abs(dc) + Math.abs(dr);
    if ((dc !== 0 && dr !== 0) || distance > DEFENSE_CONFIG.playerSight || !map.isWalkable(player)) return false;
    for (let offset = 1; offset < distance; offset += 1) {
      if (!map.isWalkable({ col: from.col + Math.sign(dc) * offset, row: from.row + Math.sign(dr) * offset })) return false;
    }
    return true;
  }

  private hasPlayerSight(from: GridPosition, player: GridPosition, map: NavigationMap = this.map): boolean {
    const dc = player.col - from.col;
    const dr = player.row - from.row;
    const cols = Math.abs(dc);
    const rows = Math.abs(dr);
    if (cols ** 2 + rows ** 2 > DEFENSE_CONFIG.playerSight ** 2 || !map.isWalkable(player)) return false;

    // Trace cell centers. At an exact corner both touching cells must be clear.
    const stepCol = Math.sign(dc);
    const stepRow = Math.sign(dr);
    let { col, row } = from;
    let crossedCols = 0;
    let crossedRows = 0;
    while (crossedCols < cols || crossedRows < rows) {
      const edge = (2 * crossedCols + 1) * rows - (2 * crossedRows + 1) * cols;
      if (edge === 0 && (!map.isWalkable({ col: col + stepCol, row })
        || !map.isWalkable({ col, row: row + stepRow }))) return false;
      if (edge <= 0) {
        col += stepCol;
        crossedCols += 1;
      }
      if (edge >= 0) {
        row += stepRow;
        crossedRows += 1;
      }
      if (!map.isWalkable({ col, row })) return false;
    }
    return true;
  }

  private contact(enemy: EnemyState, target: Target): void {
    enemy.contacted = true;
    if (this.expeditionCombat) return;
    const type = target.kind === "player" ? "playerContact" : "buildingContact";
    if (type === "playerContact") this.counts.playerContacts += 1;
    else this.counts.buildingContacts += 1;
    this.emitFor(enemy, { type, enemyId: enemy.id, target: target.cell }, target.cell);
  }

  private hitBuilding(enemy: EnemyState, cell: GridPosition, buildingId: string): void {
    const impact = this.map.damageBuilding(cell, buildingId, enemy.contactDamage);
    if (!impact) return;
    enemy.contacted = true;
    this.counts.buildingContacts += 1;
    this.waveCombat.recordBuildingHit(enemy.id, this.timeMs, impact.damage, impact.destroyed);
    this.emitFor(enemy, { type: "buildingHit", enemyId: enemy.id, buildingId: impact.building.id,
      buildingKind: impact.building.kind, cell, damage: impact.damage, hp: impact.hp, destroyed: impact.destroyed }, cell);
  }

  private impactWall(enemy: EnemyState, cell: GridPosition, wallId: string): void {
    const impact = this.map.impactWall(cell, wallId, enemy.wallDamage);
    if (!impact) return;
    this.units.delete(enemy.id);
    this.combatDiagnostics?.endEnemy(enemy.id, this.timeMs, "wall-impact");
    this.counts.wallImpacts += 1;
    if (impact.destroyed) this.counts.wallsDestroyed += 1;
    this.waveCombat.resolve(enemy.id, "wallImpacts", this.timeMs, impact.damage, impact.destroyed);
    this.resolveEvacuationEnemy(enemy, "wallImpacts");
    this.emitFor(enemy, { type: "wallImpact", enemyId: enemy.id, wallId, damage: impact.damage,
      hp: impact.hp, destroyed: impact.destroyed }, cell);
  }

  private fireTower(tower: Building): void {
    const readyAt = this.towerReadyAt.get(tower.cell) ?? 0;
    if (this.combatDiagnostics || this.targetingDiagnostics?.detailed) this.observeTower(tower, readyAt);
    if (!this.units.size || readyAt > this.timeMs) return;
    this.targetingDiagnostics?.search(tower, this.units.size);
    const biome = this.map.getBiome(tower.cell);
    if (tower.evolution) {
      const attributes = evolvedTowerAttributes(tower.evolution, biome, this.towerTuning);
      if (attributes.kind === "piercing") this.firePiercingTower(tower, attributes);
      else this.fireBurstTower(tower, attributes);
      return;
    }
    const attributes = towerAttributes(this.map.buildingBalance, tower.level, biome);
    let selected: EnemyState | undefined;
    let closest = towerSearchRadius(attributes.range, this.towerTargeting) ** 2
      + (this.towerTargeting ? TARGET_DISTANCE_EPSILON : 0);
    for (const enemy of this.units.values()) {
      if (enemy.hp <= 0) continue;
      const position = enemyPosition(enemy);
      const distance = (position.x - tower.cell.col - 0.5) ** 2 + (position.y - tower.cell.row - 0.5) ** 2;
      if (distance > closest || (selected && distance === closest)) continue;
      selected = enemy;
      closest = distance;
    }
    if (!selected) return;

    this.towerReadyAt.set(tower.cell, this.timeMs + attributes.intervalMs);
    this.combatDiagnostics?.startShot(tower, this.timeMs);
    this.targetingDiagnostics?.fire(tower, "standard", [selected.id]);
    this.hitTowerEnemy(tower, selected, enemyPosition(selected), attributes.damage, "standard");
  }

  private observeTower(tower: Building, readyAt: number): void {
    const biome = this.map.getBiome(tower.cell);
    const origin = { x: tower.cell.col + 0.5, y: tower.cell.row + 0.5 };
    if (tower.evolution) {
      const attributes = evolvedTowerAttributes(tower.evolution, biome, this.towerTuning);
      const coverage = attributes.kind === "piercing" ? this.piercingCoverage(tower.cell, attributes)
        : buildEvolvedTowerCoverage(this.map, tower.cell, attributes, this.towerTargeting);
      this.combatDiagnostics?.observe(tower, { ...attributes, coverage }, this.units.values(), enemyPosition, this.timeMs, readyAt);
      this.targetingDiagnostics?.sample(this.map, tower, { range: attributes.range, origin, coverage, bodyAware: this.towerTargeting },
        this.units.values(), enemyPosition, this.timeMs, readyAt);
    } else {
      const attributes = towerAttributes(this.map.buildingBalance, tower.level, biome);
      this.combatDiagnostics?.observe(tower, attributes, this.units.values(), enemyPosition, this.timeMs, readyAt);
      this.targetingDiagnostics?.sample(this.map, tower, { range: attributes.range, origin, bodyAware: this.towerTargeting },
        this.units.values(), enemyPosition, this.timeMs, readyAt);
    }
  }

  private piercingCoverage(cell: GridPosition, attributes: PiercingTowerAttributes): PiercingCoverage {
    if (this.towerCoverageRevision !== this.map.revision) {
      this.towerCoverage = new WeakMap();
      this.towerCoverageRevision = this.map.revision;
    }
    let coverage = this.towerCoverage.get(cell);
    if (!coverage) {
      coverage = buildEvolvedTowerCoverage(this.map, cell, attributes, this.towerTargeting);
      this.towerCoverage.set(cell, coverage);
    }
    return coverage;
  }

  private firePiercingTower(tower: Building, attributes: PiercingTowerAttributes): void {
    const coverage = this.piercingCoverage(tower.cell, attributes);
    const { origin, axis } = coverage;
    const negative: PiercingHit[] = [];
    const positive: PiercingHit[] = [];
    let fallback: TowerStrike | undefined;
    let closestFallback = towerSearchRadius(PIERCING_FALLBACK.range, true) ** 2 + TARGET_DISTANCE_EPSILON;
    for (const enemy of this.units.values()) {
      if (enemy.hp <= 0) continue;
      const position = enemyPosition(enemy);
      const distance = evolvedTargetDistanceSquared(this.map, coverage, position);
      if (distance === undefined) {
        if (!this.towerTargeting || negative.length || positive.length) continue;
        const squared = (position.x - origin.x) ** 2 + (position.y - origin.y) ** 2;
        if (squared > closestFallback || (fallback && squared === closestFallback)
          || !hasTowerLineOfSight(this.map, origin, position)) continue;
        fallback = { enemy, position, rawDamage: PIERCING_FALLBACK.damage };
        closestFallback = squared;
        continue;
      }
      const forward = axis === "horizontal" ? position.x - origin.x : position.y - origin.y;
      const side = forward < 0 ? negative : positive;
      const insertAt = side.findIndex((hit) => hit.distance > distance);
      if (insertAt === -1) {
        if (side.length < attributes.maxTargets) side.push({ enemy, position, distance, rawDamage: attributes.damage });
      } else {
        side.splice(insertAt, 0, { enemy, position, distance, rawDamage: attributes.damage });
        if (side.length > attributes.maxTargets) side.pop();
      }
    }
    const nearestNegative = negative[0];
    const nearestPositive = positive[0];
    const firesNegative = nearestNegative && (!nearestPositive || nearestNegative.distance < nearestPositive.distance
      || (nearestNegative.distance === nearestPositive.distance && nearestNegative.enemy.id < nearestPositive.enemy.id));
    const hits = firesNegative ? negative : positive;
    if (!hits.length) {
      if (fallback) this.resolveEvolvedAttack(tower, attributes.intervalMs, [fallback],
        { kind: "piercingFallback", from: origin, to: fallback.position });
      return;
    }

    const distance = firesNegative ? -coverage.negativeReach : coverage.positiveReach;
    const to = axis === "horizontal" ? { x: origin.x + distance, y: origin.y } : { x: origin.x, y: origin.y + distance };
    this.resolveEvolvedAttack(tower, attributes.intervalMs, hits, {
      kind: "piercing", from: origin, to, ...(coverage.halfWidth === undefined ? {} : { halfWidth: coverage.halfWidth }),
    });
  }

  private fireBurstTower(tower: Building, attributes: BurstTowerAttributes): void {
    const coverage = buildEvolvedTowerCoverage(this.map, tower.cell, attributes, this.towerTargeting);
    let closest = coverage.rangeSquared + (this.towerTargeting ? TARGET_DISTANCE_EPSILON : 0);
    let primary: TowerStrike | undefined;
    for (const enemy of this.units.values()) {
      if (enemy.hp <= 0) continue;
      const position = enemyPosition(enemy);
      const distance = evolvedTargetDistanceSquared(this.map, coverage, position, closest);
      if (distance === undefined || (primary && distance === closest)) continue;
      primary = { enemy, position, rawDamage: attributes.damage };
      closest = distance;
    }
    if (!primary) return;

    const center = primary.position;
    const radiusSquared = attributes.radius ** 2;
    const hits = [primary];
    this.targetingDiagnostics?.search(tower, this.units.size, "splash");
    for (const enemy of this.units.values()) {
      if (enemy === primary.enemy || enemy.hp <= 0) continue;
      const position = enemyPosition(enemy);
      const distance = (position.x - center.x) ** 2 + (position.y - center.y) ** 2;
      // Interpolated positions can round a mathematically exact radius slightly outward.
      if (distance > radiusSquared + SPLASH_DISTANCE_EPSILON) continue;
      if (!hasTowerLineOfSight(this.map, center, position)) {
        this.combatDiagnostics?.recordOccludedSplash(tower);
        continue;
      }
      hits.push({ enemy, position, rawDamage: attributes.splashDamage });
    }
    this.resolveEvolvedAttack(tower, attributes.intervalMs, hits,
      { kind: "burst", from: coverage.origin, center, radius: attributes.radius });
  }

  private resolveEvolvedAttack(tower: Building, intervalMs: number, hits: readonly TowerStrike[], effect: TowerEffect): void {
    this.towerReadyAt.set(tower.cell, this.timeMs + intervalMs);
    this.combatDiagnostics?.startShot(tower, this.timeMs);
    this.targetingDiagnostics?.fire(tower, effect.kind, hits.map(({ enemy }) => enemy.id));
    const enemyIds: number[] = [];
    const kind = effect.kind === "piercingFallback" ? "piercing" : effect.kind;
    for (const { enemy, position, rawDamage } of hits) {
      const role = enemy === hits[0].enemy ? "primary" : "additional";
      if (this.hitTowerEnemy(tower, enemy, position, rawDamage, kind, role)) enemyIds.push(enemy.id);
    }
    if (enemyIds.length) this.emitFor(hits[0].enemy, { type: "towerEffect", towerId: tower.id, enemyIds, effect }, tower.cell);
  }

  private hitTowerEnemy(tower: Building, enemy: EnemyState, to: Position, rawDamage: number,
    kind: NonNullable<DefenseEventMetadata["towerHit"]>["kind"], role: TowerHitRole = "primary"): boolean {
    if (this.units.get(enemy.id) !== enemy || enemy.hp <= 0) {
      this.targetingDiagnostics?.hit(tower, enemy.id, false);
      return false;
    }
    const damage = Math.min(enemy.hp, rawDamage);
    enemy.hp -= damage;
    this.targetingDiagnostics?.hit(tower, enemy.id, true);
    this.combatDiagnostics?.recordHit(tower, enemy, role, to, damage, rawDamage - damage);
    this.counts.shots += 1;
    this.waveCombat.recordTowerHit(enemy.id, this.timeMs);
    this.emit({ type: "towerShot", enemyId: enemy.id, towerId: tower.id, from: tower.cell, to, damage }, {
      waveId: enemy.waveId, enemyKind: enemy.kind, timeMs: this.timeMs, cell: tower.cell,
      ...(enemy.evacuationBatch === undefined ? {} : { evacuationBatch: enemy.evacuationBatch }),
      towerHit: { kind, rawDamage, overkill: rawDamage - damage, enemyCell: { col: Math.floor(to.x), row: Math.floor(to.y) } },
    });
    if (enemy.hp === 0 && this.units.delete(enemy.id)) {
      this.combatDiagnostics?.recordKill(tower, enemy, this.timeMs);
      this.counts.towerKills += 1;
      this.waveCombat.resolve(enemy.id, "towerKills", this.timeMs);
      this.resolveEvacuationEnemy(enemy, "towerKills");
      this.emitFor(enemy, { type: "towerKill", enemyId: enemy.id, towerId: tower.id }, tower.cell);
    }
    return true;
  }
}

import { EnemyNavigation } from "./enemy-navigation.ts";
import type { NavigationAction } from "./enemy-navigation.ts";
import { BIOME_PROTOTYPE } from "./biome-effects.ts";
import type { Building, BuildingKind } from "./buildings.ts";
import { boxDistance, ENEMY_RADIUS, sweepPlayerContact } from "./enemy-contact.ts";
import type { PlayerContact } from "./enemy-contact.ts";
import type { WaveOrder } from "./expedition-round.ts";
import { cellCenter, TILE_SIZE, worldToCell } from "./player.ts";
import type { Point } from "./player.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";
import { WaveCombatMetrics } from "./wave-combat-metrics.ts";
import type { AttackEndReason, TowerExposureAnchor, WaveCombatSnapshot } from "./wave-combat-metrics.ts";

export const DEFENSE_CONFIG = {
  enemyHp: 2,
  spawnIntervalMs: 200,
  travelMs: 150,
  towerDamage: 2,
  towerRange: 5,
  towerIntervalMs: 350,
  playerSight: 6,
} as const;

export interface EnemyProfile {
  readonly hp: number;
  readonly contactDamage: number;
}

const DEFAULT_ENEMY_PROFILE: EnemyProfile = { hp: DEFENSE_CONFIG.enemyHp, contactDamage: 1 };

interface EnemyMove {
  readonly to: GridPosition;
  readonly end: Point;
  readonly durationMs: number;
  elapsedMs: number;
}

export interface EnemyState {
  readonly id: number;
  readonly spawnedAtMs: number;
  readonly waveId?: number;
  cell: GridPosition;
  point: Point;
  hp: number;
  readonly wallDamage: number;
  readonly contactDamage: number;
  move?: EnemyMove;
  unreachable: boolean;
  targetKey?: string;
  contacted: boolean;
}

interface Target {
  readonly kind: "building" | "player";
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
  readonly wallDamage: number;
  readonly profile: EnemyProfile;
  readonly waveId?: number;
}

export type DefenseEvent =
  | { type: "targetSelected"; enemyId: number; target: Target }
  | { type: "playerContact" | "buildingContact"; enemyId: number; target: GridPosition }
  | { type: "playerHit"; enemyId: number; damage: number }
  | { type: "buildingHit"; enemyId: number; buildingId: string; buildingKind: BuildingKind; cell: GridPosition;
      damage: number; hp: number; destroyed: boolean }
  | { type: "wallImpact"; enemyId: number; wallId: string; damage: number; hp: number; destroyed: boolean }
  | { type: "towerShot"; enemyId: number; towerId: string; from: GridPosition; to: Position }
  | { type: "towerKill"; enemyId: number; towerId: string };

export interface DefenseEventMetadata {
  readonly waveId?: number;
  readonly timeMs: number;
  readonly cell?: GridPosition;
  readonly contact?: PlayerContact & {
    readonly enemyCell: GridPosition;
    readonly navigationTarget?: string;
    readonly source: "enemy-body-contact";
  };
}

type DefenseEmitter = (event: DefenseEvent, metadata: DefenseEventMetadata) => void;

function newCounters() {
  return { wallImpacts: 0, wallsDestroyed: 0, towerKills: 0, shots: 0, playerContacts: 0, buildingContacts: 0 };
}

function validSpawnRequest(count: number, wallDamage: number, { hp, contactDamage }: EnemyProfile): boolean {
  return [count, wallDamage, hp, contactDamage].every((value) => Number.isSafeInteger(value) && value > 0);
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
  private readonly waveCombat = new WaveCombatMetrics();
  private readonly units = new Map<number, EnemyState>();
  private readonly spawnQueue: SpawnRequest[] = [];
  private towerReadyAt = new WeakMap<GridPosition, number>();
  private navigation: EnemyNavigation;
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
    expeditionCombat = false) {
    this.map = map;
    this.entry = entry;
    this.buildingTarget = { kind: "building", cell: target };
    this.emit = emit;
    this.expeditionCombat = expeditionCombat;
    this.navigation = new EnemyNavigation(map);
  }

  get enemies(): Iterable<Readonly<EnemyState>> { return this.units.values(); }
  get counters(): Readonly<ReturnType<typeof newCounters>> { return this.counts; }
  get searchCount(): number { return this.navigation.searchCount; }
  get searchTimeMs(): number { return this.navigation.searchTimeMs; }
  get elapsedMs(): number { return this.timeMs; }
  get waveMetrics(): readonly WaveCombatSnapshot[] { return this.waveCombat.snapshots(); }

  getWaveMetrics(waveId: number): WaveCombatSnapshot | undefined { return this.waveCombat.snapshot(waveId); }

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

  requestWave(waveId: number, order: WaveOrder): number {
    const { count, wallDamage, enemyHp: hp, contactDamage } = order;
    const profile = { hp, contactDamage };
    if (!validSpawnRequest(count, wallDamage, profile) || !this.waveCombat.start(waveId, count, this.timeMs)) return 0;
    return this.enqueue(count, wallDamage, profile, waveId);
  }

  private enqueue(count: number, wallDamage: number, profile: EnemyProfile, waveId?: number): number {
    this.requestedSpawns += count;
    this.spawnQueue.push({ remaining: count, wallDamage, profile: { ...profile }, waveId });
    this.releaseSpawn();
    return count;
  }

  clearBattle(): void {
    // Terminal cleanup cancels waiting requests while preserving lifetime spawn totals.
    this.cancelledSpawns += this.spawnCounts.pending;
    this.spawnQueue.length = 0;
    this.units.clear();
    this.waveCombat.clearBattle(this.timeMs);
  }

  reset(): void {
    this.units.clear();
    this.spawnQueue.length = 0;
    this.towerReadyAt = new WeakMap();
    this.navigation = new EnemyNavigation(this.map);
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
  }

  step(deltaMs: number, player?: GridPosition | PlayerTarget): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const target = player && ("position" in player ? player : { cell: player, position: cellCenter(player) });
    this.timeMs += deltaMs;
    for (const enemy of this.units.values()) this.advanceEnemy(enemy, deltaMs, target);
    for (const building of this.map.getBuildings()) {
      if (building.kind === "tower") this.fireTower(building);
    }
    this.releaseSpawn(target?.cell);
  }

  private addEnemy(wallDamage: number, profile: EnemyProfile, waveId?: number, player?: GridPosition): void {
    const id = this.nextEnemyId++;
    const enemy: EnemyState = {
      id, spawnedAtMs: this.timeMs, cell: this.entry, point: cellCenter(this.entry),
      hp: profile.hp, wallDamage, contactDamage: profile.contactDamage,
      unreachable: false, contacted: false,
      ...(waveId === undefined ? {} : { waveId }),
    };
    this.units.set(id, enemy);
    this.spawned += 1;
    if (waveId !== undefined) {
      this.waveCombat.spawn(waveId, id, this.timeMs);
      const point = enemyPosition(enemy);
      this.refreshDefenseAnchors();
      this.samplePosition(enemy, point, this.timeMs, 0, player);
    }
  }

  private releaseSpawn(player?: GridPosition): void {
    const request = this.spawnQueue[0];
    if (!request || this.timeMs < this.nextSpawnAtMs || !this.map.isWalkable(this.entry) || this.occupies(this.entry)) return;

    this.addEnemy(request.wallDamage, request.profile, request.waveId, player);
    request.remaining -= 1;
    if (request.remaining === 0) this.spawnQueue.shift();
    // Start the next interval at the actual release time so a blocked entry cannot cause a burst.
    this.nextSpawnAtMs = this.timeMs + DEFENSE_CONFIG.spawnIntervalMs;
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

      const { target, action } = this.chooseAction(enemy.cell, player?.cell);
      const key = target.buildingId ?? `${target.kind}:${target.cell.col},${target.cell.row}`;
      if (enemy.targetKey !== key) {
        enemy.targetKey = key;
        enemy.contacted = false;
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
      if (action.kind === "wall") this.impactWall(enemy, action.cell, action.wallId);
      if (this.expeditionCombat && action.kind === "arrived" && target.buildingId && !enemy.contacted) {
        const center = cellCenter(target.cell);
        if (boxDistance(enemy.point, center, TILE_SIZE / 2) > ENEMY_RADIUS) {
          const reach = TILE_SIZE / 2 + ENEMY_RADIUS;
          this.startMove(enemy, enemy.cell, {
            x: center.x + (enemy.cell.col - target.cell.col) * reach,
            y: center.y + (enemy.cell.row - target.cell.row) * reach,
          });
          continue;
        }
        this.hitBuilding(enemy, target.cell, target.buildingId);
        return;
      }
      if (action.kind === "arrived" && !enemy.contacted) this.contact(enemy, target);
      return;
    }
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
    this.counts.playerContacts += 1;
    this.waveCombat.resolve(enemy.id, "playerContacts", timeMs);
    this.emit({ type: "playerHit", enemyId: enemy.id, damage: enemy.contactDamage }, {
      waveId: enemy.waveId, timeMs, cell,
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
      if (building.kind === "tower") this.exposureTowers.push({ cell: building.cell, radius: this.towerRange(building) });
    }
    this.defenseAnchorsRevision = this.map.revision;
  }

  private samplePosition(enemy: EnemyState, start: Position, timeMs: number, durationMs: number, player?: GridPosition): void {
    this.waveCombat.samplePosition(enemy.id, start, durationMs === 0 ? start : enemyPosition(enemy),
      timeMs, durationMs, player, this.threatBuildings, this.exposureTowers);
  }

  private emitFor(enemy: EnemyState, event: DefenseEvent, cell?: GridPosition): void {
    this.emit(event, { waveId: enemy.waveId, timeMs: this.timeMs, cell });
  }

  private chooseAction(from: GridPosition, player?: GridPosition): { target: Target; action: NavigationAction } {
    if (this.expeditionCombat) {
      if (player && this.hasPlayerSight(from, player)) {
        const action = this.actionToward(from, player, false);
        if (action.kind !== "unreachable") return { target: { kind: "player", cell: player }, action };
      }

      if (this.buildingRevision !== this.map.revision) {
        this.attackableBuildings = [...this.map.getBuildings()].filter((building) => building.kind !== "wall");
        this.buildingRevision = this.map.revision;
      }
      const result = this.navigation.nextBuilding(from, this.attackableBuildings);
      if (result) {
        const { building, action } = result;
        return { target: { kind: "building", cell: building.cell, buildingId: building.id }, action };
      }
      return { target: this.buildingTarget, action: this.actionToward(from, this.buildingTarget.cell) };
    }

    const target: Target = player && this.seesPlayer(from, player)
      ? { kind: "player", cell: player }
      : this.buildingTarget;
    return { target, action: this.actionToward(from, target.cell) };
  }

  private actionToward(from: GridPosition, target: GridPosition, allowBreach = true): NavigationAction {
    return sameCell(from, target) ? { kind: "arrived" } : this.navigation.next(from, target, allowBreach);
  }

  private seesPlayer(from: GridPosition, player: GridPosition): boolean {
    const dc = player.col - from.col;
    const dr = player.row - from.row;
    const distance = Math.abs(dc) + Math.abs(dr);
    if ((dc !== 0 && dr !== 0) || distance > DEFENSE_CONFIG.playerSight || !this.map.isWalkable(player)) return false;
    for (let offset = 1; offset < distance; offset += 1) {
      if (!this.map.isWalkable({ col: from.col + Math.sign(dc) * offset, row: from.row + Math.sign(dr) * offset })) return false;
    }
    return true;
  }

  private hasPlayerSight(from: GridPosition, player: GridPosition): boolean {
    const dc = player.col - from.col;
    const dr = player.row - from.row;
    const cols = Math.abs(dc);
    const rows = Math.abs(dr);
    if (cols ** 2 + rows ** 2 > DEFENSE_CONFIG.playerSight ** 2 || !this.map.isWalkable(player)) return false;

    // Trace cell centers. At an exact corner both touching cells must be clear.
    const stepCol = Math.sign(dc);
    const stepRow = Math.sign(dr);
    let { col, row } = from;
    let crossedCols = 0;
    let crossedRows = 0;
    while (crossedCols < cols || crossedRows < rows) {
      const edge = (2 * crossedCols + 1) * rows - (2 * crossedRows + 1) * cols;
      if (edge === 0 && (!this.map.isWalkable({ col: col + stepCol, row })
        || !this.map.isWalkable({ col, row: row + stepRow }))) return false;
      if (edge <= 0) {
        col += stepCol;
        crossedCols += 1;
      }
      if (edge >= 0) {
        row += stepRow;
        crossedRows += 1;
      }
      if (!this.map.isWalkable({ col, row })) return false;
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
    this.counts.wallImpacts += 1;
    if (impact.destroyed) this.counts.wallsDestroyed += 1;
    this.waveCombat.resolve(enemy.id, "wallImpacts", this.timeMs, impact.damage, impact.destroyed);
    this.emitFor(enemy, { type: "wallImpact", enemyId: enemy.id, wallId, damage: impact.damage,
      hp: impact.hp, destroyed: impact.destroyed }, cell);
  }

  private towerRange(tower: Building): number {
    const extraRange = this.map.getBiome(tower.cell) === "highland" ? BIOME_PROTOTYPE.highlandTowerRangeBonus : 0;
    return DEFENSE_CONFIG.towerRange + extraRange;
  }

  private fireTower(tower: Building): void {
    if ((this.towerReadyAt.get(tower.cell) ?? 0) > this.timeMs) return;
    let selected: EnemyState | undefined;
    let closest = this.towerRange(tower) ** 2;
    for (const enemy of this.units.values()) {
      const position = enemyPosition(enemy);
      const distance = (position.x - tower.cell.col - 0.5) ** 2 + (position.y - tower.cell.row - 0.5) ** 2;
      if (distance > closest || (selected && distance === closest)) continue;
      selected = enemy;
      closest = distance;
    }
    if (!selected) return;

    this.towerReadyAt.set(tower.cell, this.timeMs + DEFENSE_CONFIG.towerIntervalMs);
    selected.hp = Math.max(0, selected.hp - DEFENSE_CONFIG.towerDamage);
    this.counts.shots += 1;
    this.waveCombat.recordTowerHit(selected.id, this.timeMs);
    this.emitFor(selected, { type: "towerShot", enemyId: selected.id, towerId: tower.id,
      from: tower.cell, to: enemyPosition(selected) }, tower.cell);
    if (selected.hp === 0 && this.units.delete(selected.id)) {
      this.counts.towerKills += 1;
      this.waveCombat.resolve(selected.id, "towerKills", this.timeMs);
      this.emitFor(selected, { type: "towerKill", enemyId: selected.id, towerId: tower.id }, tower.cell);
    }
  }
}

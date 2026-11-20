import { EnemyNavigation } from "./enemy-navigation.ts";
import type { NavigationAction } from "./enemy-navigation.ts";
import { BIOME_PROTOTYPE } from "./biome-effects.ts";
import type { Building, BuildingKind } from "./buildings.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

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
  elapsedMs: number;
}

export interface EnemyState {
  readonly id: number;
  readonly spawnedAtMs: number;
  cell: GridPosition;
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

interface SpawnRequest {
  remaining: number;
  readonly wallDamage: number;
  readonly profile: EnemyProfile;
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
  const { cell, move } = enemy;
  const progress = move ? move.elapsedMs / DEFENSE_CONFIG.travelMs : 0;
  return {
    x: cell.col + 0.5 + (move ? (move.to.col - cell.col) * progress : 0),
    y: cell.row + 0.5 + (move ? (move.to.row - cell.row) * progress : 0),
  };
}

export class DefenseSimulation {
  private readonly map: TerrainMap;
  private readonly entry: GridPosition;
  private readonly buildingTarget: Target;
  private readonly emit: (event: DefenseEvent) => void;
  private readonly expeditionCombat: boolean;
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

  constructor(map: TerrainMap, entry: GridPosition, target: GridPosition, emit: (event: DefenseEvent) => void = () => {},
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
    this.requestedSpawns += count;
    this.spawnQueue.push({ remaining: count, wallDamage, profile: { ...profile } });
    this.releaseSpawn();
    return count;
  }

  clearBattle(): void {
    // Terminal cleanup cancels waiting requests while preserving lifetime spawn totals.
    this.cancelledSpawns += this.spawnCounts.pending;
    this.spawnQueue.length = 0;
    this.units.clear();
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
  }

  step(deltaMs: number, player?: GridPosition): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    this.timeMs += deltaMs;
    for (const enemy of this.units.values()) this.advanceEnemy(enemy, deltaMs, player);
    for (const building of this.map.getBuildings()) {
      if (building.kind === "tower") this.fireTower(building);
    }
    this.releaseSpawn();
  }

  private addEnemy(wallDamage: number, profile: EnemyProfile): void {
    const id = this.nextEnemyId++;
    this.units.set(id, {
      id, spawnedAtMs: this.timeMs, cell: this.entry, hp: profile.hp, wallDamage, contactDamage: profile.contactDamage,
      unreachable: false, contacted: false,
    });
    this.spawned += 1;
  }

  private releaseSpawn(): void {
    const request = this.spawnQueue[0];
    if (!request || this.timeMs < this.nextSpawnAtMs || !this.map.isWalkable(this.entry) || this.occupies(this.entry)) return;

    this.addEnemy(request.wallDamage, request.profile);
    request.remaining -= 1;
    if (request.remaining === 0) this.spawnQueue.shift();
    // Start the next interval at the actual release time so a blocked entry cannot cause a burst.
    this.nextSpawnAtMs = this.timeMs + DEFENSE_CONFIG.spawnIntervalMs;
  }

  private advanceEnemy(enemy: EnemyState, deltaMs: number, player?: GridPosition): void {
    let budget = deltaMs;
    while (budget > 0) {
      if (enemy.move && !this.map.isWalkable(enemy.move.to)) enemy.move = undefined;
      if (enemy.move) {
        const left = DEFENSE_CONFIG.travelMs - enemy.move.elapsedMs;
        if (budget < left) {
          enemy.move.elapsedMs += budget;
          return;
        }
        enemy.cell = enemy.move.to;
        enemy.move = undefined;
        budget -= left;
      }

      const { target, action } = this.chooseAction(enemy.cell, player);
      const key = target.buildingId ?? `${target.kind}:${target.cell.col},${target.cell.row}`;
      if (enemy.targetKey !== key) {
        enemy.targetKey = key;
        enemy.contacted = false;
        this.emit({ type: "targetSelected", enemyId: enemy.id, target });
        if (!this.units.has(enemy.id)) return;
      }

      enemy.unreachable = action.kind === "unreachable";
      if (action.kind === "move") {
        enemy.move = { to: action.cell, elapsedMs: 0 };
        continue;
      }
      if (action.kind === "wall") this.impactWall(enemy, action.cell, action.wallId);
      if (action.kind === "arrived" && !enemy.contacted) this.contact(enemy, target);
      return;
    }
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
    if (this.expeditionCombat && target.kind === "player") {
      this.units.delete(enemy.id);
      this.counts.playerContacts += 1;
      this.emit({ type: "playerHit", enemyId: enemy.id, damage: enemy.contactDamage });
      return;
    }
    if (this.expeditionCombat && target.buildingId) {
      const impact = this.map.damageBuilding(target.cell, target.buildingId, enemy.contactDamage);
      if (!impact) return;
      this.units.delete(enemy.id);
      this.counts.buildingContacts += 1;
      this.emit({ type: "buildingHit", enemyId: enemy.id, buildingId: impact.building.id,
        buildingKind: impact.building.kind, cell: impact.building.cell, damage: impact.damage,
        hp: impact.hp, destroyed: impact.destroyed });
      return;
    }

    enemy.contacted = true;
    const type = target.kind === "player" ? "playerContact" : "buildingContact";
    if (type === "playerContact") this.counts.playerContacts += 1;
    else this.counts.buildingContacts += 1;
    this.emit({ type, enemyId: enemy.id, target: target.cell });
  }

  private impactWall(enemy: EnemyState, cell: GridPosition, wallId: string): void {
    const impact = this.map.impactWall(cell, wallId, enemy.wallDamage);
    if (!impact) return;
    this.units.delete(enemy.id);
    this.counts.wallImpacts += 1;
    if (impact.destroyed) this.counts.wallsDestroyed += 1;
    this.emit({ type: "wallImpact", enemyId: enemy.id, wallId, damage: impact.damage, hp: impact.hp, destroyed: impact.destroyed });
  }

  private fireTower(tower: Building): void {
    if ((this.towerReadyAt.get(tower.cell) ?? 0) > this.timeMs) return;
    let selected: EnemyState | undefined;
    const extraRange = this.map.getBiome(tower.cell) === "highland" ? BIOME_PROTOTYPE.highlandTowerRangeBonus : 0;
    let closest = (DEFENSE_CONFIG.towerRange + extraRange) ** 2;
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
    this.emit({ type: "towerShot", enemyId: selected.id, towerId: tower.id, from: tower.cell, to: enemyPosition(selected) });
    if (selected.hp === 0 && this.units.delete(selected.id)) {
      this.counts.towerKills += 1;
      this.emit({ type: "towerKill", enemyId: selected.id, towerId: tower.id });
    }
  }
}

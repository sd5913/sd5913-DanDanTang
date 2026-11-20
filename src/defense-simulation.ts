import { EnemyNavigation } from "./enemy-navigation.ts";
import type { Building } from "./buildings.ts";
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
  move?: EnemyMove;
  unreachable: boolean;
  targetKey?: string;
  contacted: boolean;
}

interface Target {
  readonly kind: "building" | "player";
  readonly cell: GridPosition;
}

interface Position {
  readonly x: number;
  readonly y: number;
}

interface SpawnRequest {
  remaining: number;
  readonly wallDamage: number;
}

export type DefenseEvent =
  | { type: "targetSelected"; enemyId: number; target: Target }
  | { type: "playerContact" | "buildingContact"; enemyId: number; target: GridPosition }
  | { type: "wallImpact"; enemyId: number; wallId: string; damage: number; hp: number; destroyed: boolean }
  | { type: "towerShot"; enemyId: number; towerId: string; from: GridPosition; to: Position }
  | { type: "towerKill"; enemyId: number; towerId: string };

function newCounters() {
  return { wallImpacts: 0, wallsDestroyed: 0, towerKills: 0, shots: 0, playerContacts: 0, buildingContacts: 0 };
}

function validSpawnRequest(count: number, wallDamage: number): boolean {
  return Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(wallDamage) && wallDamage > 0;
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

  constructor(map: TerrainMap, entry: GridPosition, target: GridPosition, emit: (event: DefenseEvent) => void = () => {}) {
    this.map = map;
    this.entry = entry;
    this.buildingTarget = { kind: "building", cell: target };
    this.emit = emit;
    this.navigation = new EnemyNavigation(map);
  }

  get enemies(): Iterable<Readonly<EnemyState>> { return this.units.values(); }
  get counters(): Readonly<ReturnType<typeof newCounters>> { return this.counts; }
  get searchCount(): number { return this.navigation.searchCount; }
  get spawnCounts(): { readonly requested: number; readonly spawned: number; readonly pending: number; readonly removed: number } {
    return {
      requested: this.requestedSpawns,
      spawned: this.spawned,
      pending: this.requestedSpawns - this.spawned,
      removed: this.spawned - this.units.size,
    };
  }

  occupies(cell: GridPosition): boolean {
    for (const enemy of this.units.values()) {
      if (sameCell(enemy.cell, cell) || (enemy.move && sameCell(enemy.move.to, cell))) return true;
    }
    return false;
  }

  spawn(count: number, wallDamage: number): number {
    if (!validSpawnRequest(count, wallDamage) || !this.map.isWalkable(this.entry)) return 0;
    this.requestedSpawns += count;
    for (let i = 0; i < count; i += 1) this.addEnemy(wallDamage);
    return count;
  }

  requestSpawn(count: number, wallDamage: number): number {
    if (!validSpawnRequest(count, wallDamage)) return 0;
    this.requestedSpawns += count;
    this.spawnQueue.push({ remaining: count, wallDamage });
    this.releaseSpawn();
    return count;
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

  private addEnemy(wallDamage: number): void {
    const id = this.nextEnemyId++;
    this.units.set(id, {
      id, spawnedAtMs: this.timeMs, cell: this.entry, hp: DEFENSE_CONFIG.enemyHp, wallDamage,
      unreachable: false, contacted: false,
    });
    this.spawned += 1;
  }

  private releaseSpawn(): void {
    const request = this.spawnQueue[0];
    if (!request || this.timeMs < this.nextSpawnAtMs || !this.map.isWalkable(this.entry) || this.occupies(this.entry)) return;

    this.addEnemy(request.wallDamage);
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

      const target: Target = player && this.seesPlayer(enemy.cell, player)
        ? { kind: "player", cell: player }
        : this.buildingTarget;
      const key = `${target.kind}:${target.cell.col},${target.cell.row}`;
      if (enemy.targetKey !== key) {
        enemy.targetKey = key;
        enemy.contacted = false;
        this.emit({ type: "targetSelected", enemyId: enemy.id, target });
      }

      const action = sameCell(enemy.cell, target.cell)
        ? { kind: "arrived" as const }
        : this.navigation.next(enemy.cell, target.cell);
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

  private contact(enemy: EnemyState, target: Target): void {
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
    let closest = DEFENSE_CONFIG.towerRange ** 2;
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
    if (selected.hp === 0) {
      this.units.delete(selected.id);
      this.counts.towerKills += 1;
      this.emit({ type: "towerKill", enemyId: selected.id, towerId: tower.id });
    }
  }
}

import { wallHpMultiplier } from "./building-balance.ts";
import type { BuildingBalanceId } from "./building-balance.ts";
import type { GridPosition } from "./terrain.ts";

export type BuildingKind = "wall" | "tower" | "economy" | "technology";
export const BUILDING_SYNTHESIS_CONFIG = { autoMerge: true } as const;
const BUILDING_KINDS: ReadonlySet<BuildingKind> = new Set(["wall", "tower", "economy", "technology"]);

export interface Building {
  readonly id: string;
  readonly kind: BuildingKind;
  readonly cell: GridPosition;
  readonly level: 1 | 2;
  readonly buildOrder: number;
  readonly hp: number;
  readonly maxHp: number;
}

export interface WallImpact {
  /** Immutable wall state at the start of the impact. */
  readonly wall: Building;
  readonly damage: number;
  readonly hp: number;
  readonly destroyed: boolean;
}

export interface BuildingImpact {
  /** Immutable state of the building at the start of the impact. */
  readonly building: Building;
  readonly damage: number;
  readonly hp: number;
  readonly destroyed: boolean;
}

const DIRECTIONS: readonly GridPosition[] = [
  { col: 0, row: -1 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: -1, row: 0 },
];

function compareBuildings(a: Building, b: Building): number {
  return a.buildOrder - b.buildOrder || a.cell.col - b.cell.col || a.cell.row - b.cell.row;
}

function compareGroups(a: readonly Building[], b: readonly Building[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const difference = compareBuildings(a[index], b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Stores buildings independently of terrain. Its map owner validates world coordinates. */
export class BuildingStore {
  readonly #columns: number;
  readonly #balance: BuildingBalanceId;
  readonly #occupied = new Map<number, Building>();
  #nextId = 1;

  constructor(columns: number, balance: BuildingBalanceId = "control") {
    this.#columns = columns;
    this.#balance = balance;
  }

  get(cell: GridPosition): Building | undefined {
    return this.#occupied.get(this.index(cell));
  }

  values(): Iterable<Building> {
    return this.#occupied.values();
  }

  place(kind: BuildingKind, cell: GridPosition, hp: number): Building | undefined {
    if (!BUILDING_KINDS.has(kind) || !Number.isSafeInteger(hp) || hp <= 0) return undefined;
    const index = this.index(cell);
    if (this.#occupied.has(index)) return undefined;

    const building = Object.freeze({
      id: `building-${this.#nextId}`,
      kind,
      cell: Object.freeze({ ...cell }),
      level: 1 as const,
      buildOrder: this.#nextId,
      hp,
      maxHp: hp,
    });
    this.#nextId += 1;
    this.#occupied.set(index, building);
    return building;
  }

  synthesize(cell: GridPosition): Building | undefined {
    if (!this.canIndex(cell)) return undefined;
    const root = this.get(cell);
    if (root?.level !== 1) return undefined;
    const group = this.findSynthesisGroup(root);
    if (!group) return undefined;

    const [incumbent, ...consumed] = group;
    const maxHp = incumbent.kind === "wall" ? incumbent.maxHp * wallHpMultiplier(this.#balance, 2) : incumbent.maxHp;
    if (!Number.isSafeInteger(maxHp)) return undefined;
    const missingHp = incumbent.maxHp - incumbent.hp;
    const upgraded = Object.freeze({ ...incumbent, level: 2 as const, maxHp, hp: maxHp - missingHp });
    for (const building of consumed) this.#occupied.delete(this.index(building.cell));
    this.#occupied.set(this.index(incumbent.cell), upgraded);
    return upgraded;
  }

  private findSynthesisGroup(root: Building): Building[] | undefined {
    let winner: Building[] | undefined;
    const visit = (group: readonly Building[]): void => {
      if (group.length === 4) {
        const ordered = [...group].sort(compareBuildings);
        if (!winner || compareGroups(ordered, winner) < 0) winner = ordered;
        return;
      }

      // Each addition touches the existing group, so every candidate stays connected.
      for (const building of group) {
        for (const direction of DIRECTIONS) {
          const cell = { col: building.cell.col + direction.col, row: building.cell.row + direction.row };
          if (!this.canIndex(cell)) continue;
          const next = this.get(cell);
          if (next?.kind === root.kind && next.level === 1 && !group.includes(next)) visit([...group, next]);
        }
      }
    };

    visit([root]);
    return winner;
  }

  remove(cell: GridPosition, expectedId?: string): Building | undefined {
    const index = this.index(cell);
    const building = this.#occupied.get(index);
    if (!building || (expectedId !== undefined && building.id !== expectedId)) return undefined;

    this.#occupied.delete(index);
    return building;
  }

  impactWall(cell: GridPosition, wallId: string, damage: number): WallImpact | undefined {
    const wall = this.get(cell);
    if (wall?.kind !== "wall" || wall.id !== wallId) return undefined;
    const impact = this.applyDamage(wall, damage);
    return impact && { wall, damage: impact.damage, hp: impact.hp, destroyed: impact.destroyed };
  }

  damageBuilding(cell: GridPosition, buildingId: string, damage: number): BuildingImpact | undefined {
    const building = this.get(cell);
    if (!building || building.kind === "wall" || building.id !== buildingId) return undefined;
    return this.applyDamage(building, damage);
  }

  private applyDamage(building: Building, damage: number): BuildingImpact | undefined {
    if (!Number.isSafeInteger(damage) || damage <= 0) return undefined;
    const index = this.index(building.cell);
    const applied = Math.min(building.hp, damage);
    const hp = building.hp - applied;
    const destroyed = hp === 0;
    if (destroyed) {
      this.#occupied.delete(index);
    } else {
      this.#occupied.set(index, Object.freeze({ ...building, hp }));
    }
    return { building, damage: applied, hp, destroyed };
  }

  clear(): void {
    this.#occupied.clear();
  }

  private canIndex({ col, row }: GridPosition): boolean {
    return Number.isSafeInteger(col) && Number.isSafeInteger(row) && col >= 0 && col < this.#columns && row >= 0;
  }

  private index({ col, row }: GridPosition): number {
    return row * this.#columns + col;
  }
}

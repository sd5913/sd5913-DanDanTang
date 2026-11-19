import type { GridPosition } from "./terrain.ts";

export type BuildingKind = "wall" | "tower";

export interface Building {
  readonly id: string;
  readonly kind: BuildingKind;
  readonly cell: GridPosition;
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

/** Stores buildings independently of terrain. Its map owner validates world coordinates. */
export class BuildingStore {
  readonly #columns: number;
  readonly #occupied = new Map<number, Building>();
  #nextId = 1;

  constructor(columns: number) {
    this.#columns = columns;
  }

  get(cell: GridPosition): Building | undefined {
    return this.#occupied.get(this.index(cell));
  }

  values(): Iterable<Building> {
    return this.#occupied.values();
  }

  place(kind: BuildingKind, cell: GridPosition, hp: number): Building | undefined {
    if ((kind !== "wall" && kind !== "tower") || !Number.isSafeInteger(hp) || hp <= 0) return undefined;
    const index = this.index(cell);
    if (this.#occupied.has(index)) return undefined;

    const building = Object.freeze({
      id: `building-${this.#nextId}`,
      kind,
      cell: Object.freeze({ ...cell }),
      hp,
      maxHp: hp,
    });
    this.#nextId += 1;
    this.#occupied.set(index, building);
    return building;
  }

  remove(cell: GridPosition, expectedId?: string): Building | undefined {
    const index = this.index(cell);
    const building = this.#occupied.get(index);
    if (!building || (expectedId !== undefined && building.id !== expectedId)) return undefined;

    this.#occupied.delete(index);
    return building;
  }

  impactWall(cell: GridPosition, wallId: string, damage: number): WallImpact | undefined {
    const index = this.index(cell);
    const wall = this.#occupied.get(index);
    if (wall?.kind !== "wall" || wall.id !== wallId || !Number.isSafeInteger(damage) || damage <= 0) return undefined;

    const applied = Math.min(wall.hp, damage);
    const hp = wall.hp - applied;
    const destroyed = hp === 0;
    if (destroyed) {
      this.#occupied.delete(index);
    } else {
      this.#occupied.set(index, Object.freeze({ ...wall, hp }));
    }
    return { wall, damage: applied, hp, destroyed };
  }

  clear(): void {
    this.#occupied.clear();
  }

  private index({ col, row }: GridPosition): number {
    return row * this.#columns + col;
  }
}

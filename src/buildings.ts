import { wallHpMultiplier } from "./building-balance.ts";
import type { BuildingBalanceId } from "./building-balance.ts";
import type { GridPosition } from "./terrain.ts";

export type BuildingKind = "wall" | "tower" | "economy" | "technology";
export type TowerAxis = "horizontal" | "vertical";
export type TowerEvolution =
  | { readonly kind: "piercing"; readonly axis: TowerAxis }
  | { readonly kind: "burst" };
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
  readonly evolution?: TowerEvolution;
}

export interface BuildingSynthesisPreview {
  readonly retained: GridPosition;
  readonly released: readonly GridPosition[];
  readonly evolution?: TowerEvolution;
}

export interface ReadyBuildingSynthesis extends BuildingSynthesisPreview {
  readonly state: "MERGE_READY";
  readonly key: string;
  readonly participants: readonly Building[];
  readonly upgraded: Building;
}

export type BuildingSynthesisResult =
  | { readonly success: true; readonly building: Building; readonly released: readonly GridPosition[] }
  | { readonly success: false; readonly reason: "invalid" | "out-of-range" };

interface SynthesisPlan {
  readonly upgraded: Building;
  readonly group: readonly Building[];
}

interface ReadyGroup {
  readonly cells: readonly GridPosition[];
  preview?: ReadyBuildingSynthesis;
}

export function isWithinSynthesisRange(preview: ReadyBuildingSynthesis, player: GridPosition): boolean {
  return preview.participants.some(({ cell }) =>
    Math.max(Math.abs(cell.col - player.col), Math.abs(cell.row - player.row)) === 1);
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
  readonly #towerEvolution: boolean;
  readonly #occupied = new Map<number, Building>();
  readonly #readyGroups = new Map<number, ReadyGroup | null>();
  #nextId = 1;

  constructor(columns: number, balance: BuildingBalanceId = "control", towerEvolution = false) {
    this.#columns = columns;
    this.#balance = balance;
    this.#towerEvolution = towerEvolution;
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

    const building = this.createBuilding(kind, cell, hp);
    this.#nextId += 1;
    this.#occupied.set(index, building);
    this.#readyGroups.clear();
    return building;
  }

  private createBuilding(kind: BuildingKind, cell: GridPosition, hp: number): Building {
    return Object.freeze({
      id: `building-${this.#nextId}`,
      kind,
      cell: Object.freeze({ ...cell }),
      level: 1,
      buildOrder: this.#nextId,
      hp,
      maxHp: hp,
    });
  }

  previewSynthesis(kind: BuildingKind, cell: GridPosition, hp: number): BuildingSynthesisPreview | undefined {
    if (!this.canIndex(cell) || this.get(cell) || !BUILDING_KINDS.has(kind)
      || !Number.isSafeInteger(hp) || hp <= 0) return undefined;

    // The prospective building already belongs to every rooted candidate, so it need not be inserted.
    const plan = this.planSynthesis(this.createBuilding(kind, cell, hp));
    if (!plan) return undefined;
    return this.synthesisPreview(plan);
  }

  previewReadySynthesis(cell: GridPosition): ReadyBuildingSynthesis | undefined {
    if (!this.canIndex(cell)) return undefined;
    const root = this.get(cell);
    if (root?.level !== 1 || root.kind === "technology") return undefined;
    const key = this.index(cell);
    if (!this.#readyGroups.has(key)) this.cacheReadyGroup(root);
    const cached = this.#readyGroups.get(key);
    if (!cached) return undefined;

    const previous = cached.preview;
    if (previous && cached.cells.every((site, index) => this.get(site) === previous.participants[index])) return previous;

    // Damage changes the stored snapshot but not the occupants or candidate order.
    const group = cached.cells.map((site) => this.get(site)!);
    const plan = this.upgradeGroup(group);
    if (!plan) return undefined;
    const preview = this.synthesisPreview(plan);
    cached.preview = Object.freeze({
      ...preview,
      released: Object.freeze(preview.released),
      state: "MERGE_READY",
      key: group.map(({ id }) => id).join(":"),
      participants: Object.freeze(group),
      upgraded: plan.upgraded,
    });
    return cached.preview;
  }

  executeReadySynthesis(expected: ReadyBuildingSynthesis, player: GridPosition): BuildingSynthesisResult {
    const ready = this.previewReadySynthesis(expected.retained);
    // Cell identity also rejects tokens from a different map with the same build IDs.
    if (!ready || ready.retained !== expected.retained || ready.key !== expected.key) {
      return { success: false, reason: "invalid" };
    }
    if (!isWithinSynthesisRange(ready, player)) return { success: false, reason: "out-of-range" };
    const building = this.commitSynthesis({ upgraded: ready.upgraded, group: ready.participants });
    return { success: true, building, released: ready.released };
  }

  private cacheReadyGroup(root: Building): void {
    const component = [root];
    const visited = new Set([root]);
    let oldest = root;
    for (const building of component) {
      if (compareBuildings(building, oldest) < 0) oldest = building;
      for (const { col, row } of DIRECTIONS) {
        const cell = { col: building.cell.col + col, row: building.cell.row + row };
        if (!this.canIndex(cell)) continue;
        const neighbor = this.get(cell);
        if (neighbor?.kind !== root.kind || neighbor.level !== 1 || visited.has(neighbor)) continue;
        visited.add(neighbor);
        component.push(neighbor);
      }
    }

    // The oldest member of a connected group of four or more always belongs to a legal candidate.
    // The existing lexicographic order therefore selects the same winner when rooted at that member.
    const group = component.length >= 4 ? this.findSynthesisGroup(oldest) : undefined;
    const ready = group ? { cells: group.map(({ cell }) => cell) } : null;
    for (const { cell } of component) this.#readyGroups.set(this.index(cell), ready);
  }

  synthesize(cell: GridPosition): Building | undefined {
    if (!this.canIndex(cell)) return undefined;
    const root = this.get(cell);
    if (root?.level !== 1) return undefined;

    const plan = this.planSynthesis(root);
    return plan ? this.commitSynthesis(plan) : undefined;
  }

  private commitSynthesis({ upgraded, group }: SynthesisPlan): Building {
    for (const building of group.slice(1)) this.#occupied.delete(this.index(building.cell));
    this.#occupied.set(this.index(upgraded.cell), upgraded);
    this.#readyGroups.clear();
    return upgraded;
  }

  private synthesisPreview({ upgraded, group }: SynthesisPlan): BuildingSynthesisPreview {
    return {
      retained: upgraded.cell,
      released: group.slice(1).map(({ cell }) => cell),
      ...(upgraded.evolution ? { evolution: upgraded.evolution } : {}),
    };
  }

  private planSynthesis(root: Building): SynthesisPlan | undefined {
    const group = this.findSynthesisGroup(root);
    return group ? this.upgradeGroup(group) : undefined;
  }

  private upgradeGroup(group: readonly Building[]): SynthesisPlan | undefined {
    const [incumbent] = group;
    const maxHp = incumbent.kind === "wall" ? incumbent.maxHp * wallHpMultiplier(this.#balance, 2) : incumbent.maxHp;
    if (!Number.isSafeInteger(maxHp)) return undefined;
    const missingHp = incumbent.maxHp - incumbent.hp;
    const evolution = this.#towerEvolution && incumbent.kind === "tower" ? towerEvolutionFor(group) : undefined;
    const upgraded = Object.freeze({
      ...incumbent,
      level: 2 as const,
      maxHp,
      hp: maxHp - missingHp,
      ...(evolution ? { evolution } : {}),
    });
    return { upgraded, group };
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
    this.#readyGroups.clear();
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
      this.#readyGroups.clear();
    } else {
      this.#occupied.set(index, Object.freeze({ ...building, hp }));
    }
    return { building, damage: applied, hp, destroyed };
  }

  clear(): void {
    this.#occupied.clear();
    this.#readyGroups.clear();
  }

  private canIndex({ col, row }: GridPosition): boolean {
    return Number.isSafeInteger(col) && Number.isSafeInteger(row) && col >= 0 && col < this.#columns && row >= 0;
  }

  private index({ col, row }: GridPosition): number {
    return row * this.#columns + col;
  }
}

function towerEvolutionFor(group: readonly Building[]): TowerEvolution {
  const { col, row } = group[0].cell;
  // The four distinct cells are already connected, so sharing a row or column implies a complete line.
  if (group.every((building) => building.cell.row === row)) {
    return Object.freeze({ kind: "piercing", axis: "horizontal" });
  }
  if (group.every((building) => building.cell.col === col)) {
    return Object.freeze({ kind: "piercing", axis: "vertical" });
  }
  return Object.freeze({ kind: "burst" });
}

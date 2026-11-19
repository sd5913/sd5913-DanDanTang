import { MINING_CONFIG } from "./mining-config.ts";
import { TEST_MAP_LAYOUT } from "./test-map.ts";

export const MAP_COLUMNS = 24;
export const MAP_ROWS = 32;

export interface GridPosition {
  readonly col: number;
  readonly row: number;
}

export type TerrainType = "empty" | "dirt" | "rock";

interface TerrainCellFields {
  readonly terrainLevel: number;
  readonly buildingId: string | null;
}

export type TerrainCell = TerrainCellFields & (
  | { readonly terrain: "dirt"; readonly hp: number; readonly maxHp: number }
  | { readonly terrain: "empty"; readonly hp: 0; readonly maxHp: 0 }
  | { readonly terrain: "rock"; readonly hp: null; readonly maxHp: null }
);

export interface TerrainReader {
  readonly columns: number;
  readonly rows: number;
  /** Changes when a tile becomes walkable or the map resets. */
  readonly revision: number;
  isInside(position: GridPosition): boolean;
  getCell(position: GridPosition): TerrainCell | undefined;
  isWalkable(position: GridPosition): boolean;
  getWalkableNeighbors(position: GridPosition): GridPosition[];
}

export type DigFailure =
  | "out-of-bounds"
  | "invalid-origin"
  | "out-of-reach"
  | "rock"
  | "empty"
  | "invalid-damage";

export type DigResult =
  | { readonly effective: true; readonly damage: number; readonly hp: number; readonly cleared: boolean }
  | { readonly effective: false; readonly damage: 0; readonly hp: number | null; readonly cleared: false; readonly reason: DigFailure };

const EMPTY: TerrainCell = Object.freeze({
  terrain: "empty", terrainLevel: 0, buildingId: null, hp: 0, maxHp: 0,
});
const DIRT: TerrainCell = Object.freeze({
  terrain: "dirt", terrainLevel: 1, buildingId: null,
  hp: MINING_CONFIG.dirtMaxHp, maxHp: MINING_CONFIG.dirtMaxHp,
});
const ROCK: TerrainCell = Object.freeze({
  terrain: "rock", terrainLevel: 1, buildingId: null, hp: null, maxHp: null,
});
const MARKER_CELLS = new Map<string, TerrainCell>([
  [".", EMPTY],
  ["G", EMPTY],
  ["S", EMPTY],
  ["+", DIRT],
  ["#", ROCK],
]);

const spawnRow = TEST_MAP_LAYOUT.findIndex((row) => row.includes("S"));
const SPAWN = Object.freeze({ col: TEST_MAP_LAYOUT[spawnRow]?.indexOf("S") ?? -1, row: spawnRow });
const INITIAL_TERRAIN = TEST_MAP_LAYOUT.map((row) => Array.from(row, (marker) => {
  const cell = MARKER_CELLS.get(marker);
  if (!cell) throw new Error(`Invalid test map marker: ${marker}`);
  return cell;
}));

export class TerrainMap implements TerrainReader {
  readonly columns = MAP_COLUMNS;
  readonly rows = MAP_ROWS;
  readonly spawn = SPAWN;

  #cells = INITIAL_TERRAIN.map((row) => row.slice());
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  isInside({ col, row }: GridPosition): boolean {
    return Number.isInteger(col) && Number.isInteger(row)
      && col >= 0 && col < this.columns && row >= 0 && row < this.rows;
  }

  getCell(position: GridPosition): TerrainCell | undefined {
    return this.isInside(position) ? this.#cells[position.row][position.col] : undefined;
  }

  isWalkable(position: GridPosition): boolean {
    return this.getCell(position)?.terrain === "empty";
  }

  getWalkableNeighbors({ col, row }: GridPosition): GridPosition[] {
    if (!this.isInside({ col, row })) return [];

    return [
      { col, row: row - 1 },
      { col: col + 1, row },
      { col, row: row + 1 },
      { col: col - 1, row },
    ].filter((neighbor) => this.isWalkable(neighbor));
  }

  isGoal({ col, row }: GridPosition): boolean {
    return TEST_MAP_LAYOUT[row]?.[col] === "G";
  }

  getDigFailure(from: GridPosition, target: GridPosition): DigFailure | undefined {
    const cell = this.getDigTarget(from, target);
    return typeof cell === "string" ? cell : undefined;
  }

  applyDigDamage(from: GridPosition, target: GridPosition, damage: number): DigResult {
    const cell = this.getDigTarget(from, target);
    if (typeof cell === "string") {
      return { effective: false, damage: 0, hp: this.getCell(target)?.hp ?? null, cleared: false, reason: cell };
    }

    const hp = Number.isFinite(damage) && damage > 0 ? Math.max(0, cell.hp - damage) : cell.hp;
    if (hp === cell.hp) {
      return { effective: false, damage: 0, hp: cell.hp, cleared: false, reason: "invalid-damage" };
    }

    const cleared = hp === 0;
    this.#cells[target.row][target.col] = cleared ? EMPTY : Object.freeze({ ...cell, hp });
    if (cleared) this.#revision += 1;
    return { effective: true, damage: cell.hp - hp, hp, cleared };
  }

  private getDigTarget(from: GridPosition, target: GridPosition): Extract<TerrainCell, { terrain: "dirt" }> | DigFailure {
    const cell = this.getCell(target);
    if (!cell) return "out-of-bounds";
    if (!this.isWalkable(from)) return "invalid-origin";

    const distance = Math.abs(from.col - target.col) + Math.abs(from.row - target.row);
    if (distance !== 1) return "out-of-reach";
    if (cell.terrain === "rock") return "rock";
    if (cell.terrain === "empty") return "empty";
    return cell;
  }

  reset(): void {
    this.#cells = INITIAL_TERRAIN.map((row) => row.slice());
    this.#revision += 1;
  }
}

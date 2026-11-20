import { BUILDING_SYNTHESIS_CONFIG, BuildingStore } from "./buildings.ts";
import type { Building, BuildingKind, WallImpact } from "./buildings.ts";
import { TERRAIN_HP_BY_LEVEL } from "./mining-config.ts";
import { TEST_MAP_LAYOUT } from "./test-map.ts";

export const MAP_COLUMNS = 24;
export const MAP_ROWS = 32;
export const CHUNK_ROWS = MAP_ROWS;

export interface GridPosition {
  readonly col: number;
  readonly row: number;
}

export interface ChunkId {
  readonly chunkCol: number;
  readonly chunkRow: number;
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
  /** Changes when map walkability changes or the map resets. */
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
  | "tool-level"
  | "invalid-damage";

export type DigResult =
  | { readonly effective: true; readonly damage: number; readonly hp: number; readonly cleared: boolean }
  | { readonly effective: false; readonly damage: 0; readonly hp: number | null; readonly cleared: false; readonly reason: DigFailure };

const EMPTY: TerrainCell = Object.freeze({
  terrain: "empty", terrainLevel: 0, buildingId: null, hp: 0, maxHp: 0,
});
function dirt(level: keyof typeof TERRAIN_HP_BY_LEVEL): TerrainCell {
  const maxHp = TERRAIN_HP_BY_LEVEL[level];
  return Object.freeze({ terrain: "dirt", terrainLevel: level, buildingId: null, hp: maxHp, maxHp });
}

const ROCK: TerrainCell = Object.freeze({
  terrain: "rock", terrainLevel: 1, buildingId: null, hp: null, maxHp: null,
});
const MARKER_CELLS = new Map<string, TerrainCell>([
  [".", EMPTY],
  ["G", EMPTY],
  ["S", EMPTY],
  ["+", dirt(1)],
  ["2", dirt(2)],
  ["#", ROCK],
]);

type TerrainChunk = TerrainCell[][];

interface TerrainOptions {
  readonly autoMerge?: boolean;
}

function chunkRowFor(row: number): number {
  return Math.floor(row / CHUNK_ROWS);
}

export class TerrainMap implements TerrainReader {
  readonly columns: number;
  readonly rows: number;
  readonly spawn: GridPosition;

  readonly #layout: readonly string[];
  readonly #initialChunks: readonly TerrainChunk[];
  readonly #buildings: BuildingStore;
  readonly #autoMerge: boolean;
  #chunks: TerrainChunk[];
  #revision = 0;

  constructor(layout: readonly string[] = TEST_MAP_LAYOUT, options: TerrainOptions = {}) {
    this.#layout = [...layout];
    this.#autoMerge = options.autoMerge ?? BUILDING_SYNTHESIS_CONFIG.autoMerge;
    this.rows = this.#layout.length;
    this.columns = this.#layout[0]?.length ?? 0;
    if (this.columns === 0 || this.rows % CHUNK_ROWS !== 0 || this.#layout.some((row) => row.length !== this.columns)) {
      throw new RangeError(`Terrain layout must have a common positive width and complete ${CHUNK_ROWS}-row chunks`);
    }
    this.#buildings = new BuildingStore(this.columns);
    const spawnRow = this.#layout.findIndex((row) => row.includes("S"));
    const spawnCol = this.#layout[spawnRow]?.indexOf("S") ?? -1;
    if (spawnRow < 0
      || this.#layout[spawnRow].includes("S", spawnCol + 1)
      || this.#layout.slice(spawnRow + 1).some((row) => row.includes("S"))) {
      throw new Error("Terrain layout must contain exactly one spawn");
    }
    this.spawn = Object.freeze({ col: spawnCol, row: spawnRow });

    this.#initialChunks = Array.from({ length: this.rows / CHUNK_ROWS }, (_, chunkRow) => {
      const firstRow = chunkRow * CHUNK_ROWS;
      return this.#layout.slice(firstRow, firstRow + CHUNK_ROWS).map((row) => Array.from(row, (marker) => {
        const cell = MARKER_CELLS.get(marker);
        if (!cell) throw new Error(`Invalid test map marker: ${marker}`);
        return cell;
      }));
    });
    this.#chunks = this.copyInitialChunks();
  }

  get revision(): number {
    return this.#revision;
  }

  isInside({ col, row }: GridPosition): boolean {
    return Number.isInteger(col) && Number.isInteger(row)
      && col >= 0 && col < this.columns && row >= 0 && row < this.rows;
  }

  worldToChunk(position: GridPosition): { readonly chunk: ChunkId; readonly local: GridPosition } | undefined {
    if (!this.isInside(position)) return undefined;
    return {
      chunk: { chunkCol: 0, chunkRow: chunkRowFor(position.row) },
      local: { col: position.col, row: position.row % CHUNK_ROWS },
    };
  }

  chunkToWorld({ chunkCol, chunkRow }: ChunkId, { col, row }: GridPosition): GridPosition | undefined {
    if (chunkCol !== 0 || !Number.isInteger(chunkRow) || !Number.isInteger(row) || row < 0 || row >= CHUNK_ROWS) {
      return undefined;
    }
    const position = { col, row: chunkRow * CHUNK_ROWS + row };
    return this.isInside(position) ? position : undefined;
  }

  getCell(position: GridPosition): TerrainCell | undefined {
    if (!this.isInside(position)) return undefined;
    const cell = this.cellRow(position.row)[position.col];
    const building = this.#buildings.get(position);
    return building ? Object.freeze({ ...cell, buildingId: building.id }) : cell;
  }

  isWalkable(position: GridPosition): boolean {
    const cell = this.getCell(position);
    return cell?.terrain === "empty" && cell.buildingId === null;
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

  isGoal(position: GridPosition): boolean {
    return this.isInside(position) && this.#layout[position.row][position.col] === "G";
  }

  getBuilding(position: GridPosition): Building | undefined {
    return this.isInside(position) ? this.#buildings.get(position) : undefined;
  }

  getBuildings(): Iterable<Building> {
    return this.#buildings.values();
  }

  placeBuilding(kind: BuildingKind, position: GridPosition, hp = 50): Building | undefined {
    if (!this.isInside(position) || this.cellRow(position.row)[position.col].terrain !== "empty") return undefined;
    const building = this.#buildings.place(kind, position, hp);
    if (!building) return undefined;
    const merged = this.#autoMerge ? this.#buildings.synthesize(position) : undefined;
    this.#revision += 1;
    return merged ?? building;
  }

  synthesizeBuilding(position: GridPosition): Building | undefined {
    if (!this.isInside(position)) return undefined;
    const merged = this.#buildings.synthesize(position);
    if (merged) this.#revision += 1;
    return merged;
  }

  removeBuilding(position: GridPosition, expectedId?: string): Building | undefined {
    if (!this.isInside(position)) return undefined;
    const building = this.#buildings.remove(position, expectedId);
    if (building) this.#revision += 1;
    return building;
  }

  impactWall(position: GridPosition, wallId: string, damage: number): WallImpact | undefined {
    if (!this.isInside(position)) return undefined;
    const impact = this.#buildings.impactWall(position, wallId, damage);
    if (impact?.destroyed) this.#revision += 1;
    return impact;
  }

  getDigFailure(from: GridPosition, target: GridPosition, toolLevel = 1): DigFailure | undefined {
    const cell = this.getDigTarget(from, target, toolLevel);
    return typeof cell === "string" ? cell : undefined;
  }

  applyDigDamage(from: GridPosition, target: GridPosition, damage: number, toolLevel = 1): DigResult {
    const cell = this.getDigTarget(from, target, toolLevel);
    if (typeof cell === "string") {
      return { effective: false, damage: 0, hp: this.getCell(target)?.hp ?? null, cleared: false, reason: cell };
    }

    const hp = Number.isFinite(damage) && damage > 0 ? Math.max(0, cell.hp - damage) : cell.hp;
    if (hp === cell.hp) {
      return { effective: false, damage: 0, hp: cell.hp, cleared: false, reason: "invalid-damage" };
    }

    const cleared = hp === 0;
    this.cellRow(target.row)[target.col] = cleared ? EMPTY : Object.freeze({ ...cell, hp });
    if (cleared) this.#revision += 1;
    return { effective: true, damage: cell.hp - hp, hp, cleared };
  }

  private getDigTarget(
    from: GridPosition, target: GridPosition, toolLevel: number,
  ): Extract<TerrainCell, { terrain: "dirt" }> | DigFailure {
    const cell = this.getCell(target);
    if (!cell) return "out-of-bounds";
    if (!this.isWalkable(from)) return "invalid-origin";

    const distance = Math.abs(from.col - target.col) + Math.abs(from.row - target.row);
    if (distance !== 1) return "out-of-reach";
    if (cell.terrain === "rock") return "rock";
    if (cell.terrain === "empty") return "empty";
    if (!Number.isInteger(toolLevel) || toolLevel < cell.terrainLevel) return "tool-level";
    return cell;
  }

  reset(): void {
    this.#chunks = this.copyInitialChunks();
    this.#buildings.clear();
    this.#revision += 1;
  }

  private cellRow(row: number): TerrainCell[] {
    return this.#chunks[chunkRowFor(row)][row % CHUNK_ROWS];
  }

  private copyInitialChunks(): TerrainChunk[] {
    return this.#initialChunks.map((chunk) => chunk.map((row) => row.slice()));
  }
}

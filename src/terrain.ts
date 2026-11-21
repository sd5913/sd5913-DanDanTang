import { buildingMaxHp } from "./building-balance.ts";
import type { BuildingBalanceId } from "./building-balance.ts";
import { BUILDING_SYNTHESIS_CONFIG, BuildingStore } from "./buildings.ts";
import type {
  Building, BuildingImpact, BuildingKind, BuildingSynthesisPreview, BuildingSynthesisResult, ReadyBuildingSynthesis, WallImpact,
} from "./buildings.ts";
import type { BiomeId } from "./expedition-biomes.ts";
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

export type TerrainType = "empty" | "dirt" | "rock" | "water";

interface TerrainCellFields {
  readonly terrainLevel: number;
  readonly buildingId: string | null;
}

export type TerrainCell = TerrainCellFields & (
  | { readonly terrain: "dirt"; readonly hp: number; readonly maxHp: number }
  | { readonly terrain: "empty"; readonly hp: 0; readonly maxHp: 0 }
  | { readonly terrain: "rock"; readonly hp: null; readonly maxHp: null }
  | { readonly terrain: "water"; readonly hp: null; readonly maxHp: null }
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
  | "water"
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
const WATER: TerrainCell = Object.freeze({
  terrain: "water", terrainLevel: 0, buildingId: null, hp: null, maxHp: null,
});
const MARKER_CELLS = new Map<string, TerrainCell>([
  [".", EMPTY],
  ["G", EMPTY],
  ["S", EMPTY],
  ["+", dirt(1)],
  ["2", dirt(2)],
  ["#", ROCK],
  ["~", WATER],
]);

type TerrainChunk = TerrainCell[][];

export interface TerrainOptions {
  readonly autoMerge?: boolean;
  readonly biomes?: readonly (readonly BiomeId[])[];
  readonly buildingBalance?: BuildingBalanceId;
  readonly towerEvolution?: boolean;
}

function chunkRowFor(row: number): number {
  return Math.floor(row / CHUNK_ROWS);
}

export class TerrainMap implements TerrainReader {
  readonly columns: number;
  readonly rows: number;
  readonly spawn: GridPosition;
  readonly buildingBalance: BuildingBalanceId;

  readonly #layout: readonly string[];
  readonly #initialChunks: readonly TerrainChunk[];
  readonly #biomes?: readonly (readonly BiomeId[])[];
  readonly #buildings: BuildingStore;
  readonly #autoMerge: boolean;
  #chunks: TerrainChunk[];
  #revision = 0;

  constructor(layout: readonly string[] = TEST_MAP_LAYOUT, options: TerrainOptions = {}) {
    this.#layout = [...layout];
    this.buildingBalance = options.buildingBalance ?? "control";
    this.#autoMerge = options.autoMerge ?? BUILDING_SYNTHESIS_CONFIG.autoMerge;
    this.rows = this.#layout.length;
    this.columns = this.#layout[0]?.length ?? 0;
    if (this.columns === 0 || this.rows % CHUNK_ROWS !== 0 || this.#layout.some((row) => row.length !== this.columns)) {
      throw new RangeError(`Terrain layout must have a common positive width and complete ${CHUNK_ROWS}-row chunks`);
    }
    if (options.biomes && (options.biomes.length !== this.rows || options.biomes.some((row) => row.length !== this.columns))) {
      throw new RangeError("Biome metadata must match the terrain dimensions");
    }
    this.#biomes = options.biomes?.map((row) => [...row]);
    this.#buildings = new BuildingStore(this.columns, this.buildingBalance, options.towerEvolution);
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

  getBiome(position: GridPosition): BiomeId | undefined {
    if (!this.isInside(position)) return undefined;
    return this.#biomes?.[position.row][position.col] ?? "ordinary";
  }

  getBuilding(position: GridPosition): Building | undefined {
    return this.isInside(position) ? this.#buildings.get(position) : undefined;
  }

  getBuildings(): Iterable<Building> {
    return this.#buildings.values();
  }

  previewBuildingSynthesis(kind: BuildingKind, position: GridPosition): BuildingSynthesisPreview | undefined {
    if (!this.#autoMerge || !this.isWalkable(position)) return undefined;
    return this.#buildings.previewSynthesis(kind, position, buildingMaxHp(kind, this.buildingBalance));
  }

  previewReadySynthesis(position: GridPosition): ReadyBuildingSynthesis | undefined {
    return !this.#autoMerge && this.isInside(position) ? this.#buildings.previewReadySynthesis(position) : undefined;
  }

  executeBuildingSynthesis(expected: ReadyBuildingSynthesis, player: GridPosition): BuildingSynthesisResult {
    if (this.#autoMerge || !this.isInside(expected.retained)) return { success: false, reason: "invalid" };
    if (!this.isWalkable(player)) return { success: false, reason: "out-of-range" };
    const result = this.#buildings.executeReadySynthesis(expected, player);
    if (result.success) this.#revision += 1;
    return result;
  }

  placeBuilding(kind: BuildingKind, position: GridPosition, hp = buildingMaxHp(kind, this.buildingBalance)): Building | undefined {
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

  damageBuilding(position: GridPosition, buildingId: string, damage: number): BuildingImpact | undefined {
    if (!this.isInside(position)) return undefined;
    const impact = this.#buildings.damageBuilding(position, buildingId, damage);
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
    if (cell.terrain === "water") return "water";
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

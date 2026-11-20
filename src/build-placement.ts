import { PLAYER_HALF_SIZE, TILE_SIZE, worldToCell } from "./player.ts";
import type { Point } from "./player.ts";
import type { GridPosition, TerrainReader } from "./terrain.ts";

export type PlacementFailure = "round-ended" | "out-of-bounds" | "player-cell" | "out-of-range" | "not-visible"
  | "reserved" | "terrain" | "occupied" | "player-overlap" | "enemy-occupied" | "out-of-stock";
export type PlacementPreview = "valid" | "invalid";

interface PlacementConditions {
  readonly playerPosition: Point;
  readonly roundEnded: boolean;
  readonly visible: boolean;
  readonly reserved: boolean;
  readonly enemyOccupies: (cell: GridPosition) => boolean;
  /** Defined for inventory cards. The technology facility is rebuilt without a card. */
  readonly cardCount?: number;
}

export function overlapsCell({ x, y }: Point, { col, row }: GridPosition): boolean {
  const left = col * TILE_SIZE;
  const top = row * TILE_SIZE;
  return x + PLAYER_HALF_SIZE > left && x - PLAYER_HALF_SIZE < left + TILE_SIZE
    && y + PLAYER_HALF_SIZE > top && y - PLAYER_HALF_SIZE < top + TILE_SIZE;
}

export function placementFailure(map: Pick<TerrainReader, "isInside" | "getCell">, target: GridPosition,
  conditions: PlacementConditions): PlacementFailure | undefined {
  if (conditions.roundEnded) return "round-ended";
  if (!map.isInside(target)) return "out-of-bounds";
  const player = worldToCell(conditions.playerPosition.x, conditions.playerPosition.y);
  const distance = Math.max(Math.abs(player.col - target.col), Math.abs(player.row - target.row));
  if (distance === 0) return "player-cell";
  if (distance !== 1) return "out-of-range";
  if (!conditions.visible) return "not-visible";
  if (conditions.reserved) return "reserved";
  const state = map.getCell(target);
  if (state?.terrain !== "empty") return "terrain";
  if (state.buildingId !== null) return "occupied";
  if (overlapsCell(conditions.playerPosition, target)) return "player-overlap";
  if (conditions.enemyOccupies(target)) return "enemy-occupied";
  if (conditions.cardCount !== undefined && conditions.cardCount < 1) return "out-of-stock";
  return undefined;
}

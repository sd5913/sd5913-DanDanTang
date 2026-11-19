import type { GridPosition, TerrainReader } from './terrain.ts';

export const TILE_SIZE = 24;
export const PLAYER_HALF_SIZE = 7;
const MOVE_SPEED = 120;
const MAX_FRAME_MS = 50;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function cellCenter({ col, row }: GridPosition): Point {
  return { x: (col + 0.5) * TILE_SIZE, y: (row + 0.5) * TILE_SIZE };
}

export function worldToCell(x: number, y: number): GridPosition {
  return { col: Math.floor(x / TILE_SIZE), row: Math.floor(y / TILE_SIZE) };
}

export class Player {
  #position: Point;

  constructor(spawn: GridPosition) {
    this.#position = cellCenter(spawn);
  }

  get position(): Point {
    return this.#position;
  }

  get cell(): GridPosition {
    return worldToCell(this.#position.x, this.#position.y);
  }

  reset(spawn: GridPosition): void {
    this.#position = cellCenter(spawn);
  }

  move(horizontal: number, vertical: number, deltaMs: number, map: Pick<TerrainReader, 'isWalkable'>): void {
    const inputLength = Math.hypot(horizontal, vertical);
    if (inputLength === 0 || deltaMs <= 0) return;

    const distance = MOVE_SPEED * Math.min(deltaMs, MAX_FRAME_MS) / 1_000;
    const dx = (horizontal / inputLength) * distance;
    const dy = (vertical / inputLength) * distance;

    // Resolve each axis separately so the free component can slide along a wall.
    const { x, y } = this.#position;
    const nextX = sweepAxis(x, y, dx, (col, row) => map.isWalkable({ col, row }));
    const nextY = sweepAxis(y, nextX, dy, (row, col) => map.isWalkable({ col, row }));
    this.#position = { x: nextX, y: nextY };
  }
}

function sweepAxis(
  position: number,
  crossPosition: number,
  distance: number,
  isWalkable: (forwardCell: number, crossCell: number) => boolean,
): number {
  if (distance === 0) return position;

  const direction = Math.sign(distance);
  const edge = position + direction * PLAYER_HALF_SIZE;
  const destination = position + distance;
  const endEdge = destination + direction * PLAYER_HALF_SIZE;

  // Include cells the leading edge enters. Exact contact at the destination is safe.
  const firstForward = direction > 0 ? Math.floor(edge / TILE_SIZE) : Math.ceil(edge / TILE_SIZE) - 1;
  const lastForward = direction > 0 ? Math.ceil(endEdge / TILE_SIZE) - 1 : Math.floor(endEdge / TILE_SIZE);
  const firstCross = Math.floor((crossPosition - PLAYER_HALF_SIZE) / TILE_SIZE);
  const lastCross = Math.ceil((crossPosition + PLAYER_HALF_SIZE) / TILE_SIZE) - 1;

  for (let forward = firstForward; direction * (forward - lastForward) <= 0; forward += direction) {
    for (let cross = firstCross; cross <= lastCross; cross += 1) {
      if (!isWalkable(forward, cross)) {
        const boundary = direction > 0 ? forward * TILE_SIZE : (forward + 1) * TILE_SIZE;
        return boundary - direction * PLAYER_HALF_SIZE;
      }
    }
  }

  return destination;
}

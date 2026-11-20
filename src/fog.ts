import type { GridPosition } from "./terrain.ts";

const PLAYER_RADIUS = 8;
const UNKNOWN = 0;
const EXPLORED = 1;
const VISIBLE = 2;

export type FogVisibility = "unknown" | "explored" | "visible";

export interface FogSource {
  readonly cell: GridPosition;
  readonly radius: number;
}

export class ExplorationFog {
  readonly columns: number;
  readonly rows: number;
  readonly #cells: Uint8Array;
  readonly #visible: number[] = [];
  #revision = 0;

  constructor(columns: number, rows: number) {
    if (!Number.isSafeInteger(columns) || columns < 1 || !Number.isSafeInteger(rows) || rows < 1) {
      throw new RangeError("Fog needs positive integer dimensions");
    }
    this.columns = columns;
    this.rows = rows;
    this.#cells = new Uint8Array(columns * rows);
  }

  get revision(): number { return this.#revision; }

  reveal(player: GridPosition, towers?: Iterable<FogSource>): void {
    for (const index of this.#visible) this.#cells[index] = EXPLORED;
    this.#visible.length = 0;

    this.revealAround(player, PLAYER_RADIUS);
    if (towers) {
      for (const { cell, radius } of towers) this.revealAround(cell, radius);
    }
    this.#revision += 1;
  }

  visibility(cell: GridPosition): FogVisibility {
    if (!this.isInside(cell)) return "unknown";
    const state = this.#cells[cell.row * this.columns + cell.col];
    if (state === VISIBLE) return "visible";
    if (state === EXPLORED) return "explored";
    return "unknown";
  }

  reset(): void {
    this.#cells.fill(UNKNOWN);
    this.#visible.length = 0;
    this.#revision += 1;
  }

  private revealAround(center: GridPosition, radius: number): void {
    if (!this.isInside(center) || !Number.isFinite(radius) || radius < 0) return;
    const extent = Math.floor(radius);
    const firstRow = Math.max(0, center.row - extent);
    const lastRow = Math.min(this.rows - 1, center.row + extent);
    const firstCol = Math.max(0, center.col - extent);
    const lastCol = Math.min(this.columns - 1, center.col + extent);
    const radiusSquared = radius * radius;

    for (let row = firstRow; row <= lastRow; row += 1) {
      const rowDistanceSquared = (row - center.row) ** 2;
      for (let col = firstCol; col <= lastCol; col += 1) {
        if ((col - center.col) ** 2 + rowDistanceSquared > radiusSquared) continue;
        const index = row * this.columns + col;
        if (this.#cells[index] === VISIBLE) continue;
        this.#cells[index] = VISIBLE;
        this.#visible.push(index);
      }
    }
  }

  private isInside({ col, row }: GridPosition): boolean {
    return Number.isInteger(col) && Number.isInteger(row)
      && col >= 0 && col < this.columns && row >= 0 && row < this.rows;
  }
}

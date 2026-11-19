import type { GridPosition, TerrainMap } from "./terrain.ts";

type NavigationMap = Pick<TerrainMap, "columns" | "rows" | "revision" | "isWalkable" | "getBuilding">;

export type NavigationAction =
  | { readonly kind: "move"; readonly cell: GridPosition }
  | { readonly kind: "wall"; readonly cell: GridPosition; readonly wallId: string }
  | { readonly kind: "arrived" }
  | { readonly kind: "unreachable" };

interface RouteField {
  readonly open: Int32Array;
  breach?: { readonly distance: Float64Array; readonly entryCost: Int32Array };
}

interface SearchEntry {
  readonly cell: number;
  readonly distance: number;
}

const MAX_TARGET_FIELDS = 4;
const UNREACHABLE: NavigationAction = { kind: "unreachable" };
const ARRIVED: NavigationAction = { kind: "arrived" };

export class EnemyNavigation {
  private readonly map: NavigationMap;
  private readonly fields = new Map<number, RouteField>();
  private readonly size: number;
  private revision: number;
  private searches = 0;

  constructor(map: NavigationMap) {
    this.map = map;
    this.size = map.columns * map.rows;
    this.revision = map.revision;
  }

  get searchCount(): number {
    return this.searches;
  }

  next(from: GridPosition, target: GridPosition): NavigationAction {
    if (!this.isInside(from) || !this.isInside(target) || !this.map.isWalkable(from)) return UNREACHABLE;
    const fromIndex = this.index(from);
    const targetIndex = this.index(target);
    const neighbors = this.neighbors(fromIndex);
    if (fromIndex === targetIndex) {
      const exit = neighbors.find((neighbor) => this.map.isWalkable(this.position(neighbor)));
      return exit === undefined ? UNREACHABLE : { kind: "move", cell: this.position(exit) };
    }

    const field = this.getField(targetIndex);
    const openDistance = field.open[fromIndex];
    if (openDistance === 0) return ARRIVED;
    if (openDistance > 0) {
      const nextIndex = neighbors.find((neighbor) => field.open[neighbor] === openDistance - 1);
      return nextIndex === undefined ? UNREACHABLE : { kind: "move", cell: this.position(nextIndex) };
    }

    const { distance, entryCost } = field.breach ??= this.buildBreachField(targetIndex);
    const best = distance[fromIndex];
    if (!Number.isFinite(best)) return UNREACHABLE;

    for (const nextIndex of neighbors) {
      const cost = entryCost[nextIndex];
      if (cost === 0 || distance[nextIndex] + cost !== best) continue;
      const cell = this.position(nextIndex);
      if (cost === 1) return { kind: "move", cell };
      const wall = this.map.getBuilding(cell);
      if (wall?.kind === "wall") return { kind: "wall", cell, wallId: wall.id };
    }
    return UNREACHABLE;
  }

  private getField(target: number): RouteField {
    if (this.revision !== this.map.revision) {
      this.fields.clear();
      this.revision = this.map.revision;
    }
    const cached = this.fields.get(target);
    if (cached) {
      this.fields.delete(target);
      this.fields.set(target, cached);
      return cached;
    }
    if (this.fields.size === MAX_TARGET_FIELDS) {
      const oldest = this.fields.keys().next();
      if (!oldest.done) this.fields.delete(oldest.value);
    }
    const field = { open: this.buildOpenField(target) };
    this.fields.set(target, field);
    return field;
  }

  private buildOpenField(target: number): Int32Array {
    this.searches += 1;
    const distance = new Int32Array(this.size).fill(-1);
    const queue: number[] = [];
    for (const position of this.neighbors(target)) {
      if (!this.map.isWalkable(this.position(position))) continue;
      distance[position] = 0;
      queue.push(position);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const cell = queue[head];
      for (const neighbor of this.neighbors(cell)) {
        if (neighbor === target || distance[neighbor] !== -1 || !this.map.isWalkable(this.position(neighbor))) continue;
        distance[neighbor] = distance[cell] + 1;
        queue.push(neighbor);
      }
    }
    return distance;
  }

  private buildBreachField(target: number): NonNullable<RouteField["breach"]> {
    this.searches += 1;
    const distance = new Float64Array(this.size).fill(Infinity);
    const entryCost = new Int32Array(this.size);
    // Fixed topological cost prefers fewer walls, then shorter routes, independently of wall HP.
    const wallCost = this.size + 1;
    for (let index = 0; index < this.size; index += 1) {
      if (index === target) continue;
      const cell = this.position(index);
      if (this.map.isWalkable(cell)) entryCost[index] = 1;
      else if (this.map.getBuilding(cell)?.kind === "wall") entryCost[index] = wallCost;
    }

    const openQueue: SearchEntry[] = [];
    const wallQueue: SearchEntry[] = [];
    for (const cell of this.neighbors(target)) {
      if (entryCost[cell] === 0) continue;
      distance[cell] = 0;
      openQueue.push({ cell, distance: 0 });
    }

    let openHead = 0;
    let wallHead = 0;
    while (openHead < openQueue.length || wallHead < wallQueue.length) {
      // Reverse Dijkstra has two fixed edge costs. Each cost's queue stays sorted as
      // settled distances rise, so its minimum is one of these two queue heads.
      const open = openQueue[openHead];
      const wall = wallQueue[wallHead];
      const current = open && (!wall || open.distance <= wall.distance) ? openQueue[openHead++] : wallQueue[wallHead++];
      if (current.distance !== distance[current.cell]) continue;
      const step = entryCost[current.cell];
      const queue = step === 1 ? openQueue : wallQueue;
      const candidate = current.distance + step;
      for (const neighbor of this.neighbors(current.cell)) {
        if (entryCost[neighbor] === 0 || candidate >= distance[neighbor]) continue;
        distance[neighbor] = candidate;
        queue.push({ cell: neighbor, distance: candidate });
      }
    }
    return { distance, entryCost };
  }

  private index({ col, row }: GridPosition): number {
    return row * this.map.columns + col;
  }

  private position(index: number): GridPosition {
    return { col: index % this.map.columns, row: Math.floor(index / this.map.columns) };
  }

  private isInside({ col, row }: GridPosition): boolean {
    return Number.isInteger(col) && Number.isInteger(row)
      && col >= 0 && col < this.map.columns && row >= 0 && row < this.map.rows;
  }

  private neighbors(index: number): number[] {
    const { columns } = this.map;
    const col = index % columns;
    const cells: number[] = [];
    if (index >= columns) cells.push(index - columns);
    if (col + 1 < columns) cells.push(index + 1);
    if (index + columns < this.size) cells.push(index + columns);
    if (col > 0) cells.push(index - 1);
    return cells;
  }
}

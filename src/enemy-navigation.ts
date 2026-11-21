import type { Building } from "./buildings.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

export type NavigationMap = Pick<TerrainMap, "columns" | "rows" | "revision" | "isWalkable" | "getBuilding">;

export type NavigationAction =
  | { readonly kind: "move"; readonly cell: GridPosition }
  | { readonly kind: "wall"; readonly cell: GridPosition; readonly wallId: string }
  | { readonly kind: "building"; readonly cell: GridPosition; readonly buildingId: string }
  | { readonly kind: "arrived" }
  | { readonly kind: "unreachable" };

export type NavigationApproach = { readonly steps: number; readonly known: boolean } & (
  | { readonly boundary: "contact" }
  | { readonly boundary: "wall"; readonly wallId: string }
  | { readonly boundary: "building"; readonly buildingId: string }
);

interface RouteField {
  readonly targets: readonly number[];
  readonly open: { readonly distance: Int32Array; readonly owner: Int32Array };
  breach?: BreachField;
  structureBreach?: BreachField;
}

interface BreachField {
  readonly distance: Float64Array;
  readonly owner: Int32Array;
  readonly entryCost: Int32Array;
}

interface SearchEntry {
  readonly cell: number;
  readonly distance: number;
}

interface RouteChoice {
  readonly owner: number;
  readonly action: NavigationAction;
}

const MAX_TARGET_FIELDS = 4;
const UNREACHABLE: NavigationAction = { kind: "unreachable" };
const ARRIVED: NavigationAction = { kind: "arrived" };

export class EnemyNavigation {
  private readonly map: NavigationMap;
  private readonly fields = new Map<number, RouteField>();
  private buildingField?: { readonly buildings: readonly Building[]; readonly routes: RouteField };
  private readonly size: number;
  private revision: number;
  private searches = 0;
  private computeTimeMs = 0;

  constructor(map: NavigationMap) {
    this.map = map;
    this.size = map.columns * map.rows;
    this.revision = map.revision;
  }

  get searchCount(): number {
    return this.searches;
  }

  get searchTimeMs(): number {
    return this.computeTimeMs;
  }

  next(from: GridPosition, target: GridPosition, allowBreach = true, allowStructureBreach = false): NavigationAction {
    if (!this.isInside(from) || !this.isInside(target) || !this.map.isWalkable(from)) return UNREACHABLE;
    const fromIndex = this.index(from);
    const targetIndex = this.index(target);
    if (fromIndex === targetIndex) {
      const exit = this.neighbors(fromIndex).find((neighbor) => this.map.isWalkable(this.position(neighbor)));
      return exit === undefined ? UNREACHABLE : { kind: "move", cell: this.position(exit) };
    }

    return this.followField(fromIndex, this.getField(targetIndex), allowBreach, allowStructureBreach)?.action ?? UNREACHABLE;
  }

  /** Trace the same chosen field to contact or to the first wall the live unit would hit. */
  traceApproach(from: GridPosition, target: GridPosition, isKnown: (cell: GridPosition) => boolean,
    allowBreach: boolean, buildings?: readonly Building[], allowStructureBreach = false): NavigationApproach | undefined {
    if (!this.isInside(from) || !this.isInside(target) || !this.map.isWalkable(from)) return undefined;
    let index = this.index(from);
    const targetIndex = this.index(target);
    let known = isKnown(from) && isKnown(target);
    if (index === targetIndex) return { boundary: "contact", steps: 0, known };

    const field = buildings ? this.getBuildingField(buildings) : this.getField(targetIndex);
    for (let steps = 0; steps < this.size; steps += 1) {
      const next = this.followField(index, field, allowBreach, allowStructureBreach);
      if (!next || field.targets[next.owner] !== targetIndex) return undefined;
      if (next.action.kind === "arrived") return { boundary: "contact", steps, known };
      if (next.action.kind === "wall") {
        return { boundary: "wall", wallId: next.action.wallId, steps, known: known && isKnown(next.action.cell) };
      }
      if (next.action.kind === "building") {
        return { boundary: "building", buildingId: next.action.buildingId, steps, known: known && isKnown(next.action.cell) };
      }
      if (next.action.kind !== "move") return undefined;
      index = this.index(next.action.cell);
      known = known && isKnown(next.action.cell);
    }
    return undefined;
  }

  /** The caller reuses the current building list until map topology changes. */
  nextBuilding(from: GridPosition, buildings: readonly Building[]): { building: Building; action: NavigationAction } | undefined {
    if (buildings.length === 0 || !this.isInside(from) || !this.map.isWalkable(from)) return undefined;
    const choice = this.followField(this.index(from), this.getBuildingField(buildings), true);
    return choice && { building: buildings[choice.owner], action: choice.action };
  }

  private getBuildingField(buildings: readonly Building[]): RouteField {
    this.syncRevision();
    if (this.buildingField?.buildings !== buildings) {
      this.buildingField = { buildings, routes: this.createField(buildings.map((building) => this.index(building.cell))) };
    }
    return this.buildingField.routes;
  }

  private followField(fromIndex: number, field: RouteField, allowBreach: boolean, allowStructureBreach = false): RouteChoice | undefined {
    const openDistance = field.open.distance[fromIndex];
    const owner = field.open.owner[fromIndex];
    if (openDistance === 0) return { owner, action: ARRIVED };

    const neighbors = this.neighbors(fromIndex);
    if (openDistance > 0) {
      const nextIndex = neighbors.find((neighbor) => field.open.distance[neighbor] === openDistance - 1
        && field.open.owner[neighbor] === owner);
      return nextIndex === undefined ? undefined : { owner, action: { kind: "move", cell: this.position(nextIndex) } };
    }

    if (!allowBreach) return undefined;
    const breach = allowStructureBreach ? field.structureBreach ??= this.buildBreachField(field.targets, true)
      : field.breach ??= this.buildBreachField(field.targets, false);
    const { distance, owner: owners, entryCost } = breach;
    const best = distance[fromIndex];
    if (!Number.isFinite(best)) return undefined;
    const breachOwner = owners[fromIndex];

    for (const nextIndex of neighbors) {
      const cost = entryCost[nextIndex];
      if (cost === 0 || owners[nextIndex] !== breachOwner || distance[nextIndex] + cost !== best) continue;
      const cell = this.position(nextIndex);
      if (cost === 1) return { owner: breachOwner, action: { kind: "move", cell } };
      const building = this.map.getBuilding(cell);
      if (building?.kind === "wall") return { owner: breachOwner, action: { kind: "wall", cell, wallId: building.id } };
      if (building && allowStructureBreach) {
        return { owner: breachOwner, action: { kind: "building", cell, buildingId: building.id } };
      }
    }
    return undefined;
  }

  private syncRevision(): void {
    if (this.revision !== this.map.revision) {
      this.fields.clear();
      this.buildingField = undefined;
      this.revision = this.map.revision;
    }
  }

  private getField(target: number): RouteField {
    this.syncRevision();
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
    const field = this.createField([target]);
    this.fields.set(target, field);
    return field;
  }

  private createField(targets: readonly number[]): RouteField {
    return { targets, open: this.buildOpenField(targets) };
  }

  private buildOpenField(targets: readonly number[]): RouteField["open"] {
    const start = performance.now();
    this.searches += 1;
    const distance = new Int32Array(this.size).fill(-1);
    const owner = new Int32Array(this.size).fill(-1);
    const targetCells = new Set(targets);
    const queue: number[] = [];
    targets.forEach((target, index) => {
      for (const position of this.neighbors(target)) {
        if (targetCells.has(position) || distance[position] === 0 || !this.map.isWalkable(this.position(position))) continue;
        distance[position] = 0;
        owner[position] = index;
        queue.push(position);
      }
    });
    for (let head = 0; head < queue.length; head += 1) {
      const cell = queue[head];
      for (const neighbor of this.neighbors(cell)) {
        if (targetCells.has(neighbor) || distance[neighbor] !== -1 || !this.map.isWalkable(this.position(neighbor))) continue;
        distance[neighbor] = distance[cell] + 1;
        owner[neighbor] = owner[cell];
        queue.push(neighbor);
      }
    }
    this.computeTimeMs += performance.now() - start;
    return { distance, owner };
  }

  private buildBreachField(targets: readonly number[], allowStructureBreach: boolean): BreachField {
    const start = performance.now();
    this.searches += 1;
    const distance = new Float64Array(this.size).fill(Infinity);
    const owner = new Int32Array(this.size).fill(-1);
    const entryCost = new Int32Array(this.size);
    const targetCells = new Set(targets);
    // Fixed topological cost prefers fewer blockers, then shorter routes, independently of structure HP.
    const wallCost = this.size + 1;
    for (let index = 0; index < this.size; index += 1) {
      if (targetCells.has(index)) continue;
      const cell = this.position(index);
      if (this.map.isWalkable(cell)) entryCost[index] = 1;
      else {
        const building = this.map.getBuilding(cell);
        if (building && (building.kind === "wall" || allowStructureBreach)) entryCost[index] = wallCost;
      }
    }

    const openQueue: SearchEntry[] = [];
    const wallQueue: SearchEntry[] = [];
    targets.forEach((target, index) => {
      for (const cell of this.neighbors(target)) {
        if (entryCost[cell] === 0 || distance[cell] === 0) continue;
        distance[cell] = 0;
        owner[cell] = index;
        openQueue.push({ cell, distance: 0 });
      }
    });

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
        owner[neighbor] = owner[current.cell];
        queue.push({ cell: neighbor, distance: candidate });
      }
    }
    this.computeTimeMs += performance.now() - start;
    return { distance, owner, entryCost };
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

import { GENERATED_ENEMY_ENTRY, GENERATED_GOAL, GENERATED_SPAWN } from "./generated-map.ts";
import type { GridPosition } from "./terrain.ts";

export type BiomeId = "ordinary" | "plain" | "highland" | "lake";
export const BIOME_GENERATOR_VERSION = 2;

interface BiomeLayout {
  readonly layout: readonly string[];
  readonly biomes: readonly (readonly BiomeId[])[];
}

interface ZoneShape {
  readonly center: GridPosition;
  readonly radiusCol: number;
  readonly radiusRow: number;
  readonly bend: number;
}

interface DepthSlot {
  readonly firstRow: number;
  readonly lastRow: number;
}

const COLUMNS = 40;
const ROWS = 96;
const MAX_ATTEMPTS = 3;
const NEIGHBORS = [{ col: 0, row: -1 }, { col: 1, row: 0 }, { col: 0, row: 1 }, { col: -1, row: 0 }];
const SLOTS: readonly DepthSlot[] = [
  { firstRow: 12, lastRow: 40 },
  { firstRow: 41, lastRow: 61 },
  { firstRow: 62, lastRow: 82 },
];
const LAKE_BOUNDS: readonly DepthSlot[] = [
  { firstRow: 15, lastRow: 27 },
  { firstRow: 43, lastRow: 57 },
  { firstRow: 66, lastRow: 79 },
];
const ORDERS = [
  ["plain", "highland", "lake"],
  ["highland", "lake", "plain"],
  ["plain", "lake", "highland"],
  ["highland", "plain", "lake"],
  ["lake", "plain", "highland"],
  ["lake", "highland", "plain"],
] as const;

function seedChoices(seed: number): (limit: number) => number {
  let state = seed >>> 0;
  return (limit) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor(state / 0x1_0000_0000 * limit);
  };
}

function index({ col, row }: GridPosition): number {
  return row * COLUMNS + col;
}

function position(id: number): GridPosition {
  return { col: id % COLUMNS, row: Math.floor(id / COLUMNS) };
}

function zoneCells(shape: ZoneShape, firstRow: number, lastRow: number): GridPosition[] {
  const cells: GridPosition[] = [];
  for (let dy = -shape.radiusRow; dy <= shape.radiusRow; dy += 1) {
    const row = shape.center.row + dy;
    if (row < firstRow || row > lastRow) continue;
    const normalized = dy / (shape.radiusRow + 0.25);
    const reach = Math.max(1, Math.floor(shape.radiusCol * Math.sqrt(1 - normalized ** 2)));
    const middle = shape.center.col + Math.round(dy / shape.radiusRow * shape.bend);
    for (let col = Math.max(2, middle - reach); col <= Math.min(COLUMNS - 3, middle + reach); col += 1) {
      cells.push({ col, row });
    }
  }
  return cells;
}

function widen(cells: readonly GridPosition[], radius: number): Set<number> {
  const result = new Set<number>();
  for (const { col, row } of cells) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) result.add(index({ col: col + dx, row: row + dy }));
    }
  }
  return result;
}

function paintPlain(grid: string[][], biomes: BiomeId[][], shape: ZoneShape, slot: DepthSlot): void {
  // A small ridge fragment remains, leaving most of the plain as workable dirt.
  const rubble = new Set([
    index({ col: shape.center.col - 4, row: shape.center.row + 1 }),
    index({ col: shape.center.col - 3, row: shape.center.row + 1 }),
    index({ col: shape.center.col - 4, row: shape.center.row + 2 }),
  ]);
  for (const cell of zoneCells(shape, slot.firstRow, slot.lastRow)) {
    const { col, row } = cell;
    biomes[row][col] = "plain";
    if (col === GENERATED_SPAWN.col && row >= 63) continue;
    if (rubble.has(index(cell))) grid[row][col] = "#";
    else if (grid[row][col] === "#") grid[row][col] = "+";
  }
}

function paintHighland(grid: string[][], biomes: BiomeId[][], shape: ZoneShape, slot: DepthSlot, lean: number): void {
  for (const { col, row } of zoneCells(shape, slot.firstRow, slot.lastRow)) {
    biomes[row][col] = "highland";
    if (col === GENERATED_SPAWN.col && row >= 63) continue;
    const dx = col - shape.center.col;
    const dy = row - shape.center.row;
    const ridgeRow = Math.round(dx * lean / 4);
    const mainRidge = Math.abs(dx) <= shape.radiusCol - 3 && Math.abs(dy - ridgeRow) <= 1;
    const spur = dx >= 0 && dx <= shape.radiusCol - 4 && Math.abs(dy - 4 + ridgeRow) <= 1;
    if (mainRidge || spur) grid[row][col] = "#";
  }
}

function paintLake(grid: string[][], biomes: BiomeId[][], shape: ZoneShape, bounds: DepthSlot): ReadonlySet<number> {
  const waterCells = zoneCells(shape, bounds.firstRow, bounds.lastRow);
  const water = new Set(waterCells.map(index));
  const shore = widen(waterCells, 1);
  for (const id of water) shore.delete(id);

  // A continuous dry shore is open at the start. One diggable row separates
  // it from other pockets, keeping the approach available without a large clearing.
  for (const id of widen(waterCells, 2)) {
    const { col, row } = position(id);
    biomes[row][col] = "lake";
    grid[row][col] = water.has(id) ? "~" : shore.has(id) ? "." : "+";
  }
  return shore;
}

function flood(layout: readonly string[], start: GridPosition, accepts: (marker: string) => boolean): Set<number> {
  const reached = new Set([index(start)]);
  const queue = [start];
  for (const cell of queue) {
    for (const delta of NEIGHBORS) {
      const next = { col: cell.col + delta.col, row: cell.row + delta.row };
      const marker = layout[next.row]?.[next.col];
      if (!marker || !accepts(marker) || reached.has(index(next))) continue;
      reached.add(index(next));
      queue.push(next);
    }
  }
  return reached;
}

function isOpen(marker: string): boolean {
  return marker === "." || marker === "S" || marker === "G";
}

function isValid(layout: readonly string[], shore: ReadonlySet<number>): boolean {
  const potential = flood(layout, GENERATED_GOAL, (marker) => marker !== "#" && marker !== "~");
  if (!potential.has(index(GENERATED_SPAWN)) || !potential.has(index(GENERATED_ENEMY_ENTRY))) return false;
  if ([...shore].some((id) => !potential.has(id))) return false;
  const shoreCell = shore.values().next().value;
  if (shoreCell === undefined || flood(layout, position(shoreCell), isOpen).size !== shore.size) return false;

  const home = flood(layout, GENERATED_SPAWN, isOpen);
  if (home.has(index(GENERATED_GOAL)) || home.has(index(GENERATED_ENEMY_ENTRY))) return false;
  for (let row = 0; row <= ROWS - 5; row += 1) {
    for (let col = 0; col <= COLUMNS - 5; col += 1) {
      if (!isOpen(layout[row][col]) || home.has(index({ col, row }))) continue;
      if (layout.slice(row, row + 5).every((line) => !/[+2#~]/.test(line.slice(col, col + 5)))) return false;
    }
  }
  return true;
}

export function generateExpeditionBiomes(layout: readonly string[], seed: number): BiomeLayout {
  if (layout.length !== ROWS || layout.some((line) => line.length !== COLUMNS || /[^#+2.SG]/.test(line))
    || layout[GENERATED_SPAWN.row][GENERATED_SPAWN.col] !== "S"
    || layout[GENERATED_GOAL.row][GENERATED_GOAL.col] !== "G"
    || !isOpen(layout[GENERATED_ENEMY_ENTRY.row][GENERATED_ENEMY_ENTRY.col])) {
    throw new RangeError("Biome generation requires the 40×96 expedition layout and its entry points");
  }
  // Derive the depth order separately from the local contour draws.
  const orderState = Math.imul(seed ^ 0x1c69_b3f7, 0x9e37_79b1) >>> 0;
  const order = ORDERS[Math.floor(orderState / 0x1_0000_0000 * ORDERS.length)];
  const plainSlot = order.indexOf("plain");
  const highlandSlot = order.indexOf("highland");
  const lakeSlot = order.indexOf("lake");
  const choose = seedChoices(seed ^ 0x68bc_21eb);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const grid = layout.map((line) => Array.from(line));
    const biomes = layout.map(() => Array<BiomeId>(COLUMNS).fill("ordinary"));

    paintPlain(grid, biomes, {
      center: { col: 13 + choose(15), row: [27, 49, 70][plainSlot] + choose(3) },
      radiusCol: 8 + choose(4), radiusRow: 8 + choose(2), bend: choose(5) - 2,
    }, SLOTS[plainSlot]);
    paintHighland(grid, biomes, {
      center: { col: 13 + choose(15), row: [28, 48, 67][highlandSlot] + choose(5) },
      radiusCol: 9 + choose(4), radiusRow: 8 + choose(3), bend: choose(5) - 2,
    }, SLOTS[highlandSlot], choose(2) === 0 ? 1 : -1);
    const lakeCol = 13 + choose(16);
    const lakeRow = [20, 49, 71][lakeSlot] + choose(4);
    const lakeRadiusCol = 5 + choose(4);
    const lakeRadiusRow = 4 + choose(2);
    const lakeBend = choose(5) - 2;
    const isSouthernLake = lakeSlot === 2;
    const shore = paintLake(grid, biomes, {
      center: { col: isSouthernLake ? (lakeCol < 21 ? 10 : 29) : lakeCol, row: lakeRow },
      radiusCol: isSouthernLake ? 5 : lakeRadiusCol,
      radiusRow: lakeRadiusRow,
      bend: isSouthernLake ? Math.sign(lakeBend) : lakeBend,
    }, LAKE_BOUNDS[lakeSlot]);
    const result = grid.map((line) => line.join(""));
    if (isValid(result, shore)) return { layout: result, biomes };
  }
  throw new Error("Biome generation could not produce a traversable expedition");
}

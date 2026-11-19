import type { GridPosition } from "./terrain.ts";

const COLUMNS = 40;
const ROWS_PER_REGION = 32;
const ROWS = ROWS_PER_REGION * 3;
export const DEFAULT_MAP_SEED = 20261120;
export const GENERATED_SPAWN = { col: 19, row: 92 } as const;
export const GENERATED_GOAL = { col: 19, row: 4 } as const;
export const GENERATED_ENEMY_ENTRY = { col: 30, row: 94 } as const;

type Marker = "#" | "+" | "." | "S" | "G";
type Anchor = readonly [col: number, row: number];
type Shape = readonly string[];
type RandomIndex = (limit: number) => number;

interface RegionTemplate {
  readonly pockets: readonly Anchor[];
  readonly clusters: readonly Anchor[];
  readonly ridges: readonly Anchor[];
  readonly stones: readonly Anchor[];
}

// Local row coordinates. Seed jitter changes the edges of these authored layouts.
const REGIONS: readonly RegionTemplate[] = [
  {
    // Northern pockets are sparser around the fixed objective.
    pockets: [[6, 6], [31, 7], [19, 10], [7, 14], [29, 17], [18, 21], [7, 24], [30, 26], [20, 28]],
    clusters: [[7, 10], [30, 12], [12, 26], [28, 22]],
    ridges: [[24, 7], [13, 16], [33, 21]],
    stones: [[4, 3], [13, 9], [23, 13], [35, 15], [6, 18], [16, 26], [25, 29], [36, 28]],
  },
  {
    // Longer ridges in the middle leave gaps and several independent passages.
    pockets: [[7, 4], [29, 4], [19, 8], [6, 13], [33, 13], [19, 18], [7, 21], [28, 23], [17, 27]],
    clusters: [[7, 9], [32, 9], [12, 17], [28, 18], [6, 27], [32, 27]],
    ridges: [[25, 8], [14, 11], [27, 13], [8, 17], [18, 23], [24, 27]],
    stones: [[12, 3], [21, 3], [35, 4], [6, 7], [18, 13], [24, 16], [35, 19], [11, 24], [26, 30]],
  },
  {
    // More opening space toward the southern room, with rock above the safe area.
    pockets: [[7, 3], [30, 4], [19, 7], [6, 12], [32, 12], [19, 14], [11, 17], [27, 17]],
    clusters: [[9, 8], [30, 8], [7, 16]],
    ridges: [[25, 5], [12, 11], [33, 17]],
    stones: [[14, 3], [22, 4], [5, 7], [35, 7], [14, 15], [23, 12], [36, 14], [16, 17]],
  },
];

const POCKETS: readonly Shape[] = [
  ["..####..", ".#######", "######..", "..###..."],
  ["#####..", ".######", "..#####"],
  ["###.....", "########", ".#######", "....###."],
  [".##.", "####", "###.", "..##", ".###", ".##."],
];
const CLUSTERS: readonly Shape[] = [
  ["..##..", ".####.", "######", "#####.", ".###..", "..#..."],
  [".####..", "######.", "#######", ".#####.", "..###.."],
  ["..###.", ".#####", "#####.", "####..", "..##.."],
];
const RIDGES: readonly Shape[] = [
  ["###....", "..####.", ".....##"],
  ["##.....", ".###...", "...###.", ".....##"],
  ["##..", ".##.", "..##", "..##", "...#"],
];
const STONES: readonly Shape[] = [
  ["#"], ["##"], ["##", ".#"],
];

const OFFSETS: readonly Anchor[] = [
  [0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, 2], [2, -2], [-2, -2],
];
const ADJACENT: readonly Anchor[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

function randomIndex(seed: number): RandomIndex {
  let state = seed >>> 0;
  return (limit) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor(state / 0x1_0000_0000 * limit);
  };
}

function paintRow(grid: Marker[][], row: number, first: number, last: number, marker: Marker): void {
  for (let col = first; col <= last; col += 1) grid[row][col] = marker;
}

function paintLandmarks(grid: Marker[][], choose: RandomIndex): void {
  for (let row = 84; row <= 91; row += 1) paintRow(grid, row, 15, 22, ".");
  paintRow(grid, 92, 17, 21, ".");
  paintRow(grid, 85, 14, 14, ".");
  paintRow(grid, 86, 13 + choose(2), 14, ".");
  paintRow(grid, 89, 23, 23, ".");
  paintRow(grid, 90, 23, 24 + choose(2), ".");
  paintRow(grid, 91, 23, 23, ".");
  grid[GENERATED_SPAWN.row][GENERATED_SPAWN.col] = "S";

  // Side hollows and the enemy pocket are separated from the home by intact dirt.
  const left = 5 + choose(3);
  paintRow(grid, 86, left, left + 2, ".");
  paintRow(grid, 87, left, left + 3, ".");
  paintRow(grid, 88, left + 1, left + 3, ".");
  const right = 28 + choose(2);
  paintRow(grid, 85, right, right + 2, ".");
  paintRow(grid, 86, right - 1, right + 2, ".");
  paintRow(grid, 87, right, right + 1, ".");
  paintRow(grid, 92, 30, 31, ".");
  paintRow(grid, 93, 29, 31, ".");
  paintRow(grid, 94, 29, 31, ".");

  paintRow(grid, 2, 17, 21, "G");
  paintRow(grid, 3, 16, 22, "G");
  paintRow(grid, 4, 17, 22, "G");
}

function shapeCells(shape: Shape, flip: boolean): Anchor[] {
  const width = shape[0].length;
  const centerCol = Math.floor(width / 2);
  const centerRow = Math.floor(shape.length / 2);
  const points: Anchor[] = [];
  for (let row = 0; row < shape.length; row += 1) {
    for (let col = 0; col < shape[row].length; col += 1) {
      if (shape[row][col] !== "#") continue;
      const x = flip ? width - col - 1 : col;
      points.push([x - centerCol, row - centerRow]);
    }
  }
  return points;
}

function stampNear(
  grid: Marker[][], chunk: number, anchor: Anchor, shapes: readonly Shape[], marker: "." | "#", choose: RandomIndex,
): void {
  const start = chunk * ROWS_PER_REGION;
  const end = Math.min(start + ROWS_PER_REGION - 1, 83);
  const offsets = shapeCells(shapes[choose(shapes.length)], choose(2) === 0);
  const offsetCol = choose(5) - 2;
  const offsetRow = choose(3) - 1;
  const placements = [[offsetCol, offsetRow] as const, ...OFFSETS];

  for (const [dc, dr] of placements) {
    const cells = offsets.map(([col, row]) => [anchor[0] + dc + col, start + anchor[1] + dr + row] as const);
    const fits = cells.every(([col, row]) => {
      if (col < 2 || col >= COLUMNS - 2 || row <= start || row >= end || grid[row][col] !== "+") return false;
      if (marker === "#" && col === GENERATED_SPAWN.col) return false;
      const adjacent = [grid[row - 1][col], grid[row + 1][col], grid[row][col - 1], grid[row][col + 1]];
      return marker === "#"
        ? adjacent.every((cell) => cell !== "#")
        : adjacent.every((cell) => cell === "+" || cell === "#");
    });
    if (!fits) continue;
    for (const [col, row] of cells) grid[row][col] = marker;
    return;
  }
}

function buildGrid(seed: number): Marker[][] {
  const choose = randomIndex(seed);
  const grid: Marker[][] = Array.from({ length: ROWS }, (_, row) => Array.from(
    { length: COLUMNS },
    (_, col) => row === 0 || row === ROWS - 1 || col === 0 || col === COLUMNS - 1 ? "#" : "+",
  ));
  paintLandmarks(grid, choose);
  for (const [chunk, template] of REGIONS.entries()) {
    for (const anchor of template.pockets) stampNear(grid, chunk, anchor, POCKETS, ".", choose);
    for (const anchor of template.clusters) stampNear(grid, chunk, anchor, CLUSTERS, "#", choose);
    for (const anchor of template.ridges) stampNear(grid, chunk, anchor, RIDGES, "#", choose);
    for (const anchor of template.stones) stampNear(grid, chunk, anchor, STONES, "#", choose);
  }
  return grid;
}

function cellIndex({ col, row }: GridPosition): number {
  return row * COLUMNS + col;
}

function connected(grid: Marker[][], origin: GridPosition, canEnter: (cell: Marker) => boolean): Set<number> {
  const seen = new Set<number>();
  if (!canEnter(grid[origin.row][origin.col])) return seen;
  const pending = [origin];
  seen.add(cellIndex(origin));
  for (const { col, row } of pending) {
    for (const [dc, dr] of ADJACENT) {
      const next = { col: col + dc, row: row + dr };
      const marker = grid[next.row]?.[next.col];
      if (!marker || !canEnter(marker)) continue;
      const index = cellIndex(next);
      if (seen.has(index)) continue;
      seen.add(index);
      pending.push(next);
    }
  }
  return seen;
}

function isOpen(cell: Marker): boolean {
  return cell === "." || cell === "S" || cell === "G";
}

function isValid(grid: Marker[][]): boolean {
  const home = connected(grid, GENERATED_SPAWN, isOpen);
  const goal = cellIndex(GENERATED_GOAL);
  const entry = cellIndex(GENERATED_ENEMY_ENTRY);
  if (home.has(goal) || home.has(entry) || !isOpen(grid[GENERATED_ENEMY_ENTRY.row][GENERATED_ENEMY_ENTRY.col])) return false;
  const carveable = connected(grid, GENERATED_GOAL, (cell) => cell !== "#");
  if (!carveable.has(cellIndex(GENERATED_SPAWN)) || !carveable.has(entry)) return false;

  for (let row = 0; row <= ROWS - 5; row += 1) {
    for (let col = 0; col <= COLUMNS - 5; col += 1) {
      // A wholly open window that touches home is part of the same open component.
      if (!isOpen(grid[row][col]) || home.has(cellIndex({ col, row }))) continue;
      if (grid.slice(row, row + 5).every((line) => line.slice(col, col + 5).every(isOpen))) return false;
    }
  }
  return true;
}

export function generateExpeditionMap(seed = DEFAULT_MAP_SEED): readonly string[] {
  const selected = Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff ? seed : DEFAULT_MAP_SEED;
  const grid = buildGrid(selected);
  if (isValid(grid)) return grid.map((row) => row.join(""));
  if (selected !== DEFAULT_MAP_SEED) return generateExpeditionMap(DEFAULT_MAP_SEED);
  throw new Error("Expedition map templates could not produce a valid fallback layout");
}

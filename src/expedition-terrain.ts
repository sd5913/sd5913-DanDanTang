import { GENERATED_ENEMY_ENTRY, GENERATED_SPAWN } from "./generated-map.ts";
import type { GridPosition } from "./terrain.ts";

export const PLAY_GENERATOR_VERSION = 4;
export const EXPEDITION_STRATA = Object.freeze({
  bodyNorthRow: 0,
  bodySouthRow: 60,
  transitionNorthRow: 61,
  transitionSouthRow: 65,
  referenceGate: Object.freeze({ col: GENERATED_SPAWN.col, row: 63 }),
});

const COLUMNS = 40;
const ROWS = 96;
const FIELD_SPACING = 6;
const TRANSITION_WEIGHTS = [0.70, 0.57, 0.43, 0.29, 0.13] as const;

function coordinateHash(seed: number, col: number, row: number): number {
  let value = seed ^ Math.imul(col + 1, 0x9e37_79b1) ^ Math.imul(row + 1, 0x85eb_ca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d);
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function geologyField(seed: number, col: number, row: number): number {
  const x = Math.floor(col / FIELD_SPACING);
  const y = Math.floor(row / FIELD_SPACING);
  const u = col / FIELD_SPACING - x;
  const v = row / FIELD_SPACING - y;
  const north = coordinateHash(seed, x, y) * (1 - u) + coordinateHash(seed, x + 1, y) * u;
  const south = coordinateHash(seed, x, y + 1) * (1 - u) + coordinateHash(seed, x + 1, y + 1) * u;
  return (north * (1 - v) + south * v) / 0x1_0000_0000;
}

function findTierCut(layout: readonly string[], seed: number): number[] {
  const { transitionNorthRow, transitionSouthRow, referenceGate } = EXPEDITION_STRATA;
  const depth = transitionSouthRow - transitionNorthRow + 1;
  const bendRow = referenceGate.row + 1;
  const bendCells = Array.from({ length: COLUMNS - 2 }, (_, offset) => offset + 1)
    .filter((col) => col !== referenceGate.col && layout[bendRow][col] === "+");
  if (layout[referenceGate.row][referenceGate.col] !== "+" || bendCells.length === 0) {
    throw new Error("Expedition strata cannot anchor a staggered tool gate in the transition");
  }
  const bendCol = bendCells[coordinateHash(seed, bendRow, referenceGate.col) % bendCells.length];
  const predecessors = Array.from({ length: COLUMNS }, () => Array<number>(depth).fill(-1));
  let previous = Array<number>(depth).fill(0);

  // A continuous closed cut with adjacent heights differing by at most one
  // blocks every cardinal route while allowing the visible tier distribution to vary.
  for (let col = 0; col < COLUMNS; col += 1) {
    const current = Array<number>(depth).fill(Infinity);
    const preferred = transitionNorthRow + (depth - 1) * geologyField(seed ^ 0x3f89_42c1, col, 0);
    for (let local = 0; local < depth; local += 1) {
      const row = transitionNorthRow + local;
      if (!["+", "#", "~"].includes(layout[row][col])) continue;
      if (col === referenceGate.col && row !== referenceGate.row) continue;
      if (col === bendCol && row !== bendRow) continue;
      for (let prior = Math.max(0, local - 1); prior <= Math.min(depth - 1, local + 1); prior += 1) {
        const cost = previous[prior] + Math.abs(row - preferred);
        if (cost >= current[local]) continue;
        current[local] = cost;
        predecessors[col][local] = prior;
      }
    }
    previous = current;
  }

  const cost = Math.min(...previous);
  if (!Number.isFinite(cost)) throw new Error("Expedition strata could not connect the staggered tool gate");
  const cutRows = Array<number>(COLUMNS);
  let local = previous.indexOf(cost);
  for (let col = COLUMNS - 1; col >= 0; col -= 1) {
    cutRows[col] = transitionNorthRow + local;
    local = predecessors[col][local];
  }
  return cutRows;
}

function buildReachability(tiles: string, starts: readonly number[], hasAdvancedTool: boolean): Uint8Array {
  const seen = new Uint8Array(COLUMNS * ROWS);
  const queue = [...starts];
  for (const start of starts) seen[start] = 1;

  function visit(next: number): void {
    if (seen[next]) return;
    const marker = tiles[next];
    if (marker === "#" || marker === "~" || (marker === "2" && !hasAdvancedTool)) return;
    seen[next] = 1;
    queue.push(next);
  }

  for (const id of queue) {
    const col = id % COLUMNS;
    if (id >= COLUMNS) visit(id - COLUMNS);
    if (col < COLUMNS - 1) visit(id + 1);
    if (id < tiles.length - COLUMNS) visit(id + COLUMNS);
    if (col > 0) visit(id - 1);
  }
  return seen;
}

function validateToolRoutes(layout: readonly string[]): void {
  const tiles = layout.join("");
  const goalIds = Array.from(tiles.matchAll(/G/g), (goal) => goal.index);
  if (goalIds.length === 0) throw new Error("Expedition strata require a northern goal");
  // Flood from all goals for Lv1 to catch even a single unguarded goal edge.
  const basic = buildReachability(tiles, goalIds, false);
  const upgraded = buildReachability(tiles, [goalIds[0]], true);
  const sources = [GENERATED_SPAWN, GENERATED_ENEMY_ENTRY].map(({ col, row }) => row * COLUMNS + col);
  if (sources.some((id) => basic[id] || !upgraded[id]) || goalIds.some((id) => !upgraded[id])) {
    throw new Error("Expedition strata failed the level 1 and level 2 goal reachability checks");
  }
}

export function addExpeditionTiers(layout: readonly string[], effectiveSeed: number): readonly string[] {
  if (!Number.isInteger(effectiveSeed) || effectiveSeed < 0 || effectiveSeed > 0xffff_ffff) {
    throw new RangeError("Expedition strata require an effective unsigned 32-bit seed");
  }
  if (layout.length !== ROWS || layout.some((line) => line.length !== COLUMNS || /[^+#~.SG]/.test(line))
    || layout[GENERATED_SPAWN.row][GENERATED_SPAWN.col] !== "S"
    || layout[GENERATED_ENEMY_ENTRY.row][GENERATED_ENEMY_ENTRY.col] !== ".") {
    throw new RangeError("Expedition strata require an ungraded 40×96 layout with intact entrances");
  }
  const { bodyNorthRow, bodySouthRow, transitionNorthRow, transitionSouthRow, referenceGate } = EXPEDITION_STRATA;
  const grid = layout.map((line) => Array.from(line));
  const cutRows = findTierCut(layout, effectiveSeed);
  const body = [];
  for (let row = bodyNorthRow; row <= bodySouthRow; row += 1) {
    for (let col = 0; col < COLUMNS; col += 1) {
      if (grid[row][col] === "+") body.push({ col, row, value: geologyField(effectiveSeed, col, row) });
    }
  }
  // Select coherent high patches by rank, so voids, rocks, and lakes never skew the ratio.
  const percent = 76 + coordinateHash(effectiveSeed ^ 0x33a1_5407, 0, 0) % 5;
  body.sort((a, b) => b.value - a.value || a.row - b.row || a.col - b.col);
  const hardCount = Math.round(body.length * percent / 100);
  if (hardCount === 0 || hardCount >= body.length) throw new Error("Expedition strata have insufficient diggable area");
  for (let i = 0; i < hardCount; i += 1) {
    const { col, row } = body[i];
    grid[row][col] = "2";
  }

  for (let row = transitionNorthRow; row <= transitionSouthRow; row += 1) {
    let soft = 0;
    let hard = 0;
    let weakest = { col: -1, value: Infinity };
    const weight = TRANSITION_WEIGHTS[row - transitionNorthRow];
    for (let col = 0; col < COLUMNS; col += 1) {
      if (grid[row][col] !== "+") continue;
      if (col === referenceGate.col && row > referenceGate.row) {
        soft += 1;
        continue;
      }
      const value = geologyField(effectiveSeed, col, row);
      const isCut = row === cutRows[col];
      if (isCut || value > 1 - weight) {
        grid[row][col] = "2";
        hard += 1;
        if (!isCut && value < weakest.value) weakest = { col, value };
      } else {
        soft += 1;
      }
    }
    // Soften a fully hardened row without weakening any part of the jagged cut.
    if (soft === 0 && hard > 1 && weakest.col >= 0) grid[row][weakest.col] = "+";
  }

  const result = grid.map((line) => line.join(""));
  validateToolRoutes(result);
  return result;
}

export function addExpeditionApproach(layout: readonly string[]): readonly string[] {
  const { col: entryCol, row: entryRow } = GENERATED_ENEMY_ENTRY;
  const bend = 21;
  return layout.map((line, row) => {
    if (row === entryRow - 1) return line.slice(0, bend) + "." + line.slice(bend + 1);
    if (row === entryRow) return line.slice(0, bend) + ".".repeat(entryCol - bend + 1) + line.slice(entryCol + 1);
    return line;
  });
}

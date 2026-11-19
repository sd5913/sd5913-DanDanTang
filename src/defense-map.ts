import { DENSE_LONG_MAP_LAYOUT } from "./dense-long-map.ts";

export const ENEMY_ENTRY = { col: 11, row: 94 } as const;
export const DEFENSE_TARGET = { col: 11, row: 4 } as const;

// Narrow these rest pockets to offset pre-excavating the validation corridor.
const NARROWED_RESTS = new Map<number, readonly [number, number]>([
  [28, [10, 12]], [29, [10, 11]], [30, [11, 11]],
  [58, [10, 12]], [59, [10, 13]], [60, [10, 13]], [61, [10, 13]], [62, [10, 12]],
  [64, [10, 12]], [65, [10, 13]], [66, [9, 13]], [67, [9, 14]],
  [68, [9, 13]], [69, [10, 13]], [70, [10, 12]],
]);

export const DEFENSE_LAYOUT = DENSE_LONG_MAP_LAYOUT.map((line, row) => {
  const cells = Array.from(line);
  const rest = NARROWED_RESTS.get(row);
  if (rest) {
    const [firstCol, lastCol] = rest;
    for (let col = 0; col < cells.length; col += 1) {
      if ((col < firstCol || col > lastCol) && cells[col] === ".") cells[col] = "+";
    }
  }

  // The entrance at (11, 89) stays sealed. At row 87, (12, 87) is the diggable bypass.
  if (row !== 89 && cells[11] === "+") cells[11] = ".";
  if (row === 88 || row === 90) {
    cells[10] = ".";
    cells[12] = ".";
  }

  return cells.join("");
});

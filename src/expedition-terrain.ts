import { GENERATED_ENEMY_ENTRY } from "./generated-map.ts";

export const PLAY_GENERATOR_VERSION = 3;
export const ADVANCED_TERRAIN_ROWS = [31, 63] as const;

export function addExpeditionTiers(layout: readonly string[]): readonly string[] {
  return layout.map((line, row) => row === ADVANCED_TERRAIN_ROWS[0] || row === ADVANCED_TERRAIN_ROWS[1]
    ? line.replace(/[+.]/g, "2")
    : line);
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

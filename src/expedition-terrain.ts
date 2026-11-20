export const ADVANCED_TERRAIN_ROWS = [31, 63] as const;

export function addExpeditionTiers(layout: readonly string[]): readonly string[] {
  return layout.map((line, row) => row === ADVANCED_TERRAIN_ROWS[0] || row === ADVANCED_TERRAIN_ROWS[1]
    ? line.replace(/[+.]/g, "2")
    : line);
}

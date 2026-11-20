import type { BiomeId } from "./expedition-biomes.ts";

export const BIOME_NAMES: Record<BiomeId, string> = {
  ordinary: "普通地貌", plain: "平原", highland: "高山", lake: "湖泊",
};

export const BIOME_PROTOTYPE = {
  plainProductionMs: 3_000,
  highlandProductionMs: 5_000,
  highlandTowerRangeBonus: 2,
  towerVision: 3,
  highlandTowerVisionBonus: 2,
} as const;

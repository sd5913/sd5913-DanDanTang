export const TERRAIN_HP_BY_LEVEL = { 1: 5, 2: 8 } as const;

export const MINING_CONFIG = {
  dirtMaxHp: TERRAIN_HP_BY_LEVEL[1],
  damage: 1,
  attackIntervalMs: 125,
} as const;

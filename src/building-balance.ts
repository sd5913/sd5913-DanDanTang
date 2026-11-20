import type { BuildingKind, TowerEvolution } from "./buildings.ts";
import { BIOME_PROTOTYPE } from "./biome-effects.ts";
import type { BiomeId } from "./expedition-biomes.ts";

export const BUILDING_BALANCE_PROFILES = {
  control: { label: "Control", wallHp: 50, growth: false },
  w35: { label: "W35", wallHp: 35, growth: true },
  w25: { label: "W25", wallHp: 25, growth: true },
  w15: { label: "W15", wallHp: 15, growth: true },
} as const;

export type BuildingBalanceId = keyof typeof BUILDING_BALANCE_PROFILES;
export const DEFAULT_CHALLENGE_BUILDING_BALANCE: BuildingBalanceId = "w25";

export const CONTROL_BUILDING_HP = Object.freeze({
  wall: BUILDING_BALANCE_PROFILES.control.wallHp, tower: 1, economy: 1, technology: 1,
});

export const TOWER_LEVEL_ONE = Object.freeze({ damage: 2, range: 5, intervalMs: 350 });
const TOWER_LEVEL_TWO = Object.freeze({ damage: 5, range: 6, intervalMs: 300 });
const PIERCING_LEVEL_TWO = Object.freeze({ damage: 5, baseRange: 7, intervalMs: 900, maxTargets: 4 });
const BURST_LEVEL_TWO = Object.freeze({ damage: 4, baseRange: 4, intervalMs: 650, splashDamage: 2, radius: 1.25 });

interface EvolvedTowerRange {
  readonly damage: number;
  readonly baseRange: number;
  readonly range: number;
  readonly intervalMs: number;
}

export type PiercingTowerAttributes = EvolvedTowerRange & Extract<TowerEvolution, { kind: "piercing" }> & {
  readonly maxTargets: number;
};
export type BurstTowerAttributes = EvolvedTowerRange & Extract<TowerEvolution, { kind: "burst" }> & {
  readonly splashDamage: number;
  readonly radius: number;
};
export type EvolvedTowerAttributes = PiercingTowerAttributes | BurstTowerAttributes;

export const PRODUCTION_LEVEL_ONE = Object.freeze({ amount: 1, intervalMs: 4_000 });
const PRODUCTION_LEVEL_TWO_AMOUNT = 2;
const WALL_LEVEL_TWO_MULTIPLIER = 2;

export function readBuildingBalance(value: string | null): BuildingBalanceId {
  const id = value?.toLowerCase();
  return id && Object.hasOwn(BUILDING_BALANCE_PROFILES, id)
    ? id as BuildingBalanceId : DEFAULT_CHALLENGE_BUILDING_BALANCE;
}

export function wallHpMultiplier(balance: BuildingBalanceId, level: 1 | 2): number {
  return level === 2 && BUILDING_BALANCE_PROFILES[balance].growth ? WALL_LEVEL_TWO_MULTIPLIER : 1;
}

export function buildingMaxHp(kind: BuildingKind, balance: BuildingBalanceId, level: 1 | 2 = 1): number {
  return kind === "wall"
    ? BUILDING_BALANCE_PROFILES[balance].wallHp * wallHpMultiplier(balance, level)
    : CONTROL_BUILDING_HP[kind];
}

export function towerAttributes(balance: BuildingBalanceId, level: 1 | 2, biome?: BiomeId) {
  const base = level === 2 && BUILDING_BALANCE_PROFILES[balance].growth ? TOWER_LEVEL_TWO : TOWER_LEVEL_ONE;
  if (biome !== "highland") return base;
  return { ...base, range: base.range + BIOME_PROTOTYPE.highlandTowerRangeBonus };
}

export function evolvedTowerAttributes(evolution: Extract<TowerEvolution, { kind: "piercing" }>, biome?: BiomeId): PiercingTowerAttributes;
export function evolvedTowerAttributes(evolution: Extract<TowerEvolution, { kind: "burst" }>, biome?: BiomeId): BurstTowerAttributes;
export function evolvedTowerAttributes(evolution: TowerEvolution, biome?: BiomeId): EvolvedTowerAttributes;
export function evolvedTowerAttributes(evolution: TowerEvolution, biome?: BiomeId): EvolvedTowerAttributes {
  const rangeBonus = biome === "highland" ? BIOME_PROTOTYPE.highlandTowerRangeBonus : 0;
  if (evolution.kind === "piercing") {
    return { ...evolution, ...PIERCING_LEVEL_TWO, range: PIERCING_LEVEL_TWO.baseRange + rangeBonus };
  }
  return { ...evolution, ...BURST_LEVEL_TWO, range: BURST_LEVEL_TWO.baseRange + rangeBonus };
}

export function productionAttributes(balance: BuildingBalanceId, level: 1 | 2, biome?: BiomeId) {
  const amount = level === 2 && BUILDING_BALANCE_PROFILES[balance].growth
    ? PRODUCTION_LEVEL_TWO_AMOUNT : PRODUCTION_LEVEL_ONE.amount;
  const intervalMs = biome === "plain" ? BIOME_PROTOTYPE.plainProductionMs
    : biome === "highland" ? BIOME_PROTOTYPE.highlandProductionMs : PRODUCTION_LEVEL_ONE.intervalMs;
  return { amount, intervalMs };
}

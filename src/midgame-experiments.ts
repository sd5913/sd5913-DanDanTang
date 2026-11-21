import { DEFENSE_CONFIG } from "./defense-simulation.ts";
import type { WaveDeployment } from "./defense-simulation.ts";
import type { ExpeditionStage } from "./expedition-difficulty.ts";
import type { EconomyExperiment } from "./expedition-economy.ts";
import type { EvacuationBatch } from "./evacuation.ts";

const DENSE_INTERVAL_MS = { opening: 200, middle: 150, late: 100 } as const;
const LATE_BURST = Object.freeze({ count: 8, pauseMs: 400 });
const ARMOR_SALT = 0xa012_5f53;
const EVACUATION_ARMOR_SALT = 0x45dc_f13d;
export const ARMORED_ENEMY_HP = 14;
type ArmoredPercent = 15 | 25 | 40;
const ECONOMY_CONSTRAINTS = { tieredCraft: true, killDecay: true } as const;

interface MidgameExperiment {
  readonly label: string;
  readonly density?: "dense" | "burst";
  readonly armoredPercent?: ArmoredPercent;
  readonly economy?: EconomyExperiment;
}

const profiles = {
  control: { label: "Control · 原规则" },
  dense: { label: "Combat-Dense · 加密出兵", density: "dense" },
  "dense-burst": { label: "Combat-Dense · 分批出兵", density: "burst" },
  armored: { label: "Combat-Armored · 重装 25%", armoredPercent: 25 },
  tier: { label: "Economy-Tier · 阶梯制卡", economy: { tieredCraft: true } },
  "kill-decay": { label: "Economy-Kill-Decay · 击杀收入递减", economy: { killDecay: true } },
  "economy-combined": { label: "Economy-Combined · 两种经济规则", economy: ECONOMY_CONSTRAINTS },
  "combat-combined": { label: "Combat-Combined · 密集与重装", density: "dense", armoredPercent: 25 },
  combined: { label: "Combined · 战斗与经济", density: "dense", armoredPercent: 25, economy: ECONOMY_CONSTRAINTS },
} as const satisfies Record<string, MidgameExperiment>;

export type MidgameExperimentId = keyof typeof profiles;
export const MIDGAME_EXPERIMENTS: Readonly<Record<MidgameExperimentId, MidgameExperiment>> = profiles;

export function readMidgameExperiment(value: string | null): MidgameExperimentId {
  return value && Object.hasOwn(MIDGAME_EXPERIMENTS, value) ? value as MidgameExperimentId : "control";
}

interface WaveContext {
  readonly seed: number;
  readonly stage: ExpeditionStage;
  readonly count: number;
}

export function armoredSlots(seed: number, wave: number, count: number, percent: ArmoredPercent): readonly number[] {
  const armoredCount = Math.round(count * percent / 100);
  const slots = Array.from({ length: count }, (_, index) => index);
  // Use a separate stream so changing enemies does not advance map or card RNG.
  let state = (seed ^ ARMOR_SALT ^ Math.imul(wave, 0x9e37_79b9) ^ percent) >>> 0;
  for (let index = 0; index < armoredCount; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const next = index + Math.floor(state / 0x1_0000_0000 * (count - index));
    [slots[index], slots[next]] = [slots[next], slots[index]];
  }
  return slots.slice(0, armoredCount).sort((left, right) => left - right);
}

function denseInterval(wave: number): number {
  if (wave < 3) return DENSE_INTERVAL_MS.opening;
  if (wave < 6) return DENSE_INTERVAL_MS.middle;
  return DENSE_INTERVAL_MS.late;
}

export function waveDeployment(profile: MidgameExperimentId, wave: number, context?: WaveContext): WaveDeployment | undefined {
  const { density, armoredPercent } = MIDGAME_EXPERIMENTS[profile];
  const armor = context && context.stage > 0 && armoredPercent
    ? { hp: ARMORED_ENEMY_HP, slots: armoredSlots(context.seed, wave, context.count, armoredPercent) }
    : undefined;
  if (!density && !armor) return undefined;
  return {
    intervalMs: density ? denseInterval(wave) : DEFENSE_CONFIG.spawnIntervalMs,
    ...(density === "burst" && wave >= 6 ? { burst: LATE_BURST } : {}),
    ...(armor ? { armor } : {}),
  };
}

export function evacuationDeployment(profile: MidgameExperimentId, batch: EvacuationBatch,
  context: WaveContext): WaveDeployment | undefined {
  const lateWave = 5 + batch;
  return waveDeployment(profile, lateWave, { ...context, seed: (context.seed ^ EVACUATION_ARMOR_SALT) >>> 0 });
}

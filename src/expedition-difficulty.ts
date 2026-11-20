import type { CardKind } from "./expedition-economy.ts";

export type DifficultyId = "baseline" | "a" | "b" | "challenge";
export type ExpeditionStage = 0 | 1 | 2;

export interface EnemyStrength {
  readonly enemyHp: number;
  readonly wallDamage: number;
  readonly contactDamage: number;
}

interface WaveTiming {
  readonly preparingMs: number;
  readonly recoveringMs: number;
  readonly attackTimeoutMs: number;
  readonly pressureStepMs: number;
}

interface WaveSchedule {
  readonly initial: readonly number[];
  readonly growth: number;
  readonly cap: number;
}

export interface DifficultyEconomy {
  readonly initialBalance: number;
  readonly initialCards: Readonly<Record<CardKind, number>>;
  readonly miningIncomeTenthsPerHp: number;
  readonly guaranteedDefenseDraw: number;
}

interface DifficultyProfile {
  readonly label: string;
  readonly normal: WaveTiming;
  readonly fast: WaveTiming;
  readonly stages: readonly [EnemyStrength, EnemyStrength, EnemyStrength];
  readonly schedule?: WaveSchedule;
  readonly economy: DifficultyEconomy;
}

export const PROTOTYPE_ONLY = Object.freeze({
  playerHp: 4,
  baseWaveCount: 3,
  maxWaveCount: 32,
  normal: Object.freeze({ preparingMs: 120_000, recoveringMs: 60_000, attackTimeoutMs: 45_000, pressureStepMs: 45_000 }),
  fast: Object.freeze({ preparingMs: 2_500, recoveringMs: 2_500, attackTimeoutMs: 4_500, pressureStepMs: 8_000 }),
  profiles: Object.freeze([
    Object.freeze({ enemyHp: 2, wallDamage: 1, contactDamage: 1 }),
    Object.freeze({ enemyHp: 3, wallDamage: 2, contactDamage: 1 }),
    Object.freeze({ enemyHp: 4, wallDamage: 3, contactDamage: 2 }),
  ] as const),
});

const fasterNormal = Object.freeze({ preparingMs: 90_000, recoveringMs: 25_000, attackTimeoutMs: 60_000, pressureStepMs: 45_000 });
const fasterFast = Object.freeze({ ...fasterNormal, preparingMs: 2_500, recoveringMs: 2_500, pressureStepMs: 8_000 });
const fasterSchedule = Object.freeze({
  initial: Object.freeze([10, 16, 24, 34, 46, 60]), growth: 14, cap: 120,
});
const standardEconomy = Object.freeze({
  initialBalance: 8, initialCards: Object.freeze({ wall: 4, tower: 2, economy: 1 }),
  miningIncomeTenthsPerHp: 0, guaranteedDefenseDraw: 0,
});
const challengeEconomy = Object.freeze({
  initialBalance: 0, initialCards: Object.freeze({ wall: 0, tower: 0, economy: 0 }),
  miningIncomeTenthsPerHp: 1, guaranteedDefenseDraw: 3,
});
const challengeNormal = Object.freeze({ ...fasterNormal, preparingMs: 60_000, recoveringMs: 20_000 });
const challengeSchedule = Object.freeze({
  ...fasterSchedule, initial: Object.freeze([8, ...fasterSchedule.initial.slice(1)]),
});
const strongerStages = Object.freeze([
  Object.freeze({ ...PROTOTYPE_ONLY.profiles[0], enemyHp: 4 }),
  Object.freeze({ ...PROTOTYPE_ONLY.profiles[1], enemyHp: 7 }),
  // The northern combat phase is still tier-two terrain.
  Object.freeze({ ...PROTOTYPE_ONLY.profiles[2], enemyHp: 7 }),
] as const);

export const DIFFICULTY_PROFILES: Readonly<Record<DifficultyId, DifficultyProfile>> = Object.freeze({
  baseline: Object.freeze({
    label: "基线", normal: PROTOTYPE_ONLY.normal, fast: PROTOTYPE_ONLY.fast, stages: PROTOTYPE_ONLY.profiles,
    economy: standardEconomy,
  }),
  a: Object.freeze({
    label: "A · 加快波次", normal: fasterNormal, fast: fasterFast, stages: PROTOTYPE_ONLY.profiles, schedule: fasterSchedule,
    economy: standardEconomy,
  }),
  b: Object.freeze({
    label: "B · 加快波次与强化敌人", normal: fasterNormal, fast: fasterFast, stages: strongerStages, schedule: fasterSchedule,
    economy: standardEconomy,
  }),
  challenge: Object.freeze({
    label: "挑战模式：从零开始", normal: challengeNormal, fast: fasterFast, stages: strongerStages,
    schedule: challengeSchedule, economy: challengeEconomy,
  }),
});

export function readDifficulty(value: string | null): DifficultyId {
  return value && Object.hasOwn(DIFFICULTY_PROFILES, value) ? value as DifficultyId : "baseline";
}

export function wavePopulation(difficulty: DifficultyId, wave: number, pressure: number): number {
  const schedule = DIFFICULTY_PROFILES[difficulty].schedule;
  if (!schedule) return Math.min(PROTOTYPE_ONLY.maxWaveCount, PROTOTYPE_ONLY.baseWaveCount + pressure);
  const { initial, growth, cap } = schedule;
  return initial[wave - 1] ?? Math.min(cap, initial[initial.length - 1] + (wave - initial.length) * growth);
}

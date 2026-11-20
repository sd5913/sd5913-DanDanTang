export type ExpeditionPhase = "preparing" | "attacking" | "recovering" | "won" | "lost";
type ExpeditionStage = 0 | 1 | 2;

export interface WaveOrder {
  readonly count: number;
  readonly wallDamage: number;
  readonly enemyHp: number;
  readonly contactDamage: number;
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

type Timing = (typeof PROTOTYPE_ONLY)["normal" | "fast"];

export class ExpeditionRound {
  readonly #timing: Timing;
  #phase: ExpeditionPhase = "preparing";
  #wave = 0;
  #pressure = 0;
  #pressureElapsedMs = 0;
  #remainingMs = 0;
  #playerHp: number = PROTOTYPE_ONLY.playerHp;
  #stage: ExpeditionStage = 0;

  constructor(fast = false) {
    this.#timing = fast ? PROTOTYPE_ONLY.fast : PROTOTYPE_ONLY.normal;
    this.reset();
  }

  get phase(): ExpeditionPhase { return this.#phase; }
  get wave(): number { return this.#wave; }
  get pressure(): number { return this.#pressure; }
  get remainingMs(): number { return this.#remainingMs; }
  get playerHp(): number { return this.#playerHp; }
  get stage(): ExpeditionStage { return this.#stage; }

  update(deltaMs: number, playerRow: number, active: number, pending: number): WaveOrder | undefined {
    if (this.finished() || !Number.isFinite(deltaMs) || deltaMs <= 0) return undefined;
    this.advancePressure(deltaMs, playerRow);
    this.#remainingMs = Math.max(0, this.#remainingMs - deltaMs);

    if (this.#phase === "attacking") {
      if ((active === 0 && pending === 0) || this.#remainingMs === 0) {
        this.#phase = "recovering";
        this.#remainingMs = this.#timing.recoveringMs;
      }
      return undefined;
    }
    if (this.#remainingMs > 0) return undefined;

    // Issue at most one order per update. The simulation receives the order before its next tick.
    this.#phase = "attacking";
    this.#wave += 1;
    this.#remainingMs = this.#timing.attackTimeoutMs;
    return {
      count: Math.min(PROTOTYPE_ONLY.maxWaveCount, PROTOTYPE_ONLY.baseWaveCount + this.#pressure),
      ...PROTOTYPE_ONLY.profiles[this.#stage],
    };
  }

  hitPlayer(damage: number): void {
    if (this.finished() || !Number.isSafeInteger(damage) || damage <= 0) return;
    this.#playerHp = Math.max(0, this.#playerHp - damage);
    if (this.#playerHp === 0) this.finish("lost");
  }

  reachGoal(toolLevel: number): boolean {
    if (this.finished() || !Number.isSafeInteger(toolLevel) || toolLevel < 2) return false;
    this.finish("won");
    return true;
  }

  reset(): void {
    this.#phase = "preparing";
    this.#wave = 0;
    this.#pressure = 0;
    this.#pressureElapsedMs = 0;
    this.#remainingMs = this.#timing.preparingMs;
    this.#playerHp = PROTOTYPE_ONLY.playerHp;
    this.#stage = 0;
  }

  private advancePressure(deltaMs: number, playerRow: number): void {
    if (Number.isInteger(playerRow) && playerRow >= 0 && playerRow < 96) {
      const stage = playerRow < 32 ? 2 : playerRow < 64 ? 1 : 0;
      if (stage > this.#stage) {
        this.#stage = stage;
        this.#pressureElapsedMs = 0;
      }
    }
    const interval = this.#timing.pressureStepMs;
    const elapsed = this.#pressureElapsedMs + deltaMs;
    this.#pressure = Math.min(Number.MAX_SAFE_INTEGER, this.#pressure + Math.floor(elapsed / interval));
    this.#pressureElapsedMs = elapsed % interval;
  }

  private finished(): boolean {
    return this.#phase === "won" || this.#phase === "lost";
  }

  private finish(phase: "won" | "lost"): void {
    this.#phase = phase;
    this.#remainingMs = 0;
  }
}

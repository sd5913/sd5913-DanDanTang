import { DIFFICULTY_PROFILES, PROTOTYPE_ONLY, wavePopulation } from "./expedition-difficulty.ts";
import type { DifficultyId, EnemyStrength, ExpeditionStage } from "./expedition-difficulty.ts";
import { EVACUATION_CONFIG } from "./evacuation.ts";
import type { EvacuationBatch, EvacuationBatchProgress, EvacuationOrder, EvacuationState } from "./evacuation.ts";

export { PROTOTYPE_ONLY } from "./expedition-difficulty.ts";

export type ExpeditionPhase = "preparing" | "attacking" | "recovering" | "evacuating" | "won" | "lost";
export type RoundSpeed = boolean | "wait-test";

export interface WaveOrder extends EnemyStrength {
  readonly count: number;
}

type Timing = (typeof DIFFICULTY_PROFILES)[DifficultyId]["normal" | "fast"];

export class ExpeditionRound {
  readonly difficulty: DifficultyId;
  readonly #timing: Timing;
  readonly #evacuationEnabled: boolean;
  #phase: ExpeditionPhase = "preparing";
  #wave = 0;
  #pressure = 0;
  #pressureElapsedMs = 0;
  #remainingMs = 0;
  #playerHp: number = PROTOTYPE_ONLY.playerHp;
  #stage: ExpeditionStage = 0;
  #evacuation?: EvacuationState;
  #evacuationGapMs = 0;
  #lossReason?: "player" | "evacuation";

  constructor(speed: RoundSpeed = false, difficulty: DifficultyId = "baseline", evacuationEnabled = false) {
    this.difficulty = difficulty;
    this.#evacuationEnabled = evacuationEnabled;
    const profile = DIFFICULTY_PROFILES[difficulty];
    this.#timing = speed === "wait-test" ? {
      ...profile.normal, preparingMs: profile.fast.preparingMs, recoveringMs: profile.fast.recoveringMs,
    } : speed ? profile.fast : profile.normal;
    this.reset();
  }

  get phase(): ExpeditionPhase { return this.#phase; }
  get wave(): number { return this.#wave; }
  get pressure(): number { return this.#pressure; }
  get remainingMs(): number { return this.#remainingMs; }
  get playerHp(): number { return this.#playerHp; }
  get stage(): ExpeditionStage { return this.#stage; }
  get evacuation(): EvacuationState | undefined { return this.#evacuation; }
  get lossReason(): "player" | "evacuation" | undefined { return this.#lossReason; }
  get strength(): EnemyStrength { return DIFFICULTY_PROFILES[this.difficulty].stages[this.#stage]; }

  get upcoming(): WaveOrder | undefined {
    if (this.#phase !== "preparing" && this.#phase !== "recovering") return undefined;
    const waitingPressure = Math.floor((this.#pressureElapsedMs + this.#remainingMs) / this.#timing.pressureStepMs);
    return this.order(this.#wave + 1, this.#pressure + waitingPressure);
  }

  update(deltaMs: number, playerRow: number, active: number, pending: number): WaveOrder | undefined {
    if (this.finished() || this.#phase === "evacuating" || !Number.isFinite(deltaMs) || deltaMs <= 0) return undefined;
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
    return this.order(this.#wave, this.#pressure);
  }

  private order(wave: number, pressure: number): WaveOrder {
    return {
      count: wavePopulation(this.difficulty, wave, pressure),
      ...this.strength,
    };
  }

  hitPlayer(damage: number): void {
    if (this.finished() || !Number.isSafeInteger(damage) || damage <= 0) return;
    this.#playerHp = Math.max(0, this.#playerHp - damage);
    if (this.#playerHp === 0) {
      this.#lossReason = "player";
      this.finish("lost");
    }
  }

  reachGoal(toolLevel: number): boolean {
    if (this.#evacuationEnabled || this.finished() || !Number.isSafeInteger(toolLevel) || toolLevel < 2) return false;
    this.finish("won");
    return true;
  }

  activateEvacuation(toolLevel: number, playerRow: number): EvacuationOrder | undefined {
    if (!this.#evacuationEnabled || this.#evacuation || this.finished() || !Number.isSafeInteger(toolLevel) || toolLevel < 2) return;
    this.advancePressure(0, playerRow);
    this.#phase = "evacuating";
    this.#remainingMs = 0;
    this.#evacuation = {
      hp: EVACUATION_CONFIG.maxHp, maxHp: EVACUATION_CONFIG.maxHp, batch: 1,
      planned: EVACUATION_CONFIG.batchCounts[0] + EVACUATION_CONFIG.batchCounts[1],
    };
    return this.evacuationOrder(1);
  }

  updateEvacuation(deltaMs: number, batches: readonly EvacuationBatchProgress[]): EvacuationOrder | undefined {
    if (this.#phase !== "evacuating" || !this.#evacuation || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const first = batches.find(({ batch }) => batch === 1);
    if (!first || first.spawned !== EVACUATION_CONFIG.batchCounts[0] || first.pending !== 0
      || first.cancelledPending !== 0 || first.cancelledActive !== 0) return;
    if (this.#evacuation.batch === 1) {
      this.#evacuationGapMs += deltaMs;
      if (this.#evacuationGapMs < EVACUATION_CONFIG.batchGapMs) return;
      this.#evacuation = { ...this.#evacuation, batch: 2 };
      return this.evacuationOrder(2);
    }
    const second = batches.find(({ batch }) => batch === 2);
    if (second && second.spawned === EVACUATION_CONFIG.batchCounts[1] && second.pending === 0
      && second.cancelledPending === 0 && second.cancelledActive === 0
      && first.active === 0 && second.active === 0 && first.resolved === first.spawned && second.resolved === second.spawned
      && this.#evacuation.hp > 0 && this.#playerHp > 0) this.finish("won");
  }

  hitEvacuation(damage: number): number {
    if (this.#phase !== "evacuating" || !this.#evacuation || !Number.isSafeInteger(damage) || damage <= 0) return 0;
    const applied = Math.min(this.#evacuation.hp, damage);
    this.#evacuation = { ...this.#evacuation, hp: this.#evacuation.hp - applied };
    if (this.#evacuation.hp === 0) {
      this.#lossReason = "evacuation";
      this.finish("lost");
    }
    return applied;
  }

  private evacuationOrder(batch: EvacuationBatch): EvacuationOrder {
    return { batch, order: { count: EVACUATION_CONFIG.batchCounts[batch - 1], ...this.strength } };
  }

  reset(): void {
    this.#phase = "preparing";
    this.#wave = 0;
    this.#pressure = 0;
    this.#pressureElapsedMs = 0;
    this.#remainingMs = this.#timing.preparingMs;
    this.#playerHp = PROTOTYPE_ONLY.playerHp;
    this.#stage = 0;
    this.#evacuation = undefined;
    this.#evacuationGapMs = 0;
    this.#lossReason = undefined;
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

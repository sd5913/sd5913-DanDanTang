import type { WaveOrder } from "./expedition-round.ts";

export const EVACUATION_CONFIG = Object.freeze({
  maxHp: 6,
  batchCounts: [12, 20] as const,
  batchGapMs: 900,
});

export type EvacuationBatch = 1 | 2;

export interface EvacuationOrder {
  readonly batch: EvacuationBatch;
  readonly order: WaveOrder;
}

export interface EvacuationState {
  readonly hp: number;
  readonly maxHp: number;
  readonly batch: EvacuationBatch;
  readonly planned: number;
}

export interface EvacuationBatchProgress {
  readonly batch: EvacuationBatch;
  readonly planned: number;
  readonly spawned: number;
  readonly pending: number;
  readonly active: number;
  readonly resolved: number;
  readonly towerKills: number;
  readonly wallImpacts: number;
  readonly playerContacts: number;
  readonly deviceContacts: number;
  readonly deviceDamage: number;
  readonly cancelledPending: number;
  readonly cancelledActive: number;
}

type BatchState = { -readonly [Key in keyof EvacuationBatchProgress]: EvacuationBatchProgress[Key] };
export type EvacuationResolution = "towerKills" | "wallImpacts" | "playerContacts" | "deviceContacts";

export class EvacuationCombatLedger {
  private readonly batches = new Map<EvacuationBatch, BatchState>();
  private active = 0;
  private peak = 0;

  get snapshots(): readonly EvacuationBatchProgress[] { return Array.from(this.batches.values(), (batch) => ({ ...batch })); }
  get peakActive(): number { return this.peak; }

  start(batch: EvacuationBatch, planned: number): boolean {
    if ((batch !== 1 && batch !== 2) || planned !== EVACUATION_CONFIG.batchCounts[batch - 1] || this.batches.has(batch)) return false;
    const first = this.batches.get(1);
    if (batch === 2 && (!first || first.spawned !== first.planned || first.cancelledActive)) return false;
    this.batches.set(batch, {
      batch, planned, spawned: 0, pending: planned, active: 0, resolved: 0,
      towerKills: 0, wallImpacts: 0, playerContacts: 0, deviceContacts: 0, deviceDamage: 0,
      cancelledPending: 0, cancelledActive: 0,
    });
    return true;
  }

  spawn(batch: EvacuationBatch): void {
    const state = this.batches.get(batch);
    if (!state || state.pending === 0) return;
    state.pending -= 1;
    state.spawned += 1;
    state.active += 1;
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
  }

  resolve(batch: EvacuationBatch, kind: EvacuationResolution): void {
    const state = this.batches.get(batch);
    if (!state || state.active === 0) return;
    state.active -= 1;
    this.active -= 1;
    state.resolved += 1;
    state[kind] += 1;
  }

  recordDamage(batch: EvacuationBatch, damage: number): void {
    const state = this.batches.get(batch);
    if (state && Number.isSafeInteger(damage) && damage > 0) state.deviceDamage += damage;
  }

  cancelCombat(): void {
    for (const state of this.batches.values()) {
      state.cancelledPending += state.pending;
      state.cancelledActive += state.active;
      state.pending = 0;
      state.active = 0;
    }
    this.active = 0;
  }

  reset(): void {
    this.batches.clear();
    this.active = 0;
    this.peak = 0;
  }
}

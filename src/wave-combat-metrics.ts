import type { GridPosition } from "./terrain.ts";

const THREAT_RADIUS = 5;

export type AttackEndReason = "resolved" | "time-limit" | "terminal";

export interface WaveCombatSnapshot {
  readonly waveId: number;
  readonly planned: number;
  readonly spawned: number;
  readonly pending: number;
  readonly active: number;
  readonly peakActive: number;
  readonly threatened: number;
  readonly buildingContacts: number;
  readonly playerContacts: number;
  readonly towerKills: number;
  readonly towerHits: number;
  readonly towerHitEnemies: number;
  readonly towerHitsOnKills: number;
  readonly towerExposed: number;
  readonly towerExposureKills: number;
  readonly totalTowerExposureToKillMs: number;
  readonly averageTowerHitsOnKill: number | null;
  readonly averageTowerExposureToKillMs: number | null;
  readonly wallImpacts: number;
  readonly wallDamage: number;
  readonly wallsDestroyed: number;
  readonly buildingDamage: number;
  readonly buildingsDestroyed: number;
  readonly playerDamage: number;
  readonly cancelledPending: number;
  readonly cancelledActive: number;
  readonly startedAtMs: number;
  readonly firstSpawnAtMs: number | null;
  readonly firstThreatAtMs: number | null;
  readonly firstTowerExposureAtMs: number | null;
  readonly firstBuildingDamageAtMs: number | null;
  readonly firstPlayerDamageAtMs: number | null;
  readonly attackEndedAtMs: number | null;
  readonly attackEndReason: AttackEndReason | null;
  readonly settledAtMs: number | null;
}

type WaveTotals = Omit<WaveCombatSnapshot, "averageTowerHitsOnKill" | "averageTowerExposureToKillMs">;
type WaveState = { -readonly [Key in keyof WaveTotals]: WaveTotals[Key] };
type Resolution = "playerContacts" | "towerKills" | "wallImpacts";

interface UnitSample {
  readonly wave: WaveState;
  threatened: boolean;
  towerHits: number;
  firstTowerExposureAtMs: number | null;
}

export interface TowerExposureAnchor {
  readonly cell: GridPosition;
  readonly radius: number;
}

interface Position {
  readonly x: number;
  readonly y: number;
}

function enterFraction(start: Position, end: Position, center: GridPosition, radius: number): number {
  const x = start.x - center.col - 0.5;
  const y = start.y - center.row - 0.5;
  const outside = x ** 2 + y ** 2 - radius ** 2;
  if (outside <= 0) return 0;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distanceSquared = dx ** 2 + dy ** 2;
  const approach = x * dx + y * dy;
  if (approach >= 0) return Infinity;
  const discriminant = approach ** 2 - distanceSquared * outside;
  if (discriminant < 0) return Infinity;
  const fraction = (-approach - Math.sqrt(discriminant)) / distanceSquared;
  return fraction <= 1 ? fraction : Infinity;
}

function earlier(previous: number | null, timeMs: number): number {
  return previous === null ? timeMs : Math.min(previous, timeMs);
}

function summarize(wave: WaveState): WaveCombatSnapshot {
  return {
    ...wave,
    averageTowerHitsOnKill: wave.towerKills === 0 ? null : wave.towerHitsOnKills / wave.towerKills,
    averageTowerExposureToKillMs: wave.towerExposureKills === 0 ? null : wave.totalTowerExposureToKillMs / wave.towerExposureKills,
  };
}

export class WaveCombatMetrics {
  private readonly waves = new Map<number, WaveState>();
  private readonly units = new Map<number, UnitSample>();

  snapshots(): readonly WaveCombatSnapshot[] {
    return Array.from(this.waves.values(), summarize);
  }

  snapshot(waveId: number): WaveCombatSnapshot | undefined {
    const wave = this.waves.get(waveId);
    return wave && summarize(wave);
  }

  start(waveId: number, planned: number, timeMs: number): boolean {
    if (!Number.isSafeInteger(waveId) || waveId < 1 || this.waves.has(waveId)
      || !Number.isSafeInteger(planned) || planned < 1 || !Number.isFinite(timeMs) || timeMs < 0) return false;
    this.waves.set(waveId, {
      waveId, planned, spawned: 0, pending: planned, active: 0, peakActive: 0, threatened: 0,
      buildingContacts: 0, playerContacts: 0, towerKills: 0, wallImpacts: 0, wallDamage: 0,
      towerHits: 0, towerHitEnemies: 0, towerHitsOnKills: 0, towerExposed: 0, towerExposureKills: 0,
      totalTowerExposureToKillMs: 0, wallsDestroyed: 0, buildingDamage: 0, buildingsDestroyed: 0,
      playerDamage: 0, cancelledPending: 0, cancelledActive: 0,
      startedAtMs: timeMs, firstSpawnAtMs: null, firstThreatAtMs: null, firstTowerExposureAtMs: null, firstBuildingDamageAtMs: null,
      firstPlayerDamageAtMs: null, attackEndedAtMs: null, attackEndReason: null, settledAtMs: null,
    });
    return true;
  }

  spawn(waveId: number, enemyId: number, timeMs: number): void {
    const wave = this.waves.get(waveId);
    if (!wave || wave.pending === 0 || this.units.has(enemyId)) return;

    this.units.set(enemyId, { wave, threatened: false, towerHits: 0, firstTowerExposureAtMs: null });
    wave.pending -= 1;
    wave.spawned += 1;
    wave.active += 1;
    wave.peakActive = Math.max(wave.peakActive, wave.active);
    wave.firstSpawnAtMs ??= timeMs;
  }

  needsPositionSample(enemyId: number, hasTowers: boolean): boolean {
    const unit = this.units.get(enemyId);
    return unit !== undefined && (!unit.threatened || (hasTowers && unit.firstTowerExposureAtMs === null));
  }

  samplePosition(enemyId: number, start: Position, end: Position, timeMs: number, durationMs: number,
    player: GridPosition | undefined, buildings: readonly GridPosition[], towers: readonly TowerExposureAnchor[]): void {
    const unit = this.units.get(enemyId);
    if (!unit) return;

    if (!unit.threatened) {
      let earliest = player ? enterFraction(start, end, player, THREAT_RADIUS) : Infinity;
      for (const cell of buildings) {
        if (earliest === 0) break;
        earliest = Math.min(earliest, enterFraction(start, end, cell, THREAT_RADIUS));
      }
      if (Number.isFinite(earliest)) {
        unit.threatened = true;
        unit.wave.threatened += 1;
        unit.wave.firstThreatAtMs = earlier(unit.wave.firstThreatAtMs, timeMs + earliest * durationMs);
      }
    }

    if (unit.firstTowerExposureAtMs === null) {
      let earliest = Infinity;
      for (const { cell, radius } of towers) {
        if (earliest === 0) break;
        earliest = Math.min(earliest, enterFraction(start, end, cell, radius));
      }
      if (Number.isFinite(earliest)) this.recordTowerExposure(unit, timeMs + earliest * durationMs);
    }
  }

  recordTowerHit(enemyId: number, timeMs: number): void {
    const unit = this.units.get(enemyId);
    if (!unit) return;
    // A selected live target is in range even if the tower appeared during this step.
    if (unit.firstTowerExposureAtMs === null) this.recordTowerExposure(unit, timeMs);
    if (unit.towerHits === 0) unit.wave.towerHitEnemies += 1;
    unit.towerHits += 1;
    unit.wave.towerHits += 1;
  }

  resolve(enemyId: number, outcome: Resolution, timeMs: number, damage = 0, destroyed = false): void {
    const unit = this.units.get(enemyId);
    if (!unit) return;
    const { wave } = unit;
    this.units.delete(enemyId);
    wave.active -= 1;
    wave[outcome] += 1;
    if (outcome === "wallImpacts") {
      wave.wallDamage += damage;
      if (destroyed) wave.wallsDestroyed += 1;
      wave.firstBuildingDamageAtMs = earlier(wave.firstBuildingDamageAtMs, timeMs);
    }
    if (outcome === "towerKills") {
      wave.towerHitsOnKills += unit.towerHits;
      if (unit.firstTowerExposureAtMs !== null) {
        wave.towerExposureKills += 1;
        wave.totalTowerExposureToKillMs += timeMs - unit.firstTowerExposureAtMs;
      }
    }
    this.settle(wave, timeMs);
  }

  recordBuildingHit(enemyId: number, timeMs: number, damage: number, destroyed: boolean): void {
    const unit = this.units.get(enemyId);
    if (!unit) return;
    const { wave } = unit;
    wave.buildingContacts += 1;
    wave.buildingDamage += damage;
    if (destroyed) wave.buildingsDestroyed += 1;
    wave.firstBuildingDamageAtMs = earlier(wave.firstBuildingDamageAtMs, timeMs);
  }

  recordPlayerDamage(waveId: number, damage: number, timeMs: number): void {
    const wave = this.waves.get(waveId);
    if (!wave || !Number.isSafeInteger(damage) || damage <= 0) return;
    wave.playerDamage += damage;
    wave.firstPlayerDamageAtMs = earlier(wave.firstPlayerDamageAtMs, timeMs);
  }

  finishAttackPhase(waveId: number, timeMs: number, reason?: AttackEndReason): void {
    const wave = this.waves.get(waveId);
    if (!wave || wave.attackEndedAtMs !== null) return;
    wave.attackEndedAtMs = timeMs;
    wave.attackEndReason = reason ?? (wave.active === 0 && wave.pending === 0 ? "resolved" : "time-limit");
  }

  clearBattle(timeMs: number): void {
    this.units.clear();
    for (const wave of this.waves.values()) {
      this.finishAttackPhase(wave.waveId, timeMs, "terminal");
      wave.cancelledPending += wave.pending;
      wave.cancelledActive += wave.active;
      wave.pending = 0;
      wave.active = 0;
      this.settle(wave, timeMs);
    }
  }

  reset(): void {
    this.waves.clear();
    this.units.clear();
  }

  private settle(wave: WaveState, timeMs: number): void {
    if (wave.active === 0 && wave.pending === 0) wave.settledAtMs ??= timeMs;
  }

  private recordTowerExposure(unit: UnitSample, timeMs: number): void {
    unit.firstTowerExposureAtMs = timeMs;
    unit.wave.towerExposed += 1;
    unit.wave.firstTowerExposureAtMs = earlier(unit.wave.firstTowerExposureAtMs, timeMs);
  }
}

import type { Building, TowerAxis } from "./buildings.ts";
import type { EnemyKind, EnemyState } from "./defense-simulation.ts";
import type { Point } from "./player.ts";
import type { GridPosition, TerrainReader } from "./terrain.ts";
import {
  evolvedTargetDistanceSquared, hasTowerLineOfSight, intersectsPiercingBeam, PIERCING_FALLBACK,
  TARGET_DISTANCE_EPSILON, towerSearchRadius,
} from "./tower-attack.ts";
import type { EvolvedTowerCoverage } from "./tower-attack.ts";

type TowerKind = "standard" | "piercing" | "burst";
type ObservedEnemy = Pick<EnemyState, "id" | "hp" | "kind">;
type ExposureEnd = "left-area" | "tower-kill" | "wall-impact" | "player-contact" | "device-contact" | "tower-inactive" | "battle-ended";
type Candidate = "outside" | "legal" | "fallback" | "occluded" | "off-axis";
export type TowerHitRole = "primary" | "additional";

export interface DiagnosticTowerHit {
  readonly enemyId: number;
  readonly enemyKind: EnemyKind;
  readonly role: TowerHitRole;
  readonly position: Point;
  readonly damage: number;
  readonly overkill: number;
  readonly hpAfter: number;
}

interface DiagnosticShot {
  readonly timeMs: number;
  readonly targets: readonly DiagnosticTowerHit[];
}

interface OpenExposure {
  readonly enemy: ObservedEnemy;
  readonly enteredAtMs: number;
  lastSeenAtMs: number;
  finishNotBefore?: number;
}

interface Exposure {
  readonly enemyId: number;
  readonly enemyKind: EnemyKind;
  readonly enteredAtMs: number;
  readonly leftAtMs: number;
  readonly durationMs: number;
  readonly hpAfter: number;
  readonly reason: ExposureEnd | "active";
}

interface TowerObservation {
  readonly range: number;
  readonly damage: number;
  readonly coverage?: EvolvedTowerCoverage;
  readonly bodyAware?: boolean;
  readonly fallbackRange?: number;
}

function newDecisions() {
  return { noTarget: 0, noLegalTarget: 0, legalReady: 0, cooldown: 0,
    occludedTargets: 0, offAxisTargets: 0, blockedWhenReady: 0, offAxisWhenReady: 0, occludedSplashTargets: 0,
    cooldownFinish: 0, missedCooldownFinish: 0 };
}

function newTotals() {
  return { hitCount: 0, primaryHits: 0, additionalHits: 0, effectiveDamage: 0, overkillDamage: 0,
    splashDamage: 0, armoredDamage: 0, kills: 0, armoredKills: 0, assists: 0, armoredAssists: 0,
    assistDamage: 0, armoredAssistDamage: 0, armoredExits: 0, armoredExitHpSum: 0 };
}

export interface TowerCombatSnapshot extends Readonly<ReturnType<typeof newTotals>> {
  readonly towerId: string;
  readonly cell: GridPosition;
  readonly level: Building["level"];
  readonly kind: TowerKind;
  readonly axis?: TowerAxis;
  readonly effectiveRange: number;
  readonly rayReachTiles: number | null;
  readonly observedEligibleTiles: readonly GridPosition[];
  readonly fireCount: number;
  readonly hitEnemyCount: number;
  readonly shots: readonly DiagnosticShot[];
  readonly hitDistribution: Readonly<Record<"zero" | "one" | "two" | "three" | "four" | "aboveFour", number>>;
  readonly averageTargetsPerShot: number;
  readonly splashShare: number;
  readonly decisions: Readonly<ReturnType<typeof newDecisions>>;
  readonly exposures: readonly Exposure[];
  readonly meanArmoredExitHp: number | null;
}

function stageKey(tower: Building): string {
  return `${tower.id}:${tower.level}`;
}

class TowerSamples {
  readonly tower: Building;
  readonly decisions = newDecisions();
  readonly totals = newTotals();
  readonly shots: { readonly timeMs: number; readonly targets: DiagnosticTowerHit[] }[] = [];
  readonly hitEnemies = new Set<number>();
  readonly open = new Map<number, OpenExposure>();
  readonly exposures: Exposure[] = [];
  readonly eligibleTiles = new Map<string, GridPosition>();
  effectiveRange = 0;
  rayReachTiles: number | null = null;
  lastSampleAtMs = -1;

  constructor(tower: Building) { this.tower = tower; }

  snapshot(timeMs: number): TowerCombatSnapshot {
    const { id: towerId, cell, level, evolution } = this.tower;
    const shots = this.shots.map(({ timeMs, targets }) => ({ timeMs, targets: [...targets] }));
    const hitDistribution = { zero: 0, one: 0, two: 0, three: 0, four: 0, aboveFour: 0 };
    const categories = ["zero", "one", "two", "three", "four", "aboveFour"] as const;
    for (const { targets } of shots) hitDistribution[categories[Math.min(targets.length, 5)]] += 1;
    const { armoredExits, armoredExitHpSum, hitCount, effectiveDamage, splashDamage } = this.totals;
    return {
      towerId, cell, level, kind: evolution?.kind ?? "standard", axis: evolution?.kind === "piercing" ? evolution.axis : undefined,
      effectiveRange: this.effectiveRange, rayReachTiles: this.rayReachTiles, observedEligibleTiles: [...this.eligibleTiles.values()],
      ...this.totals, fireCount: shots.length, hitEnemyCount: this.hitEnemies.size, shots, hitDistribution,
      averageTargetsPerShot: shots.length ? hitCount / shots.length : 0,
      splashShare: effectiveDamage ? splashDamage / effectiveDamage : 0,
      decisions: { ...this.decisions },
      exposures: [...this.exposures, ...Array.from(this.open.values(), (entry) => exposure(entry, timeMs, "active"))],
      meanArmoredExitHp: armoredExits ? armoredExitHpSum / armoredExits : null,
    };
  }

  close(enemyId: number, timeMs: number, reason: ExposureEnd): void {
    const entry = this.open.get(enemyId);
    if (!entry) return;
    this.open.delete(enemyId);
    this.exposures.push(exposure(entry, timeMs, reason));
    const { kind, hp } = entry.enemy;
    const leftAlive = hp > 0 && (reason === "left-area" || reason === "wall-impact");
    if (leftAlive && kind === "armored") {
      this.totals.armoredExits += 1;
      this.totals.armoredExitHpSum += hp;
    }
    if (leftAlive && entry.finishNotBefore !== undefined && timeMs <= entry.finishNotBefore) {
      this.decisions.missedCooldownFinish += 1;
    }
  }
}

function exposure({ enemy, enteredAtMs }: OpenExposure, leftAtMs: number, reason: Exposure["reason"]): Exposure {
  return { enemyId: enemy.id, enemyKind: enemy.kind, enteredAtMs, leftAtMs,
    durationMs: leftAtMs - enteredAtMs, hpAfter: enemy.hp, reason };
}

function classifyCandidate(map: TerrainReader, tower: Building, observation: TowerObservation, position: Point): Candidate {
  const { range, coverage, bodyAware = false, fallbackRange } = observation;
  const dx = position.x - tower.cell.col - 0.5;
  const dy = position.y - tower.cell.row - 0.5;
  const distance = dx ** 2 + dy ** 2;
  const nearby = distance <= towerSearchRadius(range, bodyAware) ** 2 + (bodyAware ? TARGET_DISTANCE_EPSILON : 0);
  if (!coverage) return nearby ? "legal" : "outside";
  if (evolvedTargetDistanceSquared(map, coverage, position) !== undefined) return "legal";

  if (coverage.kind === "piercing") {
    if (fallbackRange !== undefined && distance <= towerSearchRadius(fallbackRange, true) ** 2 + TARGET_DISTANCE_EPSILON) {
      return hasTowerLineOfSight(map, coverage.origin, position, coverage.wallSynergy) ? "fallback" : "occluded";
    }
    if (intersectsPiercingBeam(coverage, position, range, range)) return "occluded";
    if (nearby) return "off-axis";
  } else if (nearby) {
    return "occluded";
  }
  return "outside";
}

/** Test-only observer. Actual attacks and damage resolve in DefenseSimulation. Exposure is sampled before each tower attacks. */
export class TowerCombatDiagnostics {
  private readonly map: TerrainReader;
  private readonly stages = new Map<string, TowerSamples>();
  private readonly contributions = new Map<number, Map<TowerSamples, number>>();

  constructor(map: TerrainReader) { this.map = map; }

  observe<T extends ObservedEnemy>(tower: Building, observation: TowerObservation, enemies: Iterable<T>,
    positionOf: (enemy: T) => Point, timeMs: number, readyAtMs: number): void {
    const key = stageKey(tower);
    let state = this.stages.get(key);
    if (!state) {
      state = new TowerSamples(tower);
      this.stages.set(key, state);
    }
    state.lastSampleAtMs = timeMs;
    state.effectiveRange = observation.range;
    const coverage = observation.coverage;
    if (coverage?.kind === "piercing") state.rayReachTiles = coverage.positiveReach + coverage.negativeReach;

    const { decisions, open, eligibleTiles } = state;
    const cooling = readyAtMs > timeMs;
    let hasLegal = false;
    let hasOccluded = false;
    let hasOffAxis = false;
    for (const enemy of enemies) {
      const position = positionOf(enemy);
      const candidate = classifyCandidate(this.map, tower, observation, position);
      if (candidate === "outside") continue;
      if (candidate !== "legal" && candidate !== "fallback") {
        if (candidate === "occluded") {
          hasOccluded = true;
          decisions.occludedTargets += 1;
        } else {
          hasOffAxis = true;
          decisions.offAxisTargets += 1;
        }
        continue;
      }
      hasLegal = true;
      const col = Math.floor(position.x);
      const row = Math.floor(position.y);
      const tileKey = `${col},${row}`;
      if (!eligibleTiles.has(tileKey)) eligibleTiles.set(tileKey, { col, row });
      let entry = open.get(enemy.id);
      if (!entry) {
        entry = { enemy, enteredAtMs: timeMs, lastSeenAtMs: timeMs };
        open.set(enemy.id, entry);
      }
      entry.lastSeenAtMs = timeMs;
      const damage = candidate === "fallback" ? PIERCING_FALLBACK.damage : observation.damage;
      if (cooling && enemy.hp <= damage && entry.finishNotBefore !== readyAtMs) {
        entry.finishNotBefore = readyAtMs;
        decisions.cooldownFinish += 1;
      }
    }

    for (const [enemyId, entry] of open) {
      if (entry.lastSeenAtMs !== timeMs) state.close(enemyId, timeMs, "left-area");
    }
    if (hasLegal) {
      if (cooling) decisions.cooldown += 1;
      else decisions.legalReady += 1;
    } else if (hasOccluded || hasOffAxis) {
      decisions.noLegalTarget += 1;
      if (!cooling && hasOccluded) decisions.blockedWhenReady += 1;
      if (!cooling && hasOffAxis) decisions.offAxisWhenReady += 1;
    } else {
      decisions.noTarget += 1;
    }
  }

  startShot(tower: Building, timeMs: number): void {
    this.stages.get(stageKey(tower))!.shots.push({ timeMs, targets: [] });
  }

  recordOccludedSplash(tower: Building): void {
    this.stages.get(stageKey(tower))!.decisions.occludedSplashTargets += 1;
  }

  recordHit(tower: Building, enemy: ObservedEnemy, role: TowerHitRole, position: Point, damage: number, overkill: number): void {
    const state = this.stages.get(stageKey(tower))!;
    state.shots.at(-1)!.targets.push({ enemyId: enemy.id, enemyKind: enemy.kind, role, position, damage, overkill, hpAfter: enemy.hp });
    state.hitEnemies.add(enemy.id);
    const { totals } = state;
    totals.hitCount += 1;
    if (role === "primary") totals.primaryHits += 1;
    else totals.additionalHits += 1;
    totals.effectiveDamage += damage;
    totals.overkillDamage += overkill;
    if (tower.evolution?.kind === "burst" && role === "additional") totals.splashDamage += damage;
    if (enemy.kind === "armored") totals.armoredDamage += damage;

    const priorDamage = this.contributions.get(enemy.id) ?? new Map();
    priorDamage.set(state, (priorDamage.get(state) ?? 0) + damage);
    this.contributions.set(enemy.id, priorDamage);
  }

  recordKill(tower: Building, enemy: ObservedEnemy, timeMs: number): void {
    const state = this.stages.get(stageKey(tower))!;
    state.totals.kills += 1;
    if (enemy.kind === "armored") state.totals.armoredKills += 1;
    for (const [contributor, damage] of this.contributions.get(enemy.id) ?? []) {
      if (contributor.tower.id === tower.id) continue;
      contributor.totals.assists += 1;
      contributor.totals.assistDamage += damage;
      if (enemy.kind === "armored") {
        contributor.totals.armoredAssists += 1;
        contributor.totals.armoredAssistDamage += damage;
      }
    }
    this.endEnemy(enemy.id, timeMs, "tower-kill");
  }

  endEnemy(enemyId: number, timeMs: number, reason: "tower-kill" | "wall-impact" | "player-contact" | "device-contact"): void {
    for (const state of this.stages.values()) state.close(enemyId, timeMs, reason);
    this.contributions.delete(enemyId);
  }

  finishStep(timeMs: number): void {
    for (const state of this.stages.values()) {
      if (state.lastSampleAtMs === timeMs) continue;
      for (const enemyId of state.open.keys()) state.close(enemyId, timeMs, "tower-inactive");
    }
  }

  clearBattle(timeMs: number): void {
    for (const state of this.stages.values()) {
      for (const enemyId of state.open.keys()) state.close(enemyId, timeMs, "battle-ended");
    }
    this.contributions.clear();
  }

  reset(): void {
    this.stages.clear();
    this.contributions.clear();
  }

  snapshots(timeMs: number): readonly TowerCombatSnapshot[] {
    return Array.from(this.stages.values(), (state) => state.snapshot(timeMs));
  }
}

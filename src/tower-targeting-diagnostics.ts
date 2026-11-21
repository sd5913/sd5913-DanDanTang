import type { Building } from "./buildings.ts";
import type { Point } from "./player.ts";
import { TILE_SIZE } from "./player.ts";
import type { TerrainReader } from "./terrain.ts";
import {
  intersectsPiercingBeam, TARGET_DISTANCE_EPSILON, towerLineOfSightBlocker, TOWER_ENEMY_RADIUS, towerSearchRadius,
} from "./tower-attack.ts";
import type { EvolvedTowerCoverage, TowerRayBlocker } from "./tower-attack.ts";

export type TargetingMode = "standard" | "piercing" | "piercingFallback" | "burst";

interface TowerObservation {
  readonly range: number;
  readonly origin: Point;
  readonly coverage?: EvolvedTowerCoverage;
  readonly bodyAware: boolean;
  readonly fallbackRange?: number;
}

interface ObservedEnemy {
  readonly id: number;
  readonly hp: number;
}

interface CandidateTrace {
  readonly enemyId: number;
  readonly hp: number;
  readonly world: Point;
  readonly centerDistance: number;
  readonly enemyRadiusPx: number;
  readonly inNominalRange: boolean;
  readonly inSearchRange: boolean;
  readonly bodyInAttackArea: boolean;
  readonly obstructed: boolean;
  readonly rejectedByAxis: boolean;
  readonly rejectedAsInvalid: boolean;
  readonly mainEligible: boolean;
  readonly fallbackEligible: boolean;
  readonly mainRejection?: CandidateRejection;
  readonly fallbackRejection?: CandidateRejection;
}

interface WallImpactTrace extends CandidateTrace {
  readonly topologyUnchanged: boolean;
}

interface TargetingFrame {
  readonly towerId: string;
  readonly orig: Point;
  readonly timeMs: number;
  readonly cooldownMs: number;
  readonly nominalRange: number;
  readonly fallbackRange?: number;
  readonly candidates: readonly CandidateTrace[];
  readonly wallImpactEnemyIds: readonly number[];
  readonly wallImpactsBeforeAim: readonly WallImpactTrace[];
  mode?: TargetingMode;
  selected: readonly number[];
  hits: number[];
  invalidAtImpact: number[];
}

type Decision = "no-target" | "no-legal-shot" | "cooldown" | "fired-no-hit" | "hit";
type CandidateRejection = TowerRayBlocker | "OUT_OF_RANGE" | "WRONG_AXIS" | "NO_VALID_TARGET";
type TargetingReason = CandidateRejection | "COOLDOWN" | "WALL_IMPACT_BEFORE_AIM" | "FIRED_NO_HIT" | "HIT";
const REJECTION_PRIORITY = [
  "BLOCKED_BY_SOLID_TERRAIN", "BLOCKED_BY_FRIENDLY_WALL", "BLOCKED_BY_STRUCTURE", "BLOCKED_BY_WATER",
  "BLOCKED_BY_BOUNDARY", "WRONG_AXIS", "OUT_OF_RANGE",
] as const satisfies readonly CandidateRejection[];

export interface TowerTargetingTrace extends TargetingFrame {
  readonly decision: Decision;
  readonly reason: TargetingReason;
  readonly fired: boolean;
}

interface TargetingWork {
  readonly towerId: string;
  readonly towerLevel: number;
  readonly kind: "standard" | "piercing" | "burst";
  searches: number;
  candidates: number;
  splashSearches: number;
  splashCandidates: number;
  fires: number;
}

const MAX_TRACE_FRAMES = 300;

function traceCandidate(map: TerrainReader, observation: TowerObservation,
  enemy: ObservedEnemy, position: Point): CandidateTrace {
  const { bodyAware, coverage, origin, range, fallbackRange } = observation;
  const dx = position.x - origin.x;
  const dy = position.y - origin.y;
  const distance = dx ** 2 + dy ** 2;
  const inNominalRange = distance <= range ** 2 + TARGET_DISTANCE_EPSILON;
  const withinRadius = distance <= towerSearchRadius(range, bodyAware) ** 2 + TARGET_DISTANCE_EPSILON;
  const obstruction = towerLineOfSightBlocker(map, origin, position, coverage?.wallSynergy);
  const bodyInAttackArea = coverage?.kind === "piercing"
    ? intersectsPiercingBeam(coverage, position, range, range) : withinRadius;
  const inSearchRange = withinRadius || bodyInAttackArea;
  const rejectedAsInvalid = enemy.hp <= 0;
  let mainRejection: CandidateRejection | undefined;
  if (rejectedAsInvalid) mainRejection = "NO_VALID_TARGET";
  else if (!inSearchRange) mainRejection = "OUT_OF_RANGE";
  else if (coverage?.kind === "burst") mainRejection = obstruction;
  else if (coverage?.kind === "piercing") {
    const forward = coverage.axis === "horizontal" ? dx : dy;
    if (!bodyInAttackArea) mainRejection = "WRONG_AXIS";
    else if (!intersectsPiercingBeam(coverage, position)) {
      mainRejection = (forward < 0 ? coverage.negativeBlocker : coverage.positiveBlocker) ?? "NO_VALID_TARGET";
    } else if (bodyAware) mainRejection = obstruction;
  }
  let fallbackRejection: CandidateRejection | undefined;
  if (fallbackRange !== undefined) {
    if (rejectedAsInvalid) fallbackRejection = "NO_VALID_TARGET";
    else if (distance > towerSearchRadius(fallbackRange, true) ** 2 + TARGET_DISTANCE_EPSILON) fallbackRejection = "OUT_OF_RANGE";
    else fallbackRejection = obstruction;
  }
  return {
    enemyId: enemy.id, hp: enemy.hp,
    world: { x: position.x * TILE_SIZE, y: position.y * TILE_SIZE },
    centerDistance: Math.sqrt(distance), enemyRadiusPx: TOWER_ENEMY_RADIUS * TILE_SIZE,
    inNominalRange, inSearchRange, bodyInAttackArea, obstructed: Boolean(obstruction), rejectedAsInvalid,
    mainEligible: mainRejection === undefined, fallbackEligible: fallbackRange !== undefined && fallbackRejection === undefined,
    rejectedByAxis: coverage?.kind === "piercing" && inSearchRange && !bodyInAttackArea,
    mainRejection, fallbackRejection,
  };
}

function decision(frame: TargetingFrame): Decision {
  if (frame.mode) return frame.hits.length > 0 ? "hit" : "fired-no-hit";
  if (frame.candidates.some((enemy) => enemy.mainEligible || enemy.fallbackEligible)) {
    return frame.cooldownMs > 0 ? "cooldown" : "no-legal-shot";
  }
  return frame.candidates.some((enemy) => enemy.inSearchRange && !enemy.rejectedAsInvalid) ? "no-legal-shot" : "no-target";
}

function reason(frame: TargetingFrame): TargetingReason {
  if (frame.mode) return frame.hits.length > 0 ? "HIT" : "FIRED_NO_HIT";
  if (frame.candidates.some(({ mainEligible, fallbackEligible }) => mainEligible || fallbackEligible)) {
    return frame.cooldownMs > 0 ? "COOLDOWN" : "NO_VALID_TARGET";
  }
  if (frame.wallImpactsBeforeAim.some(({ mainEligible, fallbackEligible, topologyUnchanged }) =>
    topologyUnchanged && (mainEligible || fallbackEligible))) {
    return frame.cooldownMs > 0 ? "COOLDOWN" : "WALL_IMPACT_BEFORE_AIM";
  }
  return REJECTION_PRIORITY.find((reason) => frame.candidates.some(({ mainRejection, fallbackRejection }) =>
    mainRejection === reason || fallbackRejection === reason)) ?? "NO_VALID_TARGET";
}

/** This observer is installed only by opt-in fixtures. The metrics-only mode never scans candidates. */
export class TowerTargetingDiagnostics {
  private readonly detail: boolean;
  private readonly frames: TargetingFrame[] = [];
  private readonly work = new Map<string, TargetingWork>();
  private readonly wallImpacts: { enemy: ObservedEnemy; position: Point; revision: number }[] = [];
  private frame?: TargetingFrame;

  constructor(mode: "trace" | "metrics") { this.detail = mode === "trace"; }

  get detailed(): boolean { return this.detail; }

  beginStep(): void {
    this.wallImpacts.length = 0;
  }

  wallImpact(enemy: ObservedEnemy, position: Point, revision: number): void {
    this.wallImpacts.push({ enemy, position, revision });
  }

  sample<T extends ObservedEnemy>(map: TerrainReader, tower: Building, observation: TowerObservation, enemies: Iterable<T>,
    enemyPosition: (enemy: T) => Point, timeMs: number, readyAt: number): void {
    if (!this.detail) return;
    // Enemy movement and its wall impacts resolve before the tower phase. A destroyed wall
    // may change line of sight, so only an unchanged topology proves that a target was eligible.
    const wallImpactsBeforeAim = this.wallImpacts.map(({ enemy, position, revision }) => ({
      ...traceCandidate(map, observation, enemy, position), topologyUnchanged: revision === map.revision,
    })).filter(({ inSearchRange }) => inSearchRange);
    this.frame = {
      towerId: tower.id,
      orig: { x: observation.origin.x * TILE_SIZE, y: observation.origin.y * TILE_SIZE },
      nominalRange: observation.range, fallbackRange: observation.fallbackRange,
      timeMs, cooldownMs: Math.max(0, readyAt - timeMs),
      candidates: Array.from(enemies, (enemy) => traceCandidate(map, observation, enemy, enemyPosition(enemy))),
      wallImpactsBeforeAim, wallImpactEnemyIds: wallImpactsBeforeAim.map(({ enemyId }) => enemyId),
      selected: [], hits: [], invalidAtImpact: [],
    };
    if (this.frames.length === MAX_TRACE_FRAMES) this.frames.shift();
    this.frames.push(this.frame);
  }

  search(tower: Building, candidates: number, stage: "aim" | "splash" = "aim"): void {
    const work = this.forTower(tower);
    if (stage === "splash") {
      work.splashSearches += 1;
      work.splashCandidates += candidates;
    } else {
      work.searches += 1;
      work.candidates += candidates;
    }
  }

  fire(tower: Building, mode: TargetingMode, ids: readonly number[]): void {
    this.forTower(tower).fires += 1;
    if (this.frame?.towerId === tower.id) {
      this.frame.mode = mode;
      this.frame.selected = ids;
    }
  }

  hit(tower: Building, enemyId: number, valid: boolean): void {
    if (this.frame?.towerId === tower.id) (valid ? this.frame.hits : this.frame.invalidAtImpact).push(enemyId);
  }

  get metrics(): readonly Readonly<TargetingWork>[] {
    return Array.from(this.work.values(), (entry) => ({ ...entry }));
  }

  get trace(): readonly TowerTargetingTrace[] {
    return this.frames.map((frame) => ({ ...frame, selected: [...frame.selected], hits: [...frame.hits],
      invalidAtImpact: [...frame.invalidAtImpact], fired: frame.mode !== undefined, decision: decision(frame), reason: reason(frame) }));
  }

  reset(): void {
    this.frames.length = 0;
    this.wallImpacts.length = 0;
    this.frame = undefined;
    this.work.clear();
  }

  private forTower(tower: Building): TargetingWork {
    const key = tower.id + ":" + tower.level;
    let work = this.work.get(key);
    if (!work) {
      work = { towerId: tower.id, towerLevel: tower.level, kind: tower.evolution?.kind ?? "standard", searches: 0,
        candidates: 0, splashSearches: 0, splashCandidates: 0, fires: 0 };
      this.work.set(key, work);
    }
    return work;
  }
}

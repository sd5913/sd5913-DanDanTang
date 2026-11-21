import type { Building } from "./buildings.ts";
import type { Point } from "./player.ts";
import { TILE_SIZE } from "./player.ts";
import type { TerrainReader } from "./terrain.ts";
import {
  evolvedTargetDistanceSquared, hasTowerLineOfSight, intersectsPiercingBeam, PIERCING_FALLBACK,
  TARGET_DISTANCE_EPSILON, TOWER_ENEMY_RADIUS, towerSearchRadius,
} from "./tower-attack.ts";
import type { EvolvedTowerCoverage } from "./tower-attack.ts";

export type TargetingMode = "standard" | "piercing" | "piercingFallback" | "burst";

interface TowerObservation {
  readonly range: number;
  readonly origin: Point;
  readonly coverage?: EvolvedTowerCoverage;
  readonly bodyAware: boolean;
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
}

interface TargetingFrame {
  readonly towerId: string;
  readonly orig: Point;
  readonly timeMs: number;
  readonly cooldownMs: number;
  readonly nominalRange: number;
  readonly candidates: readonly CandidateTrace[];
  mode?: TargetingMode;
  selected: readonly number[];
  hits: number[];
  invalidAtImpact: number[];
}

type Decision = "no-target" | "no-legal-shot" | "cooldown" | "fired-no-hit" | "hit";

export interface TowerTargetingTrace extends TargetingFrame {
  readonly decision: Decision;
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
  const { bodyAware, coverage, origin, range } = observation;
  const dx = position.x - origin.x;
  const dy = position.y - origin.y;
  const distance = dx ** 2 + dy ** 2;
  const inNominalRange = distance <= range ** 2 + TARGET_DISTANCE_EPSILON;
  const withinRadius = distance <= towerSearchRadius(range, bodyAware) ** 2 + TARGET_DISTANCE_EPSILON;
  const obstructed = !hasTowerLineOfSight(map, origin, position);
  const bodyInAttackArea = coverage?.kind === "piercing"
    ? intersectsPiercingBeam(coverage, position, range, range) : withinRadius;
  const inSearchRange = withinRadius || bodyInAttackArea;
  const rejectedAsInvalid = enemy.hp <= 0;
  const mainEligible = !rejectedAsInvalid && (coverage
    ? evolvedTargetDistanceSquared(map, coverage, position) !== undefined : inSearchRange);
  const fallbackEligible = !rejectedAsInvalid && bodyAware && coverage?.kind === "piercing"
    && distance <= towerSearchRadius(PIERCING_FALLBACK.range, true) ** 2 + TARGET_DISTANCE_EPSILON && !obstructed;
  return {
    enemyId: enemy.id, hp: enemy.hp,
    world: { x: position.x * TILE_SIZE, y: position.y * TILE_SIZE },
    centerDistance: Math.sqrt(distance), enemyRadiusPx: TOWER_ENEMY_RADIUS * TILE_SIZE,
    inNominalRange, inSearchRange, bodyInAttackArea, obstructed, rejectedAsInvalid, mainEligible, fallbackEligible,
    rejectedByAxis: coverage?.kind === "piercing" && inSearchRange && !bodyInAttackArea,
  };
}

function decision(frame: TargetingFrame): Decision {
  if (frame.mode) return frame.hits.length > 0 ? "hit" : "fired-no-hit";
  if (frame.candidates.some((enemy) => enemy.mainEligible || enemy.fallbackEligible)) {
    return frame.cooldownMs > 0 ? "cooldown" : "no-legal-shot";
  }
  return frame.candidates.some((enemy) => enemy.inSearchRange && !enemy.rejectedAsInvalid) ? "no-legal-shot" : "no-target";
}

/** This observer is installed only by opt-in fixtures. The metrics-only mode never scans candidates. */
export class TowerTargetingDiagnostics {
  private readonly detail: boolean;
  private readonly frames: TargetingFrame[] = [];
  private readonly work = new Map<string, TargetingWork>();
  private frame?: TargetingFrame;

  constructor(mode: "trace" | "metrics") { this.detail = mode === "trace"; }

  get detailed(): boolean { return this.detail; }

  sample<T extends ObservedEnemy>(map: TerrainReader, tower: Building, observation: TowerObservation, enemies: Iterable<T>,
    enemyPosition: (enemy: T) => Point, timeMs: number, readyAt: number): void {
    if (!this.detail) return;
    this.frame = {
      towerId: tower.id,
      orig: { x: observation.origin.x * TILE_SIZE, y: observation.origin.y * TILE_SIZE },
      nominalRange: observation.range, timeMs, cooldownMs: Math.max(0, readyAt - timeMs),
      candidates: Array.from(enemies, (enemy) => traceCandidate(map, observation, enemy, enemyPosition(enemy))),
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
      invalidAtImpact: [...frame.invalidAtImpact], fired: frame.mode !== undefined, decision: decision(frame) }));
  }

  reset(): void {
    this.frames.length = 0;
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

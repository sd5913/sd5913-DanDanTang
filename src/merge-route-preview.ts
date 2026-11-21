import { EnemyNavigation } from "./enemy-navigation.ts";
import type { NavigationApproach, NavigationMap } from "./enemy-navigation.ts";
import type { Building } from "./buildings.ts";
import type { EvacuationBatch } from "./evacuation.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

export interface MergeRouteKnowledge {
  readonly revision: number;
  readonly allKnown?: true;
  isVisible(cell: GridPosition): boolean;
  isKnown(cell: GridPosition): boolean;
}

type Representative = "enemy" | "entry";

export type MergeRoutePreview =
  | { readonly kind: "unknown" }
  | { readonly kind: "target-changed"; readonly representative: "enemy" }
  | { readonly kind: "opened"; readonly after: number; readonly representative: Representative }
  | { readonly kind: "unchanged" | "shorter"; readonly before: number; readonly after: number;
      readonly representative: Representative; readonly boundary?: "wall" };

export interface MergeRouteMetrics {
  readonly computations: number;
  readonly cacheHits: number;
  readonly searches: number;
  readonly elapsedMs: number;
  readonly worstMs: number;
}

export interface MergeRouteSubject {
  readonly id: number;
  /** A moving unit finishes its committed segment before asking navigation again. */
  readonly cell: GridPosition;
  readonly hasTargetedBuilding: boolean;
  readonly targetKey?: string;
  readonly evacuationBatch?: EvacuationBatch;
}

export interface MergeRouteWorld {
  readonly map: NavigationMap;
  readonly navigation: EnemyNavigation;
  readonly attackableBuildings: readonly Building[];
}

interface PursuitTarget {
  readonly kind: "building" | "player" | "evacuation";
  readonly cell: GridPosition;
  readonly buildingId?: string;
}

type ChooseTarget = (subject: MergeRouteSubject, player: GridPosition, world: MergeRouteWorld) => PursuitTarget;

interface ComparisonSide {
  readonly actual: MergeRouteWorld;
  readonly possible?: MergeRouteWorld;
  readonly knownOnly?: MergeRouteWorld;
}

interface ComparisonWorlds {
  readonly before: ComparisonSide;
  readonly after: ComparisonSide;
}

const UNKNOWN: MergeRoutePreview = Object.freeze({ kind: "unknown" });

function cellKey({ col, row }: GridPosition): string {
  return `${col},${row}`;
}

export function pursuitTargetKey(target: PursuitTarget): string {
  return target.buildingId ?? `${target.kind}:${cellKey(target.cell)}`;
}

function trace(world: MergeRouteWorld, from: GridPosition, target: PursuitTarget, isKnown: MergeRouteKnowledge["isKnown"]):
NavigationApproach | undefined {
  return world.navigation.traceApproach(from, target.cell, isKnown, target.kind !== "player",
    target.buildingId !== undefined ? world.attackableBuildings : undefined, target.kind === "evacuation");
}

function sameBoundary(first: NavigationApproach | undefined, second: NavigationApproach | undefined): boolean {
  if (first?.boundary === "wall") return second?.boundary === "wall" && first.wallId === second.wallId;
  if (first?.boundary === "building") return second?.boundary === "building" && first.buildingId === second.buildingId;
  return first?.boundary === second?.boundary;
}

function sameApproach(first: NavigationApproach | undefined, second: NavigationApproach | undefined): boolean {
  return sameBoundary(first, second) && first?.steps === second?.steps;
}

function getObservedApproach(side: ComparisonSide, from: GridPosition, target: PursuitTarget,
  isKnown: MergeRouteKnowledge["isKnown"]): { readonly route?: NavigationApproach } | undefined {
  const route = trace(side.actual, from, target, isKnown);
  if (route && !route.known) return undefined;
  if (side.possible && !sameApproach(route, trace(side.possible, from, target, isKnown))) return undefined;
  // A first wall can be chosen because a much later tile is open. Verify the breach decision
  // still works when hidden cells are blocked, even though they cannot appear in the approach.
  if (route?.boundary === "wall" && side.knownOnly
    && !sameApproach(route, trace(side.knownOnly, from, target, isKnown))) return undefined;
  return { route };
}

function combinedSearches({ before, after }: ComparisonWorlds): number {
  const searches = (side: ComparisonSide): number => side.actual.navigation.searchCount
    + (side.possible?.navigation.searchCount ?? 0) + (side.knownOnly?.navigation.searchCount ?? 0);
  return searches(before) + searches(after);
}

/** Holds scratch navigation only. It never writes the terrain, buildings, or combat simulation. */
export class MergeRouteForecaster {
  private worldState?: {
    readonly topologyKey: string;
    readonly key: string;
    readonly worlds: ComparisonWorlds;
  };
  private latest?: { readonly key: string; readonly result: MergeRoutePreview };
  private readonly counts = { computations: 0, cacheHits: 0, searches: 0, elapsedMs: 0, worstMs: 0 };

  private readonly map: TerrainMap;
  private readonly entry: GridPosition;
  private readonly goal: PursuitTarget;
  private readonly chooseTarget: ChooseTarget;

  constructor(map: TerrainMap, entry: GridPosition, goal: GridPosition, chooseTarget: ChooseTarget) {
    this.map = map;
    this.entry = entry;
    this.goal = { kind: "building", cell: goal };
    this.chooseTarget = chooseTarget;
  }

  get metrics(): MergeRouteMetrics { return { ...this.counts }; }

  preview(released: readonly GridPosition[], player: GridPosition, subject: MergeRouteSubject | undefined,
    knowledge: MergeRouteKnowledge, force: boolean): MergeRoutePreview {
    const releaseKeys = released.map(cellKey).sort();
    const topologyKey = `${this.map.revision}|${releaseKeys.join(";")}`;
    const worldKey = `${topologyKey}|${knowledge.revision}|${knowledge.allKnown === true}`;
    const subjectKey = subject ? `${subject.id}:${cellKey(subject.cell)}:${subject.hasTargetedBuilding}:${subject.targetKey ?? ""}` : "entry";
    const key = `${worldKey}|${subjectKey}|${cellKey(player)}`;
    if (!force && this.latest?.key === key) {
      this.counts.cacheHits += 1;
      return this.latest.result;
    }

    const startedAt = performance.now();
    const result = this.evaluate(released, player, subject, knowledge, topologyKey, worldKey);
    const elapsed = performance.now() - startedAt;
    this.counts.computations += 1;
    this.counts.elapsedMs += elapsed;
    this.counts.worstMs = Math.max(this.counts.worstMs, elapsed);
    this.latest = { key, result };
    return result;
  }

  private evaluate(released: readonly GridPosition[], player: GridPosition, subject: MergeRouteSubject | undefined,
    knowledge: MergeRouteKnowledge, topologyKey: string, worldKey: string): MergeRoutePreview {
    const known = (cell: GridPosition): boolean => knowledge.isKnown(cell);
    const from = subject?.cell ?? this.entry;
    if (!known(from) || (!subject && !known(this.goal.cell))) return UNKNOWN;
    if (released.length !== 3
      || released.some((cell) => !known(cell) || !this.map.getBuilding(cell) || this.map.getCell(cell)?.terrain !== "empty")) return UNKNOWN;
    const releases = new Set(released.map((cell) => this.cellIndex(cell)));
    if (releases.size !== 3) return UNKNOWN;

    if (this.worldState?.key !== worldKey) {
      // Discovery changes the proof view, not the actual before/after navigation fields.
      const stable = this.worldState?.topologyKey === topologyKey ? this.worldState.worlds : undefined;
      this.worldState = { topologyKey, key: worldKey, worlds: this.createWorlds(releases, knowledge, stable) };
    }
    const { worlds } = this.worldState;
    const searchesBefore = combinedSearches(worlds);
    const result = subject
      ? this.compareEnemy(worlds, player, subject, known)
      : this.compare(worlds, from, this.goal, known, "entry");
    this.counts.searches += combinedSearches(worlds) - searchesBefore;
    return result;
  }

  private cellIndex({ row, col }: GridPosition): number { return row * this.map.columns + col; }

  private createWorlds(released: ReadonlySet<number>, knowledge: MergeRouteKnowledge,
    stable?: ComparisonWorlds): ComparisonWorlds {
    const owned = [...this.map.getBuildings()].filter((building) => building.kind !== "wall");
    const create = (after: boolean, hiddenMode: "actual" | "open" | "closed"): MergeRouteWorld => {
      const isReleased = (cell: GridPosition): boolean => after && released.has(this.cellIndex(cell));
      const isUnknown = (cell: GridPosition): boolean => hiddenMode !== "actual" && !knowledge.isKnown(cell);
      const map: NavigationMap = {
        columns: this.map.columns, rows: this.map.rows, revision: this.map.revision,
        isWalkable: (cell) => this.map.isInside(cell) && (isUnknown(cell) ? hiddenMode === "open"
          : isReleased(cell) || this.map.isWalkable(cell)),
        getBuilding: (cell) => isReleased(cell) || isUnknown(cell) ? undefined : this.map.getBuilding(cell),
      };
      const attackableBuildings = owned.filter(({ cell }) => !isReleased(cell) && !isUnknown(cell));
      return { map, navigation: new EnemyNavigation(map), attackableBuildings };
    };
    const makeSide = (after: boolean, existing?: ComparisonSide): ComparisonSide => ({
      actual: existing?.actual ?? create(after, "actual"),
      // Extremes bound what hidden tiles could change without revealing their real state.
      ...(knowledge.allKnown ? {} : { possible: create(after, "open"), knownOnly: create(after, "closed") }),
    });
    return { before: makeSide(false, stable?.before), after: makeSide(true, stable?.after) };
  }

  private compareEnemy(worlds: ComparisonWorlds, player: GridPosition, subject: MergeRouteSubject,
    isKnown: MergeRouteKnowledge["isKnown"]): MergeRoutePreview {
    const before = this.chooseTarget(subject, player, worlds.before.actual);
    const after = this.chooseTarget(subject, player, worlds.after.actual);
    const beforeKey = pursuitTargetKey(before);
    const afterKey = pursuitTargetKey(after);
    if (!isKnown(before.cell) || !isKnown(after.cell)) return UNKNOWN;

    const canConfirmTarget = (side: ComparisonSide, target: string): boolean =>
      (!side.possible || pursuitTargetKey(this.chooseTarget(subject, player, side.possible)) === target)
      && (!side.knownOnly || pursuitTargetKey(this.chooseTarget(subject, player, side.knownOnly)) === target);
    if (!canConfirmTarget(worlds.before, beforeKey) || !canConfirmTarget(worlds.after, afterKey)) return UNKNOWN;

    if (beforeKey !== afterKey || (subject.targetKey !== undefined && subject.targetKey !== beforeKey)) {
      if (!getObservedApproach(worlds.before, subject.cell, before, isKnown)
        || !getObservedApproach(worlds.after, subject.cell, after, isKnown)) return UNKNOWN;
      return { kind: "target-changed", representative: "enemy" };
    }
    return this.compare(worlds, subject.cell, before, isKnown, "enemy");
  }

  private compare(worlds: ComparisonWorlds, from: GridPosition, target: PursuitTarget,
    isKnown: MergeRouteKnowledge["isKnown"], representative: Representative): MergeRoutePreview {
    const old = getObservedApproach(worlds.before, from, target, isKnown);
    const next = getObservedApproach(worlds.after, from, target, isKnown);
    if (!old || !next?.route) return UNKNOWN;
    // A newly open route is a high-priority warning even when it used to require wall attacks.
    if (next.route.boundary === "contact" && old.route?.boundary !== "contact") {
      return { kind: "opened", after: next.route.steps, representative };
    }
    if (!old.route || !sameBoundary(old.route, next.route) || next.route.boundary === "building") return UNKNOWN;
    return {
      kind: next.route.steps < old.route.steps ? "shorter" : "unchanged",
      before: old.route.steps, after: next.route.steps, representative,
      ...(next.route.boundary === "wall" ? { boundary: "wall" as const } : {}),
    };
  }
}

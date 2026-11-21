import type { BurstTowerAttributes, EvolvedTowerAttributes, PiercingTowerAttributes, TowerTuning } from "./building-balance.ts";
import type { TowerAxis } from "./buildings.ts";
import { ENEMY_RADIUS } from "./enemy-contact.ts";
import { TILE_SIZE } from "./player.ts";
import type { Point } from "./player.ts";
import type { GridPosition, TerrainMap, TerrainReader } from "./terrain.ts";

export const TOWER_ENEMY_RADIUS = ENEMY_RADIUS / TILE_SIZE;
export const PIERCING_BEAM_HALF_WIDTH = 1 / TILE_SIZE;
export const PIERCING_FALLBACK = Object.freeze({ range: 3, damage: 2 });
const CORNER_EPSILON = 1e-9;
export const TARGET_DISTANCE_EPSILON = 1e-9;

type TowerRayMap = TerrainReader & Partial<Pick<TerrainMap, "getBuilding">>;
export type TowerRayBlocker =
  | "BLOCKED_BY_FRIENDLY_WALL"
  | "BLOCKED_BY_SOLID_TERRAIN"
  | "BLOCKED_BY_STRUCTURE"
  | "BLOCKED_BY_WATER"
  | "BLOCKED_BY_BOUNDARY";

export function piercingFallbackRange(tuning?: TowerTuning): 3 | 4 | 5 {
  return tuning?.piercingFallbackRange ?? PIERCING_FALLBACK.range;
}

function towerRayBlocker(map: TowerRayMap, cell: GridPosition, wallSynergy: boolean): TowerRayBlocker | undefined {
  const tile = map.getCell(cell);
  if (!tile) return "BLOCKED_BY_BOUNDARY";
  if (tile.terrain === "dirt" || tile.terrain === "rock") return "BLOCKED_BY_SOLID_TERRAIN";
  // Open water remains impassable to units, but does not physically obstruct an attack.
  if (tile.terrain === "water") return wallSynergy ? undefined : "BLOCKED_BY_WATER";
  if (tile.buildingId === null) return;
  if (map.getBuilding?.(cell)?.kind === "wall") return wallSynergy ? undefined : "BLOCKED_BY_FRIENDLY_WALL";
  return "BLOCKED_BY_STRUCTURE";
}

export interface PiercingCoverage {
  readonly kind: "piercing";
  readonly origin: Point;
  readonly axis: TowerAxis;
  readonly negativeReach: number;
  readonly positiveReach: number;
  readonly negativeBlocker?: TowerRayBlocker;
  readonly positiveBlocker?: TowerRayBlocker;
  readonly wallSynergy: boolean;
  readonly halfWidth?: number;
}

interface BurstCoverage {
  readonly kind: "burst";
  readonly origin: Point;
  readonly rangeSquared: number;
  readonly wallSynergy: boolean;
}

export type EvolvedTowerCoverage = PiercingCoverage | BurstCoverage;

function piercingReach(map: TowerRayMap, { col, row }: GridPosition, axis: TowerAxis,
  range: number, direction: -1 | 1, wallSynergy: boolean): { reach: number; blocker?: TowerRayBlocker } {
  for (let distance = 0.5; distance < range; distance += 1) {
    const offset = (distance + 0.5) * direction;
    const cell = axis === "horizontal" ? { col: col + offset, row } : { col, row: row + offset };
    const blocker = towerRayBlocker(map, cell, wallSynergy);
    if (blocker) return { reach: distance, blocker };
  }
  return { reach: range };
}

export function buildEvolvedTowerCoverage(map: TowerRayMap, cell: GridPosition, attributes: PiercingTowerAttributes,
  bodyAware?: boolean, wallSynergy?: boolean): PiercingCoverage;
export function buildEvolvedTowerCoverage(map: TowerRayMap, cell: GridPosition, attributes: BurstTowerAttributes,
  bodyAware?: boolean, wallSynergy?: boolean): BurstCoverage;
export function buildEvolvedTowerCoverage(map: TowerRayMap, cell: GridPosition, attributes: EvolvedTowerAttributes,
  bodyAware?: boolean, wallSynergy?: boolean): EvolvedTowerCoverage;
export function buildEvolvedTowerCoverage(map: TowerRayMap, cell: GridPosition, attributes: EvolvedTowerAttributes,
  bodyAware = false, wallSynergy = false): EvolvedTowerCoverage {
  const { range } = attributes;
  const origin = { x: cell.col + 0.5, y: cell.row + 0.5 };
  if (attributes.kind === "burst") {
    return { kind: "burst", origin, wallSynergy, rangeSquared: towerSearchRadius(range, bodyAware) ** 2 };
  }

  const { axis } = attributes;
  const negative = piercingReach(map, cell, axis, range, -1, wallSynergy);
  const positive = piercingReach(map, cell, axis, range, 1, wallSynergy);
  return {
    kind: "piercing", origin, axis, wallSynergy,
    negativeReach: negative.reach, positiveReach: positive.reach,
    negativeBlocker: negative.blocker, positiveBlocker: positive.blocker,
    ...(bodyAware ? { halfWidth: PIERCING_BEAM_HALF_WIDTH } : {}),
  };
}

export function towerSearchRadius(range: number, bodyAware: boolean): number {
  return range + (bodyAware ? TOWER_ENEMY_RADIUS : 0);
}

export function intersectsPiercingBeam(coverage: PiercingCoverage, target: Point,
  negativeReach = coverage.negativeReach, positiveReach = coverage.positiveReach): boolean {
  const dx = target.x - coverage.origin.x;
  const dy = target.y - coverage.origin.y;
  const forward = coverage.axis === "horizontal" ? dx : dy;
  const cross = Math.abs(coverage.axis === "horizontal" ? dy : dx);
  if (coverage.halfWidth === undefined) {
    return cross <= TOWER_ENEMY_RADIUS && forward >= -negativeReach && forward <= positiveReach;
  }
  // Circle-to-rectangle contact also catches partial body overlap at the beam's end.
  const axialGap = Math.max(-negativeReach - forward, forward - positiveReach, 0);
  const crossGap = Math.max(cross - coverage.halfWidth, 0);
  return axialGap ** 2 + crossGap ** 2 <= TOWER_ENEMY_RADIUS ** 2 + TARGET_DISTANCE_EPSILON;
}

export function evolvedTargetDistanceSquared(map: TowerRayMap, coverage: EvolvedTowerCoverage, target: Point,
  nearestSquared = Infinity): number | undefined {
  const dx = target.x - coverage.origin.x;
  const dy = target.y - coverage.origin.y;
  const distance = dx ** 2 + dy ** 2;
  if (distance > nearestSquared) return;
  if (coverage.kind === "burst") {
    return distance <= coverage.rangeSquared + TARGET_DISTANCE_EPSILON && hasTowerLineOfSight(map, coverage.origin, target, coverage.wallSynergy) ? distance : undefined;
  }
  if (!intersectsPiercingBeam(coverage, target)) return;
  if (coverage.halfWidth !== undefined && !hasTowerLineOfSight(map, coverage.origin, target, coverage.wallSynergy)) return;
  return distance;
}

export function hasTowerLineOfSight(map: TowerRayMap, from: Point, to: Point, wallSynergy = false): boolean {
  return towerLineOfSightBlocker(map, from, to, wallSynergy) === undefined;
}

/** Trace actual positions, allowing the tower's occupied origin and checking both touching corner cells. */
export function towerLineOfSightBlocker(map: TowerRayMap, from: Point, to: Point,
  wallSynergy = false): TowerRayBlocker | undefined {
  let col = Math.floor(from.x);
  let row = Math.floor(from.y);
  const targetCol = Math.floor(to.x);
  const targetRow = Math.floor(to.y);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const stepCol = Math.sign(dx);
  const stepRow = Math.sign(dy);
  const colIncrement = 1 / Math.abs(dx);
  const rowIncrement = 1 / Math.abs(dy);
  let colEdge = stepCol > 0 ? (col + 1 - from.x) * colIncrement : (from.x - col) * colIncrement;
  let rowEdge = stepRow > 0 ? (row + 1 - from.y) * rowIncrement : (from.y - row) * rowIncrement;

  while (col !== targetCol || row !== targetRow) {
    const crossingCol = col === targetCol ? Infinity : colEdge;
    const crossingRow = row === targetRow ? Infinity : rowEdge;
    const corner = Math.abs(crossingCol - crossingRow) <= CORNER_EPSILON;
    if (corner) {
      const blocker = towerRayBlocker(map, { col: col + stepCol, row }, wallSynergy)
        ?? towerRayBlocker(map, { col, row: row + stepRow }, wallSynergy);
      if (blocker) return blocker;
    }
    if (corner || crossingCol < crossingRow) {
      col += stepCol;
      colEdge += colIncrement;
    }
    if (corner || crossingRow < crossingCol) {
      row += stepRow;
      rowEdge += rowIncrement;
    }
    const blocker = towerRayBlocker(map, { col, row }, wallSynergy);
    if (blocker) return blocker;
  }
}

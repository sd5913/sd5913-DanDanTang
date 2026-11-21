import type { BurstTowerAttributes, EvolvedTowerAttributes, PiercingTowerAttributes } from "./building-balance.ts";
import type { TowerAxis } from "./buildings.ts";
import { ENEMY_RADIUS } from "./enemy-contact.ts";
import { TILE_SIZE } from "./player.ts";
import type { Point } from "./player.ts";
import type { GridPosition, TerrainReader } from "./terrain.ts";

export const TOWER_ENEMY_RADIUS = ENEMY_RADIUS / TILE_SIZE;
export const PIERCING_BEAM_HALF_WIDTH = 1 / TILE_SIZE;
export const PIERCING_FALLBACK = Object.freeze({ range: 3, damage: 2 });
const CORNER_EPSILON = 1e-9;
export const TARGET_DISTANCE_EPSILON = 1e-9;

export interface PiercingCoverage {
  readonly kind: "piercing";
  readonly origin: Point;
  readonly axis: TowerAxis;
  readonly negativeReach: number;
  readonly positiveReach: number;
  readonly halfWidth?: number;
}

interface BurstCoverage {
  readonly kind: "burst";
  readonly origin: Point;
  readonly rangeSquared: number;
}

export type EvolvedTowerCoverage = PiercingCoverage | BurstCoverage;

function piercingReach(map: TerrainReader, { col, row }: GridPosition, axis: TowerAxis,
  range: number, direction: -1 | 1): number {
  for (let distance = 0.5; distance < range; distance += 1) {
    const offset = (distance + 0.5) * direction;
    const cell = axis === "horizontal" ? { col: col + offset, row } : { col, row: row + offset };
    if (!map.isWalkable(cell)) return distance;
  }
  return range;
}

export function buildEvolvedTowerCoverage(map: TerrainReader, cell: GridPosition, attributes: PiercingTowerAttributes, bodyAware?: boolean): PiercingCoverage;
export function buildEvolvedTowerCoverage(map: TerrainReader, cell: GridPosition, attributes: BurstTowerAttributes, bodyAware?: boolean): BurstCoverage;
export function buildEvolvedTowerCoverage(map: TerrainReader, cell: GridPosition, attributes: EvolvedTowerAttributes, bodyAware?: boolean): EvolvedTowerCoverage;
export function buildEvolvedTowerCoverage(map: TerrainReader, cell: GridPosition, attributes: EvolvedTowerAttributes,
  bodyAware = false): EvolvedTowerCoverage {
  const { range } = attributes;
  const origin = { x: cell.col + 0.5, y: cell.row + 0.5 };
  if (attributes.kind === "burst") return { kind: "burst", origin, rangeSquared: towerSearchRadius(range, bodyAware) ** 2 };

  const { axis } = attributes;
  return {
    kind: "piercing", origin, axis,
    negativeReach: piercingReach(map, cell, axis, range, -1),
    positiveReach: piercingReach(map, cell, axis, range, 1),
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

export function evolvedTargetDistanceSquared(map: TerrainReader, coverage: EvolvedTowerCoverage, target: Point,
  nearestSquared = Infinity): number | undefined {
  const dx = target.x - coverage.origin.x;
  const dy = target.y - coverage.origin.y;
  const distance = dx ** 2 + dy ** 2;
  if (distance > nearestSquared) return;
  if (coverage.kind === "burst") {
    return distance <= coverage.rangeSquared + TARGET_DISTANCE_EPSILON && hasTowerLineOfSight(map, coverage.origin, target) ? distance : undefined;
  }
  if (!intersectsPiercingBeam(coverage, target)) return;
  if (coverage.halfWidth !== undefined && !hasTowerLineOfSight(map, coverage.origin, target)) return;
  return distance;
}

/** Trace actual positions, allowing the tower's occupied origin and checking both touching corner cells. */
export function hasTowerLineOfSight(map: TerrainReader, from: Point, to: Point): boolean {
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
    if (corner && (!map.isWalkable({ col: col + stepCol, row }) || !map.isWalkable({ col, row: row + stepRow }))) return false;
    if (corner || crossingCol < crossingRow) {
      col += stepCol;
      colEdge += colIncrement;
    }
    if (corner || crossingRow < crossingCol) {
      row += stepRow;
      rowEdge += rowIncrement;
    }
    if (!map.isWalkable({ col, row })) return false;
  }
  return true;
}

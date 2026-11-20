import { PLAYER_HALF_SIZE } from "./player.ts";
import type { Point } from "./player.ts";

export const ENEMY_RADIUS = 5;

export interface PlayerContact {
  readonly enemyWorld: Point;
  readonly playerWorld: Point;
  readonly centerDistance: number;
  readonly collisionDistance: number;
  readonly allowedRange: number;
  readonly progress: number;
}

type Bounds = readonly [minX: number, minY: number, maxX: number, maxY: number];

export function boxDistance(center: Point, box: Point, halfSize: number): number {
  return Math.hypot(Math.max(0, Math.abs(center.x - box.x) - halfSize),
    Math.max(0, Math.abs(center.y - box.y) - halfSize));
}

function enterBounds(start: Point, delta: Point, [minX, minY, maxX, maxY]: Bounds): number {
  let entry = 0;
  let exit = 1;
  for (const [position, velocity, min, max] of [
    [start.x, delta.x, minX, maxX],
    [start.y, delta.y, minY, maxY],
  ]) {
    if (velocity === 0) {
      if (position < min || position > max) return Infinity;
      continue;
    }
    const a = (min - position) / velocity;
    const b = (max - position) / velocity;
    entry = Math.max(entry, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  return entry <= exit ? entry : Infinity;
}

function enterCircle(start: Point, delta: Point, x: number, y: number): number {
  const dx = start.x - x;
  const dy = start.y - y;
  const gap = dx ** 2 + dy ** 2 - ENEMY_RADIUS ** 2;
  if (gap <= 0) return 0;
  const toward = -(dx * delta.x + dy * delta.y);
  const speedSquared = delta.x ** 2 + delta.y ** 2;
  const discriminant = toward ** 2 - speedSquared * gap;
  if (toward <= 0 || discriminant < 0) return Infinity;
  const progress = gap / (toward + Math.sqrt(discriminant));
  return progress <= 1 ? progress : Infinity;
}

/** Sweep the same circle used for the red dot against the player's movement bounds. */
export function sweepPlayerContact(start: Point, end: Point, player: Point): PlayerContact | undefined {
  const left = player.x - PLAYER_HALF_SIZE;
  const top = player.y - PLAYER_HALF_SIZE;
  const right = player.x + PLAYER_HALF_SIZE;
  const bottom = player.y + PLAYER_HALF_SIZE;
  const r = ENEMY_RADIUS;
  if (Math.max(start.x, end.x) < left - r || Math.min(start.x, end.x) > right + r
    || Math.max(start.y, end.y) < top - r || Math.min(start.y, end.y) > bottom + r) return;
  const delta = { x: end.x - start.x, y: end.y - start.y };

  // The expanded rectangle has four round corners. Its two rectangular strips and
  // the four corner circles together give the exact contact region.
  const progress = Math.min(
    enterBounds(start, delta, [left - r, top, right + r, bottom]),
    enterBounds(start, delta, [left, top - r, right, bottom + r]),
    enterCircle(start, delta, left, top), enterCircle(start, delta, left, bottom),
    enterCircle(start, delta, right, top), enterCircle(start, delta, right, bottom),
  );
  if (!Number.isFinite(progress)) return;
  const enemyWorld = { x: start.x + delta.x * progress, y: start.y + delta.y * progress };
  const dx = Math.abs(enemyWorld.x - player.x);
  const dy = Math.abs(enemyWorld.y - player.y);
  return {
    enemyWorld, playerWorld: player, progress, centerDistance: Math.hypot(dx, dy),
    collisionDistance: boxDistance(enemyWorld, player, PLAYER_HALF_SIZE),
    allowedRange: r,
  };
}

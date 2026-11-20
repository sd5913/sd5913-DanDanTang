import assert from "node:assert/strict";
import test from "node:test";
import { placementFailure } from "../src/build-placement.ts";
import { PLAYER_HALF_SIZE, TILE_SIZE, cellCenter } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const center = cell(7, 8);

function fixture(markers = [], rows = 32) {
  const layout = Array.from({ length: rows }, (_, row) => Array.from({ length: 24 }, (_, col) => {
    if (col === center.col && row === center.row) return "S";
    return markers.find(([position]) => position.col === col && position.row === row)?.[1] ?? ".";
  }).join(""));
  return new TerrainMap(layout);
}

function conditions(position = center, overrides = {}) {
  return { playerPosition: cellCenter(position), roundEnded: false, visible: true, reserved: false,
    enemyOccupies: () => false, cardCount: 1, ...overrides };
}

test("all eight neighboring empty cells can be built, but the player's own cell cannot", () => {
  const map = fixture();
  const snapshot = conditions();
  for (const [dc, dr] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    assert.equal(placementFailure(map, cell(center.col + dc, center.row + dr), snapshot), undefined);
  }
  assert.equal(placementFailure(map, center, snapshot), "player-cell");
  for (const target of [cell(9, 8), cell(7, 10), cell(5, 6), cell(11, 7)]) {
    assert.equal(placementFailure(map, target, snapshot), "out-of-range");
  }
});

test("diagonal range does not require a separate line of sight through orthogonal blockers", () => {
  const map = fixture([[cell(8, 8), "#"], [cell(7, 7), "#"]]);
  assert.equal(placementFailure(map, cell(8, 7), conditions()), undefined);
});

test("terrain, buildings, reserve cells, actors and stock independently reject placement", () => {
  const dirt = cell(6, 7);
  const rock = cell(7, 7);
  const water = cell(8, 7);
  const tower = cell(6, 8);
  const target = cell(8, 8);
  const map = fixture([[dirt, "+"], [rock, "#"], [water, "~"]]);
  const building = map.placeBuilding("tower", tower);
  assert.ok(building);
  const revision = map.revision;

  for (const site of [dirt, rock, water]) assert.equal(placementFailure(map, site, conditions()), "terrain");
  assert.equal(placementFailure(map, tower, conditions()), "occupied");
  assert.equal(placementFailure(map, target, conditions(center, { reserved: true })), "reserved");
  assert.equal(placementFailure(map, target, conditions(center, { enemyOccupies: () => true })), "enemy-occupied");
  assert.equal(placementFailure(map, target, conditions(center, { cardCount: 0 })), "out-of-stock");
  assert.equal(placementFailure(map, target, conditions(center, { roundEnded: true })), "round-ended");

  assert.equal(map.getBuilding(tower), building);
  assert.equal(map.getBuilding(target), undefined);
  assert.equal(map.revision, revision);
});

test("hidden or out-of-map targets never inspect protected terrain information", () => {
  const map = {
    isInside: ({ col, row }) => col >= 0 && col < 24 && row >= 0 && row < 32,
    getCell() { assert.fail("Placement inspected terrain outside currently visible cells"); },
  };
  assert.equal(placementFailure(map, cell(8, 8), conditions(center, { visible: false })), "not-visible");
  assert.equal(placementFailure(map, cell(-1, 8), conditions()), "out-of-bounds");
});

test("the actual world-space player body cannot be enclosed by an adjacent placement", () => {
  const map = fixture();
  const west = cell(center.col - 1, center.row);
  const left = center.col * TILE_SIZE;
  const y = cellCenter(center).y;
  const touching = { x: left + PLAYER_HALF_SIZE, y };
  const overlapping = { x: left + PLAYER_HALF_SIZE - 0.25, y };
  assert.equal(placementFailure(map, west, conditions(center, { playerPosition: touching })), undefined);
  assert.equal(placementFailure(map, west, conditions(center, { playerPosition: overlapping })), "player-overlap");
});

test("the same target becomes legal after walking into range across a map seam", () => {
  const map = fixture([], 96);
  const target = cell(8, 63);
  const before = cell(7, 65);
  const after = cell(7, 64);
  assert.notEqual(map.worldToChunk(target)?.chunk.chunkRow, map.worldToChunk(after)?.chunk.chunkRow);
  assert.equal(placementFailure(map, target, conditions(before)), "out-of-range");
  assert.equal(placementFailure(map, target, conditions(after)), undefined);
});

test("free technology rebuild skips the card check while retaining range and occupancy", () => {
  const map = fixture();
  const site = cell(8, 7);
  const rebuild = { cardCount: undefined };
  assert.equal(placementFailure(map, site, conditions(center, rebuild)), undefined);
  assert.equal(placementFailure(map, site, conditions(cell(10, 8), rebuild)), "out-of-range");
  assert.ok(map.placeBuilding("tower", site));
  assert.equal(placementFailure(map, site, conditions(center, rebuild)), "occupied");
});

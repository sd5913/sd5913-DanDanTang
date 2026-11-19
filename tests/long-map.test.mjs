import assert from "node:assert/strict";
import test from "node:test";
import { LONG_MAP_LAYOUT } from "../src/long-map.ts";
import { PLAYER_HALF_SIZE, Player, TILE_SIZE } from "../src/player.ts";
import { CHUNK_ROWS, TerrainMap } from "../src/terrain.ts";

const north = { col: 11, row: 4 };
const southDirt = { col: 10, row: 92 };
const untouchedDirt = { col: 12, row: 92 };
const routeObstacles = [91, 63, 31];

function snapshot(map) {
  return Array.from({ length: map.rows }, (_, row) => Array.from(
    { length: map.columns }, (_, col) => map.getCell({ col, row }),
  ));
}

function walkToRow(player, map, row) {
  const steps = Math.abs(player.cell.row - row) * 8;
  const direction = Math.sign(row - player.cell.row);
  for (let step = 0; step < steps && player.cell.row !== row; step += 1) {
    player.move(0, direction, 50, map);
  }
  assert.deepEqual(player.cell, { col: 11, row });
}

function assertNorthBlocked(player, map, row) {
  for (let step = 0; step < 8; step += 1) player.move(0, -1, 50, map);
  assert.deepEqual(player.cell, { col: 11, row });
  assert.equal(player.position.y - PLAYER_HALF_SIZE, row * TILE_SIZE);
}

test("all world coordinates round trip to chunks, including each side of both seams", () => {
  const map = new TerrainMap(LONG_MAP_LAYOUT);
  assert.equal(CHUNK_ROWS, 32);
  assert.equal(map.columns, 24);
  assert.equal(map.rows, 96);
  assert.deepEqual(map.spawn, { col: 11, row: 92 });
  assert.equal(map.isGoal(north), true);

  for (const [row, chunkRow, localRow] of [[31, 0, 31], [32, 1, 0], [63, 1, 31], [64, 2, 0]]) {
    const world = { col: 11, row };
    const chunk = { chunkCol: 0, chunkRow };
    const local = { col: 11, row: localRow };
    assert.deepEqual(map.worldToChunk(world), { chunk, local });
    assert.deepEqual(map.chunkToWorld(chunk, local), world);
  }
  for (let row = 0; row < map.rows; row += 1) {
    for (let col = 0; col < map.columns; col += 1) {
      const world = { col, row };
      const { chunk, local } = map.worldToChunk(world);
      assert.deepEqual(map.chunkToWorld(chunk, local), world);
    }
  }
});

test("invalid world cells, chunk IDs, and local cells cannot cross a seam or alias a valid cell", () => {
  const map = new TerrainMap(LONG_MAP_LAYOUT);
  for (const position of [
    { col: 11, row: -1 }, { col: 11, row: 96 }, { col: 11, row: 63.5 },
    { col: -1, row: 63 }, { col: 24, row: 63 }, { col: 10.5, row: 63 },
  ]) {
    assert.equal(map.worldToChunk(position), undefined);
    assert.equal(map.getCell(position), undefined);
  }

  const chunk = { chunkCol: 0, chunkRow: 1 };
  const local = { col: 11, row: 0 };
  for (const invalidChunk of [
    { chunkCol: 0, chunkRow: -1 }, { chunkCol: 0, chunkRow: 3 },
    { chunkCol: 0, chunkRow: 1.5 }, { chunkCol: -1, chunkRow: 1 }, { chunkCol: 1, chunkRow: 1 },
  ]) {
    assert.equal(map.chunkToWorld(invalidChunk, local), undefined);
  }
  for (const invalidLocal of [
    { col: 11, row: -1 }, { col: 11, row: 32 }, { col: 11, row: 0.5 },
    { col: -1, row: 0 }, { col: 24, row: 0 }, { col: 11.5, row: 0 },
  ]) {
    assert.equal(map.chunkToWorld(chunk, invalidLocal), undefined);
  }
});

test("the fixed route requires digging, and player collision and neighbor queries work across both seams", () => {
  const map = new TerrainMap(LONG_MAP_LAYOUT);
  const player = new Player(map.spawn);
  for (const row of [31, 63]) {
    for (let col = 0; col < map.columns; col += 1) assert.equal(map.isWalkable({ col, row }), false);
  }

  for (const [index, row] of routeObstacles.entries()) {
    walkToRow(player, map, row + 1);
    const target = { col: 11, row };
    assertNorthBlocked(player, map, row + 1);
    assert.equal(map.getWalkableNeighbors(player.cell).some((cell) => cell.row === row), false);

    assert.deepEqual(map.applyDigDamage(player.cell, target, 1), { effective: true, damage: 1, hp: 4, cleared: false });
    assert.equal(map.revision, index);
    assertNorthBlocked(player, map, row + 1);

    assert.deepEqual(map.applyDigDamage(player.cell, target, 4), { effective: true, damage: 4, hp: 0, cleared: true });
    assert.equal(map.revision, index + 1);
    assert.ok(map.getWalkableNeighbors(player.cell).some((cell) => cell.row === row));
    walkToRow(player, map, row);
    assert.ok(map.getWalkableNeighbors(player.cell).some((cell) => cell.row === row + 1));
  }

  walkToRow(player, map, north.row);
  assert.equal(map.isGoal(player.cell), true);
  assert.equal(map.revision, 3);
});

test("damage and clear state persist after leaving chunks, and reset restores every chunk", () => {
  const map = new TerrainMap(LONG_MAP_LAYOUT);
  const player = new Player(map.spawn);
  const initial = snapshot(map);
  for (const hp of [4, 3, 2]) {
    assert.deepEqual(map.applyDigDamage(player.cell, southDirt, 1), { effective: true, damage: 1, hp, cleared: false });
    assert.equal(map.revision, 0);
  }

  for (const row of routeObstacles) {
    walkToRow(player, map, row + 1);
    assert.equal(map.applyDigDamage(player.cell, { col: 11, row }, 5).cleared, true);
  }
  walkToRow(player, map, north.row);
  assert.equal(map.worldToChunk(player.cell).chunk.chunkRow, 0);

  walkToRow(player, map, map.spawn.row);
  assert.equal(map.worldToChunk(player.cell).chunk.chunkRow, 2);
  assert.deepEqual(map.getCell(southDirt), { terrain: "dirt", terrainLevel: 1, buildingId: null, hp: 2, maxHp: 5 });
  assert.equal(map.getCell(untouchedDirt).hp, 5);
  for (const row of routeObstacles) assert.equal(map.getCell({ col: 11, row }).terrain, "empty");
  assert.equal(map.revision, 3);

  walkToRow(player, map, north.row);
  map.reset();
  player.reset(map.spawn);
  assert.deepEqual(player.cell, { col: 11, row: 92 });
  assert.equal(map.revision, 4);
  assert.deepEqual(snapshot(map), initial);
});

test("the single-map fixture remains the default and fixture metadata is stable across reset", () => {
  const mutableLayout = [...LONG_MAP_LAYOUT];
  const longMap = new TerrainMap(mutableLayout);
  const singleMap = new TerrainMap();
  mutableLayout[4] = "#".repeat(24);
  mutableLayout[92] = "#".repeat(24);
  longMap.reset();

  assert.equal(singleMap.rows, 32);
  assert.deepEqual(singleMap.spawn, { col: 11, row: 28 });
  assert.equal(singleMap.getCell({ col: 11, row: 27 }).hp, 5);
  assert.equal(singleMap.worldToChunk({ col: 11, row: 32 }), undefined);
  assert.equal(singleMap.revision, 0);
  assert.deepEqual(longMap.spawn, { col: 11, row: 92 });
  assert.equal(longMap.isGoal(north), true);
  assert.equal(longMap.getCell(southDirt).hp, 5);
});

test("fixture construction rejects incomplete chunks, malformed rows, and invalid markers or spawns", () => {
  assert.throws(() => new TerrainMap(LONG_MAP_LAYOUT.slice(0, 95)), RangeError);
  const invalid = [...LONG_MAP_LAYOUT];
  invalid[0] = invalid[0].slice(1);
  assert.throws(() => new TerrainMap(invalid), RangeError);
  invalid[0] = "X" + "#".repeat(23);
  assert.throws(() => new TerrainMap(invalid), /Invalid test map marker/);
  invalid[0] = "S" + "#".repeat(23);
  assert.throws(() => new TerrainMap(invalid), /exactly one spawn/);
});

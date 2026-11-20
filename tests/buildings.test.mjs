import assert from "node:assert/strict";
import test from "node:test";
import { LONG_MAP_LAYOUT } from "../src/long-map.ts";
import { PLAYER_HALF_SIZE, Player, TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const east = { col: 12, row: 28 };
const south = { col: 11, row: 29 };
const west = { col: 10, row: 28 };
const north = { col: 11, row: 27 };

test("wall and prototype tower occupy and block empty cells independently of terrain", () => {
  const map = new TerrainMap();
  const original = map.getCell(east);
  const requested = { ...east };
  const wall = map.placeBuilding("wall", requested);
  const tower = map.placeBuilding("tower", south, 12);
  assert.deepEqual(wall, { id: wall.id, kind: "wall", cell: east, level: 1, buildOrder: 1, hp: 50, maxHp: 50 });
  assert.deepEqual(tower, { id: tower.id, kind: "tower", cell: south, level: 1, buildOrder: 2, hp: 12, maxHp: 12 });
  assert.notEqual(wall.id, tower.id);
  requested.col = 20;
  assert.ok(Object.isFrozen(wall));
  assert.ok(Object.isFrozen(wall.cell));
  assert.equal(map.getBuilding(east), wall);
  assert.deepEqual([...map.getBuildings()], [wall, tower]);
  assert.deepEqual(map.getCell(east), { ...original, buildingId: wall.id });
  assert.equal(original.buildingId, null);
  assert.equal(map.isWalkable(east), false);
  assert.equal(map.isWalkable(south), false);
  assert.deepEqual(map.getWalkableNeighbors(map.spawn), []);
  assert.equal(map.revision, 2);

  assert.equal(map.removeBuilding(east, wall.id), wall);
  assert.equal(map.getBuilding(east), undefined);
  assert.equal(map.getCell(east), original);
  assert.equal(map.isWalkable(east), true);
  assert.deepEqual(map.getWalkableNeighbors(map.spawn), [east]);
  assert.equal(map.revision, 3);
});

test("invalid coordinates, building kinds, and durability do not alter occupancy or revision", () => {
  const map = new TerrainMap();
  for (const cell of [west, north, { col: -1, row: 1 }, { col: 24, row: 0 }, { col: 12.5, row: 28 }, { col: 12, row: 32 }]) {
    assert.equal(map.placeBuilding("wall", cell), undefined);
    assert.equal(map.getBuilding(cell), undefined);
    assert.equal(map.removeBuilding(cell), undefined);
    assert.equal(map.impactWall(cell, "missing", 1), undefined);
  }
  assert.equal(map.placeBuilding("castle", east, 50), undefined);
  for (const hp of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(map.placeBuilding("wall", east, hp), undefined);
  }
  assert.equal(map.revision, 0);
  const wall = map.placeBuilding("wall", east);
  assert.equal(map.placeBuilding("tower", east), undefined);
  assert.equal(map.getBuilding(east), wall);
  assert.deepEqual([...map.getBuildings()], [wall]);
  assert.equal(map.revision, 1);
});

test("three one-point strikes destroy a 3 HP wall, and a fourth attempt has no effect", () => {
  const map = new TerrainMap();
  const wall = map.placeBuilding("wall", east, 3);
  for (const hp of [2, 1, 0]) {
    const before = map.getBuilding(east);
    assert.deepEqual(map.impactWall(east, wall.id, 1), {
      wall: before, damage: 1, hp, destroyed: hp === 0,
    });
    assert.equal(before.hp, hp + 1);
    assert.equal(map.isWalkable(east), hp === 0);
    assert.equal(map.revision, hp === 0 ? 2 : 1);
    assert.equal(map.getBuilding(east)?.hp, hp === 0 ? undefined : hp);
    assert.equal(map.getBuilding(east)?.maxHp, hp === 0 ? undefined : 3);
  }
  assert.equal(map.impactWall(east, wall.id, 1), undefined);
  assert.equal(map.getCell(east).buildingId, null);
  assert.equal(map.revision, 2);
});

test("only the first simultaneous strike on a 1 HP wall succeeds, and stale IDs cannot affect replacements", () => {
  const map = new TerrainMap();
  const wall = map.placeBuilding("wall", east, 1);
  const queuedHit = () => map.impactWall(east, wall.id, 1);
  const simultaneous = [queuedHit, queuedHit].map((hit) => hit());
  assert.deepEqual(simultaneous, [{ wall, damage: 1, hp: 0, destroyed: true }, undefined]);
  assert.equal(map.revision, 2);

  const replacement = map.placeBuilding("wall", east, 3);
  assert.notEqual(replacement.id, wall.id);
  assert.equal(queuedHit(), undefined);
  assert.equal(map.removeBuilding(east, wall.id), undefined);
  assert.equal(map.getBuilding(east), replacement);
  assert.equal(map.revision, 3);
});

test("wall hits clamp overkill and reject towers, wrong IDs, and nonpositive or noninteger damage", () => {
  const map = new TerrainMap();
  const wall = map.placeBuilding("wall", east, 3);
  const tower = map.placeBuilding("tower", south);
  assert.equal(map.impactWall(south, tower.id, 1), undefined);
  assert.equal(map.impactWall(east, tower.id, 1), undefined);
  for (const damage of [-1, 0, 0.5, NaN, Infinity]) {
    assert.equal(map.impactWall(east, wall.id, damage), undefined);
  }
  assert.equal(map.getBuilding(south), tower);
  assert.equal(map.getBuilding(east), wall);
  assert.equal(map.revision, 2);

  assert.deepEqual(map.impactWall(east, wall.id, 5), { wall, damage: 3, hp: 0, destroyed: true });
  assert.equal(map.isWalkable(east), true);
  assert.equal(map.revision, 3);
});

test("seam blockage updates the same topology as digging, and reset clears all building occupancy", () => {
  const map = new TerrainMap(LONG_MAP_LAYOUT);
  const from = { col: 11, row: 64 };
  const to = { col: 11, row: 63 };
  assert.notEqual(map.worldToChunk(from).chunk.chunkRow, map.worldToChunk(to).chunk.chunkRow);
  assert.equal(map.applyDigDamage(from, to, 2).hp, 3);
  assert.equal(map.revision, 0);
  assert.equal(map.applyDigDamage(from, to, 3).cleared, true);
  assert.equal(map.revision, 1);
  assert.ok(map.getWalkableNeighbors(from).some((cell) => cell.row === to.row));

  const wall = map.placeBuilding("wall", to, 3);
  assert.equal(map.revision, 2);
  assert.equal(map.getCell(to).terrain, "empty");
  assert.equal(map.getCell(to).buildingId, wall.id);
  assert.equal(map.getWalkableNeighbors(from).some((cell) => cell.row === to.row), false);
  const player = new Player(from);
  for (let step = 0; step < 8; step += 1) player.move(0, -1, 50, map);
  assert.deepEqual(player.cell, from);
  assert.equal(player.position.y - PLAYER_HALF_SIZE, from.row * TILE_SIZE);

  assert.equal(map.impactWall(to, wall.id, 2).hp, 1);
  assert.equal(map.revision, 2);
  assert.equal(map.impactWall(to, wall.id, 1).destroyed, true);
  assert.equal(map.revision, 3);
  for (let step = 0; step < 4; step += 1) player.move(0, -1, 50, map);
  assert.deepEqual(player.cell, to);

  const northern = map.placeBuilding("wall", to, 8);
  const southern = map.placeBuilding("tower", from);
  assert.equal(map.revision, 5);
  map.reset();
  assert.equal(map.revision, 6);
  assert.deepEqual([...map.getBuildings()], []);
  assert.equal(map.getCell(to).hp, 5);
  assert.equal(map.getCell(to).buildingId, null);
  assert.equal(map.isWalkable(to), false);
  assert.equal(map.isWalkable(from), true);
  const postReset = map.placeBuilding("wall", from);
  assert.ok(![wall.id, northern.id, southern.id].includes(postReset.id));
  assert.ok(postReset.buildOrder > southern.buildOrder);
  assert.equal(map.impactWall(from, southern.id, 1), undefined);
  assert.equal(map.getBuilding(from), postReset);
});

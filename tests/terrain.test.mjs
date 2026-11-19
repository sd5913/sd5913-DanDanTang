import assert from "node:assert/strict";
import test from "node:test";
import { TerrainMap } from "../src/terrain.ts";
import { TEST_MAP_LAYOUT } from "../src/test-map.ts";

const north = { col: 11, row: 27 };
const northeast = { col: 12, row: 27 };
const west = { col: 10, row: 28 };
const east = { col: 12, row: 28 };
const south = { col: 11, row: 29 };

function snapshot(map) {
  return Array.from({ length: map.rows }, (_, row) => Array.from(
    { length: map.columns }, (_, col) => map.getCell({ col, row }),
  ));
}

function canReachGoal(map) {
  const pending = [map.spawn];
  const visited = new Set([`${map.spawn.col},${map.spawn.row}`]);

  for (const position of pending) {
    if (map.isGoal(position)) return true;
    for (const neighbor of map.getWalkableNeighbors(position)) {
      const key = `${neighbor.col},${neighbor.row}`;
      if (visited.has(key)) continue;
      visited.add(key);
      pending.push(neighbor);
    }
  }
  return false;
}

test("the fixed map is a 24×32 grid with all three terrain types", () => {
  const map = new TerrainMap();
  const rows = snapshot(map);
  assert.equal(map.columns, 24);
  assert.equal(map.rows, 32);
  assert.equal(TEST_MAP_LAYOUT.length, 32);
  for (const row of TEST_MAP_LAYOUT) assert.equal(row.length, 24);

  const cells = rows.flat();
  assert.deepEqual(new Set(cells.map((cell) => cell.terrain)), new Set(["rock", "empty", "dirt"]));
  for (const cell of cells) {
    assert.equal(cell.buildingId, null);
    assert.equal(cell.terrainLevel, cell.terrain === "empty" ? 0 : 1);
    const durability = { dirt: 5, empty: 0, rock: null }[cell.terrain];
    assert.equal(cell.hp, durability);
    assert.equal(cell.maxHp, durability);
    assert.ok(Object.isFrozen(cell));
  }
  assert.deepEqual(map.spawn, { col: 11, row: 28 });
  assert.ok(map.isWalkable(map.spawn));
  assert.ok(map.isGoal({ col: 11, row: 4 }));
  assert.ok(map.isWalkable({ col: 11, row: 4 }));
});

test("grid lookups reject out-of-bounds and noninteger coordinates", () => {
  const map = new TerrainMap();
  for (const position of [
    { col: -1, row: 28 }, { col: 24, row: 28 },
    { col: 11, row: -1 }, { col: 11, row: 32 },
    { col: 11.5, row: 28 }, { col: 11, row: 28.5 },
    { col: NaN, row: 28 }, { col: 11, row: Infinity },
  ]) {
    assert.equal(map.isInside(position), false);
    assert.equal(map.getCell(position), undefined);
    assert.equal(map.isWalkable(position), false);
    assert.equal(map.isGoal(position), false);
    assert.deepEqual(map.getWalkableNeighbors(position), []);
  }
  assert.equal(map.getCell({ col: 0, row: 0 }).terrain, "rock");
  assert.equal(map.isInside({ col: 23, row: 31 }), true);
});

test("four hits leave a solid tile and the fifth changes walkability and revision", () => {
  const map = new TerrainMap();
  const formerCell = map.getCell(north);
  assert.equal(map.isWalkable(north), false);
  assert.deepEqual(map.getWalkableNeighbors(map.spawn), [east, south]);

  for (let hp = 4; hp > 0; hp -= 1) {
    assert.equal(map.getDigFailure(map.spawn, north), undefined);
    assert.deepEqual(map.applyDigDamage(map.spawn, north, 1), { effective: true, damage: 1, hp, cleared: false });
    const damaged = map.getCell(north);
    assert.deepEqual(damaged, { terrain: "dirt", terrainLevel: 1, buildingId: null, hp, maxHp: 5 });
    assert.throws(() => { damaged.hp = 99; }, TypeError);
    assert.equal(map.isWalkable(north), false);
    assert.deepEqual(map.getWalkableNeighbors(map.spawn), [east, south]);
    assert.equal(map.revision, 0);
  }

  assert.deepEqual(map.applyDigDamage(map.spawn, north, 1), { effective: true, damage: 1, hp: 0, cleared: true });
  assert.deepEqual(map.getCell(north), { terrain: "empty", terrainLevel: 0, buildingId: null, hp: 0, maxHp: 0 });
  assert.equal(formerCell.hp, 5);
  assert.equal(map.isWalkable(north), true);
  assert.deepEqual(map.getWalkableNeighbors(map.spawn), [north, east, south]);
  assert.equal(map.revision, 1);
  assert.deepEqual(map.applyDigDamage(map.spawn, north, 1), {
    effective: false, damage: 0, hp: 0, cleared: false, reason: "empty",
  });
  assert.equal(map.revision, 1);
});

test("overkill deducts at most the remaining HP", () => {
  const map = new TerrainMap();
  map.applyDigDamage(map.spawn, north, 2);
  assert.deepEqual(map.applyDigDamage(map.spawn, north, 100), { effective: true, damage: 3, hp: 0, cleared: true });
  assert.equal(map.getCell(north).hp, 0);
  assert.equal(map.revision, 1);
});

test("invalid targets, origins and damage do not mutate the map", () => {
  const map = new TerrainMap();
  const initial = snapshot(map);
  for (const [origin, target, reason, hp] of [
    [map.spawn, map.spawn, "out-of-reach", 0],
    [map.spawn, northeast, "out-of-reach", 5],
    [map.spawn, { col: 11, row: 26 }, "out-of-reach", 5],
    [map.spawn, { col: 24, row: 28 }, "out-of-bounds", null],
    [map.spawn, { col: 11, row: 27.5 }, "out-of-bounds", null],
    [map.spawn, { col: "11", row: 27 }, "out-of-bounds", null],
    [{ col: -1, row: 27 }, north, "invalid-origin", 5],
    [west, map.spawn, "invalid-origin", 0],
    [map.spawn, west, "rock", null],
    [map.spawn, east, "empty", 0],
  ]) {
    assert.equal(map.getDigFailure(origin, target), reason);
    assert.deepEqual(map.applyDigDamage(origin, target, 100), { effective: false, damage: 0, hp, cleared: false, reason });
  }
  for (const damage of [0, -1, NaN, Infinity, Number.MIN_VALUE]) {
    assert.deepEqual(map.applyDigDamage(map.spawn, north, damage), {
      effective: false, damage: 0, hp: 5, cleared: false, reason: "invalid-damage",
    });
  }
  assert.equal(map.revision, 0);
  assert.deepEqual(snapshot(map), initial);
});

test("a walkable north route appears through sequential digs and resets repeatably", () => {
  const map = new TerrainMap();
  const initial = snapshot(map);
  assert.equal(canReachGoal(map), false);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const initialRevision = map.revision;
    let current = map.spawn;
    let digs = 0;
    for (let row = current.row - 1; row >= 4; row -= 1) {
      const next = { col: current.col, row };
      if (!map.isWalkable(next)) {
        for (let hp = 4; hp >= 0; hp -= 1) {
          assert.deepEqual(map.applyDigDamage(current, next, 1), { effective: true, damage: 1, hp, cleared: hp === 0 });
        }
        digs += 1;
      }
      assert.ok(map.isWalkable(next));
      current = next;
    }
    assert.equal(digs, 12);
    assert.equal(map.revision, initialRevision + digs);
    assert.ok(map.isGoal(current));
    assert.equal(canReachGoal(map), true);

    map.reset();
    assert.equal(map.revision, initialRevision + digs + 1);
    assert.deepEqual(snapshot(map), initial);
    assert.equal(canReachGoal(map), false);
  }
});

test("cell and map damage remain independent, and reset restores damaged cells", () => {
  const digMap = new TerrainMap();
  const originalMap = new TerrainMap();
  digMap.applyDigDamage(digMap.spawn, north, 2);
  assert.equal(digMap.getCell(north).hp, 3);
  assert.equal(digMap.getCell(northeast).hp, 5);
  assert.equal(originalMap.getCell(north).hp, 5);

  digMap.applyDigDamage(east, northeast, 1);
  digMap.applyDigDamage(digMap.spawn, north, 3);
  assert.equal(digMap.getCell(northeast).hp, 4);
  assert.equal(originalMap.isWalkable(north), false);
  assert.equal(originalMap.revision, 0);

  digMap.reset();
  assert.equal(digMap.getCell(north).hp, 5);
  assert.equal(digMap.getCell(northeast).hp, 5);
  assert.equal(digMap.revision, 2);
});

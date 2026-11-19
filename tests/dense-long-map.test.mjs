import assert from "node:assert/strict";
import test from "node:test";
import { DENSE_LONG_MAP_LAYOUT } from "../src/dense-long-map.ts";
import { DEFENSE_LAYOUT, DEFENSE_TARGET, ENEMY_ENTRY } from "../src/defense-map.ts";
import { CHUNK_ROWS, TerrainMap } from "../src/terrain.ts";

const center = (row) => ({ col: 11, row });
const spawn = center(92);
const gate = center(89);

function neighbors(map, { col, row }) {
  return [
    { col, row: row - 1 },
    { col: col + 1, row },
    { col, row: row + 1 },
    { col: col - 1, row },
  ].filter((cell) => map.isInside(cell));
}

function key({ col, row }) {
  return `${col},${row}`;
}

function connectedCells(map, from, canEnter) {
  const cells = [from];
  const visited = new Set([key(from)]);
  for (const cell of cells) {
    for (const neighbor of neighbors(map, cell)) {
      if (visited.has(key(neighbor)) || !canEnter(neighbor)) continue;
      visited.add(key(neighbor));
      cells.push(neighbor);
    }
  }
  return cells;
}

// Independent 0–1 BFS: moving into open terrain costs zero; clearing dirt costs one.
function fewestDigs(map, start) {
  const costs = new Map([[key(start), 0]]);
  const queue = [{ cell: start, cost: 0 }];
  while (queue.length > 0) {
    const { cell, cost } = queue.shift();
    if (cost !== costs.get(key(cell))) continue;
    if (map.isGoal(cell)) return cost;
    for (const next of neighbors(map, cell)) {
      const terrain = map.getCell(next).terrain;
      if (terrain === "rock") continue;
      const nextCost = cost + Number(terrain === "dirt");
      if ((costs.get(key(next)) ?? Infinity) <= nextCost) continue;
      costs.set(key(next), nextCost);
      const entry = { cell: next, cost: nextCost };
      if (terrain === "empty") queue.unshift(entry);
      else queue.push(entry);
    }
  }
  return Infinity;
}

function interiorRockSizes(map, chunkRow) {
  const firstRow = Math.max(1, chunkRow * CHUNK_ROWS);
  const endRow = Math.min(map.rows - 1, (chunkRow + 1) * CHUNK_ROWS);
  const isInteriorRock = (cell) => cell.col > 0 && cell.col < map.columns - 1
    && cell.row >= firstRow && cell.row < endRow && map.getCell(cell).terrain === "rock";
  const visited = new Set();
  const sizes = [];
  for (let row = firstRow; row < endRow; row += 1) {
    for (let col = 1; col < map.columns - 1; col += 1) {
      const cell = { col, row };
      if (!isInteriorRock(cell) || visited.has(key(cell))) continue;
      const region = connectedCells(map, cell, isInteriorRock);
      for (const rock of region) visited.add(key(rock));
      sizes.push(region.length);
    }
  }
  return sizes.sort((a, b) => b - a);
}

for (const [name, layout, startupOpenCells] of [
  ["dense default", DENSE_LONG_MAP_LAYOUT, 18],
  ["defense", DEFENSE_LAYOUT, 22],
]) {
  test(`${name}: each 768-cell chunk balances dirt, rock, and reserved openings`, () => {
    const map = new TerrainMap(layout);
    const startup = connectedCells(map, map.spawn, (cell) => map.isWalkable(cell));
    const startupKeys = new Set(startup.map(key));
    assert.deepEqual(map.spawn, spawn);
    assert.equal(map.rows, 96);
    assert.equal(map.columns, 24);

    for (const chunkRow of [0, 1, 2]) {
      const counts = { dirt: 0, rock: 0, spawnRoom: 0, goal: 0, reserve: 0 };
      for (let row = chunkRow * CHUNK_ROWS; row < (chunkRow + 1) * CHUNK_ROWS; row += 1) {
        for (let col = 0; col < map.columns; col += 1) {
          const cell = { col, row };
          const { terrain } = map.getCell(cell);
          if (terrain !== "empty") counts[terrain] += 1;
          else if (map.isGoal(cell)) counts.goal += 1;
          else if (startupKeys.has(key(cell))) counts.spawnRoom += 1;
          else counts.reserve += 1;
          if (col === 0 || row === 0 || col === 23 || row === 95) assert.equal(terrain, "rock");
        }
      }
      const goal = chunkRow === 0 ? 18 : 0;
      const spawnRoom = chunkRow === 2 ? startupOpenCells : 0;
      assert.deepEqual(counts, { dirt: 538, rock: 115, spawnRoom, goal, reserve: 115 - goal - spawnRoom });
      assert.deepEqual(interiorRockSizes(map, chunkRow), chunkRow === 1 ? [29, 22] : [29]);
    }
  });
}

test("the default map confines initial movement to its southern room and requires real excavation", () => {
  const map = new TerrainMap(DENSE_LONG_MAP_LAYOUT);
  const initial = connectedCells(map, spawn, (cell) => map.isWalkable(cell));
  assert.equal(initial.length, 18);
  assert.ok(initial.every(({ row }) => row >= 92 && row <= 94));
  for (const cell of [{ col: 10, row: 92 }, { col: 12, row: 92 }, center(93)]) {
    assert.equal(map.isWalkable(cell), true);
  }
  assert.equal(map.getCell(center(91)).terrain, "dirt");
  assert.equal(fewestDigs(map, spawn), 47);

  let digs = 0;
  for (let row = spawn.row - 1; row >= DEFENSE_TARGET.row; row -= 1) {
    const cell = center(row);
    if (map.isWalkable(cell)) continue;
    assert.equal(map.getCell(cell).terrain, "dirt");
    assert.equal(map.applyDigDamage(center(row + 1), cell, 5).cleared, true);
    digs += 1;
  }
  assert.equal(digs, 47);
  assert.equal(map.isGoal(DEFENSE_TARGET), true);
  assert.equal(fewestDigs(map, spawn), 0);
});

test("the defense corridor preserves the sealed gate and two validation branches", () => {
  const map = new TerrainMap(DEFENSE_LAYOUT);
  assert.equal(map.isWalkable(ENEMY_ENTRY), true);
  assert.equal(map.isGoal(DEFENSE_TARGET), true);
  assert.equal(fewestDigs(map, ENEMY_ENTRY), 1);
  for (let col = 0; col < map.columns; col += 1) {
    assert.equal(map.isWalkable({ col, row: gate.row }), false);
    assert.equal(map.isWalkable({ col, row: 87 }), col === 11);
  }
  assert.equal(map.getCell(gate).terrain, "dirt");
  assert.equal(map.getCell({ col: 12, row: 87 }).terrain, "dirt");
  for (const row of [86, 88, 90]) {
    for (const col of [10, 11, 12]) assert.equal(map.isWalkable({ col, row }), true);
  }
  assert.equal(map.isWalkable({ col: 12, row: ENEMY_ENTRY.row }), true);
  assert.equal(map.applyDigDamage(center(90), gate, 5).cleared, true);
  for (let row = ENEMY_ENTRY.row; row >= DEFENSE_TARGET.row; row -= 1) {
    assert.equal(map.isWalkable(center(row)), true);
  }
  assert.equal(fewestDigs(map, ENEMY_ENTRY), 0);
});

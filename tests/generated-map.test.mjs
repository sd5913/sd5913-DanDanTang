import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAP_SEED, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, GENERATED_SPAWN, generateExpeditionMap,
} from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";

function key(map, { col, row }) {
  return row * map.columns + col;
}

function neighbors(map, { col, row }) {
  return [{ col: col - 1, row }, { col: col + 1, row }, { col, row: row - 1 }, { col, row: row + 1 }]
    .filter((cell) => map.isInside(cell));
}

// Independent 0–1 BFS uses terrain only and charges one dig per dirt tile.
function distances(map, source, allowDigging) {
  const costs = new Map([[key(map, source), 0]]);
  const pending = [{ cell: source, cost: 0 }];
  while (pending.length > 0) {
    const { cell, cost } = pending.shift();
    if (cost !== costs.get(key(map, cell))) continue;
    for (const next of neighbors(map, cell)) {
      const terrain = map.getCell(next).terrain;
      if (terrain === "rock" || (!allowDigging && terrain === "dirt")) continue;
      const added = Number(terrain === "dirt");
      const nextCost = cost + added;
      if ((costs.get(key(map, next)) ?? Infinity) <= nextCost) continue;
      costs.set(key(map, next), nextCost);
      const entry = { cell: next, cost: nextCost };
      if (added) pending.push(entry);
      else pending.unshift(entry);
    }
  }
  return costs;
}

function regionCounts(map) {
  return [0, 32, 64].map((start) => {
    const counts = { dirt: 0, rock: 0, empty: 0 };
    for (let row = start; row < start + 32; row += 1) {
      for (let col = 0; col < map.columns; col += 1) counts[map.getCell({ col, row }).terrain] += 1;
    }
    return counts;
  });
}

test("seeded templates are reproducible, varied within each region, and use a safe default for invalid seeds", () => {
  const original = generateExpeditionMap();
  assert.deepEqual(generateExpeditionMap(DEFAULT_MAP_SEED), original);
  for (const invalid of [-1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    assert.deepEqual(generateExpeditionMap(invalid), original);
  }
  const other = generateExpeditionMap(12);
  assert.deepEqual(generateExpeditionMap(12), other);
  assert.notDeepEqual(generateExpeditionMap(13), other);
  for (const start of [0, 32, 64]) {
    assert.notDeepEqual(other.slice(start, start + 32), original.slice(start, start + 32));
  }
  const map = new TerrainMap(original);
  assert.deepEqual(regionCounts(map), [
    { dirt: 899, rock: 206, empty: 175 },
    { dirt: 880, rock: 238, empty: 162 },
    { dirt: 827, rock: 204, empty: 249 },
  ]);
});

test("sample seeds keep a buildable 8×8 home, isolated enemy and goal, and no ordinary 5×5 opening", () => {
  const seeds = [DEFAULT_MAP_SEED, ...Array.from({ length: 24 }, (_, i) => i), 555, 0xffff_ffff];
  const fingerprints = new Set();
  for (const seed of seeds) {
    const layout = generateExpeditionMap(seed);
    fingerprints.add(layout.join("\n"));
    const map = new TerrainMap(layout);
    assert.equal(map.columns, 40);
    assert.equal(map.rows, 96);
    assert.deepEqual(map.spawn, GENERATED_SPAWN);
    assert.ok(map.isGoal(GENERATED_GOAL));
    assert.ok(map.isWalkable(GENERATED_ENEMY_ENTRY));

    for (const counts of regionCounts(map)) {
      assert.equal(counts.dirt + counts.rock + counts.empty, 1_280);
      assert.ok(counts.rock >= 0.1 * 1_280 && counts.rock <= 0.23 * 1_280, `rock density, seed ${seed}`);
      assert.ok(counts.dirt > 0.6 * 1_280, `dirt progression, seed ${seed}`);
    }
    const openHome = distances(map, GENERATED_SPAWN, false);
    const entryPocket = distances(map, GENERATED_ENEMY_ENTRY, false);
    const goal = key(map, GENERATED_GOAL);
    assert.ok(openHome.size >= 64 && openHome.size <= 80);
    assert.equal(entryPocket.size, 8);
    assert.equal(openHome.has(key(map, GENERATED_ENEMY_ENTRY)), false);
    assert.equal(openHome.has(goal), false);
    assert.equal(entryPocket.has(goal), false);
    for (let row = 84; row <= 91; row += 1) {
      for (let col = 15; col <= 22; col += 1) assert.ok(openHome.has(key(map, { col, row })));
    }
    for (let row = 0; row <= 91; row += 1) {
      for (let col = 0; col <= 35; col += 1) {
        const start = { col, row };
        if (!map.isWalkable(start) || openHome.has(key(map, start))) continue;
        assert.ok(layout.slice(row, row + 5).some((line) => line.slice(col, col + 5).includes("+")
          || line.slice(col, col + 5).includes("#")), `ordinary 5×5 opening at ${col},${row} in seed ${seed}`);
      }
    }

    const playerDigs = distances(map, GENERATED_SPAWN, true).get(goal);
    const enemyDigs = distances(map, GENERATED_ENEMY_ENTRY, true).get(goal);
    assert.ok(Number.isFinite(playerDigs) && playerDigs >= 30, `player route, seed ${seed}: ${playerDigs}`);
    assert.ok(Number.isFinite(enemyDigs) && enemyDigs >= 30, `entry route, seed ${seed}: ${enemyDigs}`);
  }
  assert.equal(fingerprints.size, seeds.length);
});

test("seed 12 preserves the first excavation, both seams, and reset to the same starting topology", () => {
  const map = new TerrainMap(generateExpeditionMap(12));
  const fresh = new TerrainMap(generateExpeditionMap(12));
  const col = GENERATED_SPAWN.col;
  assert.equal(map.getCell({ col, row: 83 }).terrain, "dirt");
  const side = { col: 23, row: 88 };
  assert.equal(map.applyDigDamage({ col: 22, row: 88 }, side, 3).hp, 2);
  assert.equal(map.revision, 0);
  for (let row = GENERATED_SPAWN.row - 1; row >= GENERATED_GOAL.row; row -= 1) {
    const target = { col, row };
    if (map.isWalkable(target)) continue;
    assert.equal(map.applyDigDamage({ col, row: row + 1 }, target, 5).cleared, true);
  }
  for (const row of [63, 31]) {
    const cell = { col, row };
    const nextChunk = { col, row: row + 1 };
    assert.equal(map.worldToChunk(cell).local.row, 31);
    assert.equal(map.worldToChunk(nextChunk).local.row, 0);
    assert.ok(map.getWalkableNeighbors(cell).some((next) => next.col === col && next.row === nextChunk.row));
  }
  assert.equal(distances(map, GENERATED_SPAWN, false).get(key(map, GENERATED_GOAL)), 0);
  assert.equal(map.getCell(side).hp, 2);
  assert.equal(fresh.getCell(side).hp, 5);
  const beforeReset = map.revision;
  map.reset();
  assert.equal(map.revision, beforeReset + 1);
  for (let row = 0; row < map.rows; row += 1) {
    for (let col = 0; col < map.columns; col += 1) {
      assert.deepEqual(map.getCell({ col, row }), fresh.getCell({ col, row }));
    }
  }
});

test("40-column building coordinates do not alias the previous 24-column stride", () => {
  const layout = Array.from({ length: 32 }, (_, row) => row === 0 ? "S" + ".".repeat(39) : ".".repeat(40));
  const map = new TerrainMap(layout);
  const east = { col: 31, row: 5 };
  const west = { col: 7, row: 6 };
  const wall = map.placeBuilding("wall", east);
  const tower = map.placeBuilding("tower", west);
  assert.ok(wall && tower);
  assert.notEqual(wall.id, tower.id);
  assert.equal(map.getCell(east).buildingId, wall.id);
  assert.equal(map.getCell(west).buildingId, tower.id);
  assert.ok(map.removeBuilding(east));
  assert.equal(map.isWalkable(east), true);
  assert.equal(map.isWalkable(west), false);
});

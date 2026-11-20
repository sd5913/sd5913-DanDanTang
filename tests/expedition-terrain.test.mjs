import assert from "node:assert/strict";
import test from "node:test";
import { addExpeditionTiers, ADVANCED_TERRAIN_ROWS } from "../src/expedition-terrain.ts";
import { GENERATED_GOAL, generateExpeditionMap } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";

test("the expedition has two advanced seams and a route that upgraded tools can clear", () => {
  for (const seed of [0, 12, 42, 20261120, 0xffff_ffff]) {
    const original = generateExpeditionMap(seed);
    const map = new TerrainMap(addExpeditionTiers(original));
    for (const row of ADVANCED_TERRAIN_ROWS) {
      for (let col = 0; col < map.columns; col++) {
        const cell = map.getCell({ col, row });
        assert.ok(cell.terrain === "rock" || cell.terrainLevel === 2);
      }
    }
    for (let row = map.spawn.row - 1; row >= GENERATED_GOAL.row; row--) {
      const target = { col: map.spawn.col, row };
      const from = { col: map.spawn.col, row: row + 1 };
      if (map.isWalkable(target)) continue;
      if (ADVANCED_TERRAIN_ROWS.includes(row)) {
        assert.equal(map.getDigFailure(from, target, 1), "tool-level");
        assert.equal(map.getCell(target).hp, 8);
      }
      assert.equal(map.applyDigDamage(from, target, 8, 2).cleared, true);
    }
    assert.equal(map.isGoal(GENERATED_GOAL), true);
    assert.equal(map.isWalkable(GENERATED_GOAL), true);
  }
});

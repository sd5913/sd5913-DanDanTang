import assert from "node:assert/strict";
import test from "node:test";
import { BIOME_PROTOTYPE } from "../src/biome-effects.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { TerrainMap } from "../src/terrain.ts";

function mapWithBiomes(terrain, biomeAt) {
  const rows = Array.from({ length: 32 }, (_, row) => Array.from({ length: 12 }, (_, col) =>
    col === 1 && row === 1 ? "S" : terrain(col, row) ?? ".").join(""));
  const biomes = rows.map((line, row) => Array.from(line, (_, col) => biomeAt(col, row) ?? "ordinary"));
  return new TerrainMap(rows, { biomes });
}

test("biome persists through excavation and cross-biome synthesis uses the retained location", () => {
  const anchor = { col: 3, row: 5 };
  const map = mapWithBiomes(
    (col, row) => col === anchor.col && row === anchor.row ? "+" : undefined,
    (col, row) => row === 5 ? (col === 3 ? "plain" : "highland") : undefined,
  );
  assert.equal(map.getBiome(anchor), "plain");
  assert.equal(map.applyDigDamage({ col: 3, row: 6 }, anchor, 5).cleared, true);
  assert.equal(map.getBiome(anchor), "plain");
  const economy = new ExpeditionEconomy(map, 12, { col: 1, row: 2 });
  const first = economy.placeCard("economy", anchor);
  for (const col of [4, 5, 6]) map.placeBuilding("economy", { col, row: 5 });
  const merged = map.getBuilding(anchor);
  assert.equal(merged.id, first.id);
  assert.equal(merged.level, 2);
  assert.equal(map.getBiome(merged.cell), "plain");
  assert.equal(map.getBiome({ col: 4, row: 5 }), "highland");

  map.placeBuilding("economy", { col: 10, row: 5 });
  economy.advance(BIOME_PROTOTYPE.plainProductionMs - 1);
  assert.equal(economy.balance, ECONOMY_PROTOTYPE.initialBalance);
  economy.advance(1);
  assert.equal(economy.balance, ECONOMY_PROTOTYPE.initialBalance + 1);
  economy.advance(BIOME_PROTOTYPE.highlandProductionMs - BIOME_PROTOTYPE.plainProductionMs);
  assert.equal(economy.balance, ECONOMY_PROTOTYPE.initialBalance + 2);
});

test("a highland tower has greater range and keeps working independent of any viewport", () => {
  for (const biome of ["ordinary", "highland"]) {
    const map = mapWithBiomes(() => undefined, (col, row) => col === 7 && row === 1 ? biome : undefined);
    map.placeBuilding("tower", { col: 7, row: 1 });
    const simulation = new DefenseSimulation(map, map.spawn, { col: 1, row: 31 });
    simulation.spawn(1, 1);
    simulation.step(1);
    assert.equal(simulation.counters.towerKills, Number(biome === "highland"));
  }
});

test("water is impassable and cannot be mined; reset preserves the lake tag", () => {
  const water = { col: 2, row: 1 };
  const map = mapWithBiomes(
    (col, row) => col === water.col && row === water.row ? "~" : undefined,
    (col, row) => col === water.col && row === water.row ? "lake" : undefined,
  );
  assert.equal(map.getCell(water).terrain, "water");
  assert.equal(map.applyDigDamage(map.spawn, water, 100, 2).reason, "water");
  assert.equal(map.placeBuilding("wall", water), undefined);
  assert.equal(map.isWalkable(water), false);
  map.reset();
  assert.equal(map.getBiome(water), "lake");
});

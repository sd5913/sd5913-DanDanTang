import assert from "node:assert/strict";
import test from "node:test";
import { runTowerEvolutionComparison } from "./tower-evolution-comparison.mjs";

test("P0-I equal-cost tower comparison accounts for all 72 route, population and setup combinations", () => {
  const rows = runTowerEvolutionComparison();
  assert.equal(rows.length, 72);
  const routeNames = new Set(rows.map(({ route }) => route));
  assert.deepEqual([...routeNames], ["short-straight", "long-straight", "s-turns", "l-corner", "narrow-entry", "highland"]);
  for (const route of routeNames) {
    for (const population of ["normal", "armored-25", "dense"]) {
      const comparable = rows.filter((row) => row.route === route && row.population === population);
      assert.deepEqual(comparable.map(({ setup }) => setup), ["dispersed", "legacy", "piercing", "burst"]);
      for (const row of comparable) {
        assert.equal(row.budget, comparable[0].budget);
        assert.equal(row.technologySpend, comparable[0].technologySpend);
        assert.deepEqual(row.paid, comparable[0].paid);
        assert.equal(row.cardsUsed, 4);
        assert.equal(row.enemies, comparable[0].enemies);
        assert.equal(row.armored, population === "armored-25" ? row.enemies / 4 : 0);
        assert.deepEqual(row.retained.location, comparable[0].retained.location);
        assert.equal(row.laneTiles, comparable[0].laneTiles);
        assert.equal(row.availableTowerSites, comparable[0].availableTowerSites);
        assert.equal(row.kills + row.wallArrivals, row.enemies);
        assert.equal(row.killsWithSampledExposure + row.killsWithoutSampledExposure, row.kills);
        assert.ok(row.hitEnemies >= row.kills && row.hitEnemies <= row.enemies);
        assert.equal(row.hitEnemiesByKind.normal + row.hitEnemiesByKind.armored, row.hitEnemies);
        assert.equal(row.damageByKind.normal + row.damageByKind.armored, row.damage);
        assert.equal(row.overkillByKind.normal + row.overkillByKind.armored, row.overkill);
        assert.ok(row.coveredLaneTiles > 0 && row.coveredLaneTiles <= row.laneTiles);
        assert.equal(row.overkill + row.damage, row.rawDamage);
        assert.equal(row.wallArrivals, row.wallHpLost);
      }
    }
  }
  const crowded = rows.filter(({ population }) => population === "dense");
  assert.ok(crowded.some(({ setup, maxEnemiesPerAttack }) => setup === "piercing" && maxEnemiesPerAttack > 1));
  assert.ok(crowded.some(({ setup, maxEnemiesPerAttack }) => setup === "burst" && maxEnemiesPerAttack > 1));
  const result = (route, setup) => crowded.find((row) => row.route === route && row.setup === setup);
  assert.ok(result("long-straight", "piercing").kills > result("long-straight", "burst").kills);
  assert.ok(result("s-turns", "burst").kills > result("s-turns", "piercing").kills);
  assert.ok(result("highland", "piercing").coveredLaneTiles > result("long-straight", "piercing").coveredLaneTiles);
  assert.ok(result("highland", "piercing").availableTowerSites < result("long-straight", "piercing").availableTowerSites);
});

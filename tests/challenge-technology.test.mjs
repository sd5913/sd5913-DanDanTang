import assert from "node:assert/strict";
import test from "node:test";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { generateExpeditionMap } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";
import { WaveEconomyHistory } from "../src/wave-economy-history.ts";

const technology = { col: 18, row: 92 };
const replacement = { col: 20, row: 92 };

function fixture() {
  const map = new TerrainMap(generateExpeditionMap(12));
  return { map, economy: new ExpeditionEconomy(map, 12, undefined, "challenge") };
}

test("Challenge builds a single paid technology facility and failed construction costs nothing", () => {
  const { map, economy } = fixture();
  assert.equal(economy.technologyFailure, "insufficient-funds");
  assert.equal(economy.rebuildTechnology(), undefined);
  economy.creditMiningDamage(99);
  assert.equal(economy.buildTechnology(technology), undefined);
  assert.equal(economy.balance, 9.9);
  assert.equal(economy.totals.technologySpend, 0);

  economy.creditMiningDamage(1);
  assert.ok(map.placeBuilding("wall", replacement));
  assert.equal(economy.technologyFailure, undefined);
  assert.equal(economy.buildTechnology({ col: -1, row: 92 }), undefined);
  assert.equal(economy.buildTechnology(replacement), undefined);
  assert.equal(economy.balance, 10);
  assert.equal(economy.totals.technologySpend, 0);

  const built = economy.buildTechnology(technology);
  assert.equal(built.kind, "technology");
  assert.deepEqual(economy.technologyCell, technology);
  assert.equal(economy.hasTechnology, true);
  assert.equal(economy.balance, 0);
  assert.equal(economy.totals.technologySpend, 10);
  assert.equal(economy.totals.cardsMade, 0);
  assert.equal(economy.totals.cardSpend, 0);
  assert.deepEqual(economy.cards, { wall: 0, tower: 0, economy: 0 });

  economy.creditMiningDamage(100);
  assert.equal(economy.technologyFailure, "already-built");
  assert.equal(economy.buildTechnology({ col: 19, row: 91 }), undefined);
  assert.equal(economy.balance, 10);
  assert.equal([...map.getBuildings()].filter(({ kind }) => kind === "technology").length, 1);
});

test("paid relocation after damage preserves tool research and keeps wave spending exact", () => {
  const { map, economy } = fixture();
  const ledger = new WaveEconomyHistory(economy.totals);
  economy.creditMiningDamage(100);
  const original = economy.buildTechnology(technology);
  economy.creditMiningDamage(199);
  assert.equal(economy.researchTool(), false);
  assert.equal(economy.balance, 19.9);
  economy.creditMiningDamage(1);
  assert.equal(economy.researchTool(), true);
  assert.equal(economy.balance, 0);
  assert.equal(economy.toolLevel, 2);
  ledger.startWave(1, economy.totals);

  assert.equal(map.damageBuilding(technology, original.id, original.hp).destroyed, true);
  assert.equal(economy.technologyCell, undefined);
  assert.equal(economy.hasTechnology, false);
  assert.equal(economy.drawFailure, "technology-destroyed");
  assert.equal(economy.toolLevel, 2);
  economy.creditMiningDamage(103);
  assert.equal(economy.rebuildTechnology(), undefined);
  const rebuilt = economy.buildTechnology(replacement);
  assert.notEqual(rebuilt.id, original.id);
  assert.deepEqual(economy.technologyCell, replacement);
  assert.equal(economy.hasTechnology, true);
  assert.equal(economy.toolLevel, 2);
  assert.equal(economy.researchTool(), false);
  assert.equal(economy.balance, 0.3);
  assert.equal(economy.totals.technologySpend, 20);
  assert.equal(economy.totals.researchSpend, 20);
  assert.deepEqual(ledger.snapshot(economy.totals).map((wave) =>
    [wave.net, wave.miningIncome, wave.technologySpend, wave.researchSpend]), [
    [0, 30, 10, 20], [0.3, 10.3, 10, 0],
  ]);
});

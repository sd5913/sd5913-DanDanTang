import assert from "node:assert/strict";
import test from "node:test";
import { CARD_KINDS, ECONOMY_PROTOTYPE, ExpeditionEconomy, TECHNOLOGY_PROTOTYPE }
  from "../src/expedition-economy.ts";
import { generateExpeditionMap } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";

function createEconomy(technologyCell) {
  const seed = 12;
  const map = new TerrainMap(generateExpeditionMap(seed));
  return { map, economy: new ExpeditionEconomy(map, seed, technologyCell) };
}

function fundResearch(economy) {
  for (let enemyId = 1; economy.balance < TECHNOLOGY_PROTOTYPE.researchCost; enemyId += 1) {
    economy.handleEvent({ type: "towerKill", enemyId, towerId: "technology-test-tower" });
  }
}

function removeFacility(map, economy) {
  const facility = map.getBuilding(economy.technologyCell);
  assert.ok(facility);
  assert.equal(map.removeBuilding(economy.technologyCell, facility.id)?.id, facility.id);
  return facility;
}

test("tool research requires funds and charges the exact prototype cost only once", () => {
  const { map, economy } = createEconomy();
  assert.equal(TECHNOLOGY_PROTOTYPE.researchCost, 10);
  assert.equal(economy.toolLevel, 1);
  assert.equal(economy.researchTool(), false);
  assert.equal(economy.balance, ECONOMY_PROTOTYPE.initialBalance);

  fundResearch(economy);
  const balance = economy.balance;
  const revision = map.revision;
  assert.equal(economy.researchTool(), true);
  assert.equal(economy.balance, balance - 10);
  assert.equal(economy.toolLevel, 2);
  assert.equal(map.revision, revision, "Research must not change map topology");

  fundResearch(economy);
  const secondBalance = economy.balance;
  assert.equal(economy.researchTool(), false);
  assert.equal(economy.balance, secondBalance);
  assert.equal(economy.toolLevel, 2);
});

test("a missing facility blocks new research and card draws until it is rebuilt", () => {
  const { map, economy } = createEconomy();
  fundResearch(economy);
  const balance = economy.balance;
  const old = removeFacility(map, economy);
  assert.equal(economy.hasTechnology, false);
  assert.equal(economy.researchTool(), false);
  assert.equal(economy.drawCard(), undefined);
  assert.equal(economy.balance, balance);
  assert.equal(economy.toolLevel, 1);

  const rebuilt = economy.rebuildTechnology();
  assert.equal(rebuilt?.kind, "technology");
  assert.notEqual(rebuilt.id, old.id);
  assert.deepEqual(rebuilt.cell, economy.technologyCell);
  assert.equal(rebuilt.hp, ECONOMY_PROTOTYPE.buildingHp.technology);
  assert.equal(economy.hasTechnology, true);
  assert.equal(economy.balance, balance, "Rebuilding the reserved site is free in the prototype");
  assert.equal(economy.researchTool(), true);
});

test("upgraded tools persist after facility loss and rebuild in the same round", () => {
  const { map, economy } = createEconomy();
  fundResearch(economy);
  assert.equal(economy.researchTool(), true);
  assert.equal(economy.balance, 0);
  const old = removeFacility(map, economy);
  assert.equal(economy.hasTechnology, false);
  assert.equal(economy.toolLevel, 2);

  const rebuilt = economy.rebuildTechnology();
  assert.ok(rebuilt);
  assert.equal(map.removeBuilding(economy.technologyCell, old.id), undefined);
  assert.equal(map.getBuilding(economy.technologyCell), rebuilt);
  assert.equal(economy.toolLevel, 2);
  assert.equal(economy.balance, 0);
  assert.equal(economy.researchTool(), false);
  assert.equal(economy.rebuildTechnology(), undefined);
});

test("the original site stays reserved for free rebuilds and existing occupancy is respected", () => {
  const site = { col: 18, row: 90 };
  const { map, economy } = createEconomy(site);
  site.col = 20;
  assert.deepEqual(economy.technologyCell, { col: 18, row: 90 });
  assert.ok(Object.isFrozen(economy.technologyCell));
  removeFacility(map, economy);
  const cards = economy.cards;

  for (const kind of CARD_KINDS) assert.equal(economy.placeCard(kind, economy.technologyCell), undefined);
  assert.equal(map.getBuilding(economy.technologyCell), undefined);
  assert.equal(economy.cards, cards, "A rejected card placement must leave inventory intact");

  const blocker = map.placeBuilding("tower", economy.technologyCell);
  assert.ok(blocker);
  assert.equal(economy.rebuildTechnology(), undefined);
  assert.equal(map.getBuilding(economy.technologyCell), blocker);
  assert.equal(map.removeBuilding(economy.technologyCell, blocker.id), blocker);
  assert.deepEqual(economy.rebuildTechnology()?.cell, { col: 18, row: 90 });
});

test("a full round reset restores tool level one and restocks the original facility", () => {
  const { map, economy } = createEconomy();
  fundResearch(economy);
  assert.equal(economy.researchTool(), true);
  removeFacility(map, economy);

  map.reset();
  economy.reset();
  assert.equal(economy.toolLevel, 1);
  assert.equal(economy.hasTechnology, true);
  assert.equal(economy.balance, ECONOMY_PROTOTYPE.initialBalance);
  assert.deepEqual(economy.cards, ECONOMY_PROTOTYPE.initialCards);
  assert.equal(map.getBuilding(economy.technologyCell)?.hp, ECONOMY_PROTOTYPE.buildingHp.technology);
  fundResearch(economy);
  assert.equal(economy.researchTool(), true, "Research is available again in the new round");
});

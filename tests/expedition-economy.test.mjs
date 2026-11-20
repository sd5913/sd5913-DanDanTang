import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_LAYOUT, DEFENSE_TARGET, ENEMY_ENTRY } from "../src/defense-map.ts";
import { DEFENSE_CONFIG, DefenseSimulation } from "../src/defense-simulation.ts";
import { CARD_KINDS, ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { generateExpeditionMap } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";
import { WaveEconomyHistory } from "../src/wave-economy-history.ts";

const cell = (col, row) => ({ col, row });
const technology = cell(22, 30);
const dirt = cell(3, 3);
const { initialBalance, initialCards, buildingHp, drawCost, productionIntervalMs, productionAmount, towerKillReward } = ECONOMY_PROTOTYPE;

function createEconomy(seed = 12) {
  const layout = Array.from({ length: 32 }, (_, row) => Array.from({ length: 24 }, (_, col) => {
    if (col === 0 || col === 23 || row === 0 || row === 31) return "#";
    if (col === 1 && row === 1) return "S";
    if (col === dirt.col && row === dirt.row) return "+";
    return ".";
  }).join(""));
  const map = new TerrainMap(layout);
  return { map, economy: new ExpeditionEconomy(map, seed, technology) };
}

function towerKill(enemyId, towerId = "tower") {
  return { type: "towerKill", enemyId, towerId };
}

function drawSequence(economy, count) {
  const cards = [];
  let enemyId = 100;
  for (let draw = 0; draw < count; draw += 1) {
    while (economy.balance < drawCost) economy.handleEvent(towerKill(enemyId++));
    const card = economy.drawCard();
    assert.ok(CARD_KINDS.includes(card));
    cards.push(card);
  }
  return cards;
}

test("the default wide map starts with deterministic inventory and a working technology facility", () => {
  const seed = 12;
  const map = new TerrainMap(generateExpeditionMap(seed));
  const economy = new ExpeditionEconomy(map, seed);
  assert.equal(economy.balance, 8);
  assert.deepEqual(economy.cards, { wall: 4, tower: 2, economy: 1 });
  assert.ok(Object.isFrozen(economy.cards));
  assert.equal(economy.hasTechnology, true);
  const tech = map.getBuilding(ECONOMY_PROTOTYPE.technologyCell);
  assert.equal(tech.kind, "technology");
  assert.equal(tech.hp, 10);
  assert.equal(map.isWalkable(tech.cell), false);
  assert.throws(() => new ExpeditionEconomy(map, seed, cell(0, 0)), /technology facility at \(0, 0\)/);
});

test("only genuine tower kills award currency and each enemy awards it once per round", () => {
  const { economy } = createEconomy();
  const ignored = [
    { type: "towerShot", enemyId: 1, towerId: "tower", from: cell(1, 1), to: { x: 1, y: 1 } },
    { type: "wallImpact", enemyId: 1, wallId: "wall", damage: 1, hp: 0, destroyed: true },
    { type: "playerContact", enemyId: 2, target: cell(2, 2) },
    { type: "buildingContact", enemyId: 3, target: cell(3, 3) },
    { type: "targetSelected", enemyId: 4, target: { kind: "building", cell: cell(4, 4) } },
  ];
  for (const event of ignored) economy.handleEvent(event);
  assert.equal(economy.balance, initialBalance);
  economy.handleEvent(towerKill(5));
  economy.handleEvent(towerKill(5, "another-tower"));
  economy.handleEvent(towerKill(6));
  assert.equal(economy.balance, initialBalance + 2 * towerKillReward);
  assert.deepEqual(economy.cards, initialCards);
});

test("live wall collisions pay nothing while a real automatic tower kill pays once", () => {
  const map = new TerrainMap(DEFENSE_LAYOUT);
  const economy = new ExpeditionEconomy(map, 12, cell(9, 93));
  const events = [];
  const simulation = new DefenseSimulation(map, ENEMY_ENTRY, DEFENSE_TARGET, (event) => {
    events.push(event);
    economy.handleEvent(event);
  });
  assert.equal(map.applyDigDamage(cell(11, 90), cell(11, 89), 5).cleared, true);
  assert.ok(map.placeBuilding("wall", cell(11, 87), 1));
  simulation.spawn(1, 1);
  simulation.step(DEFENSE_CONFIG.travelMs * 8);
  assert.equal(simulation.counters.wallImpacts, 1);
  assert.equal(economy.balance, initialBalance);

  assert.ok(economy.placeCard("tower", cell(12, 94)));
  simulation.spawn(1, 1);
  simulation.step(1);
  assert.equal(simulation.counters.towerKills, 1);
  assert.equal(events.filter((event) => event.type === "towerKill").length, 1);
  assert.equal(economy.balance, initialBalance + towerKillReward);
});

test("drawing needs a facility and currency, spends three once, and credits exactly one card", () => {
  const { map, economy } = createEconomy();
  const control = createEconomy().economy;
  assert.equal(economy.drawFailure, undefined);
  assert.ok(map.removeBuilding(technology));
  assert.equal(economy.hasTechnology, false);
  assert.equal(economy.drawFailure, "technology-destroyed");
  assert.equal(economy.drawCard(), undefined);
  assert.equal(economy.balance, initialBalance);
  assert.deepEqual(economy.cards, initialCards);
  assert.ok(map.placeBuilding("technology", technology, buildingHp.technology));

  const expectedCards = { ...initialCards };
  for (const remaining of [5, 2]) {
    const drawn = economy.drawCard();
    assert.equal(drawn, control.drawCard(), "a rejected draw must not advance the seeded stream");
    expectedCards[drawn] += 1;
    assert.equal(economy.balance, remaining);
    assert.deepEqual(economy.cards, expectedCards);
  }
  assert.equal(economy.drawFailure, "insufficient-funds");
  assert.equal(economy.drawCard(), undefined);
  assert.equal(economy.balance, 2);
  assert.deepEqual(economy.cards, expectedCards);
  economy.handleEvent(towerKill(10));
  control.handleEvent(towerKill(10));
  assert.equal(economy.drawFailure, undefined);
  assert.equal(economy.drawCard(), control.drawCard(), "a rejected draw for funds must not advance the seeded stream");
});

test("the card sequence is deterministic from its own seed and includes each configured kind", () => {
  assert.deepEqual(ECONOMY_PROTOTYPE.drawWeights, { wall: 1, tower: 1, economy: 1 });
  const first = createEconomy(12).economy;
  const sequence = drawSequence(first, 24);
  // Generating unrelated worlds must not advance the draw stream.
  generateExpeditionMap(13);
  generateExpeditionMap(20261120);
  assert.deepEqual(drawSequence(createEconomy(12).economy, 24), sequence);
  assert.notDeepEqual(drawSequence(createEconomy(13).economy, 24), sequence);
  assert.deepEqual(new Set(sequence), new Set(CARD_KINDS));
});

test("only legal placements use a card, and the fourth wall still uses one card when it merges", () => {
  const { map, economy } = createEconomy();
  for (const invalid of [dirt, cell(0, 0), technology, cell(24, 3), cell(3.5, 3)]) {
    assert.equal(economy.placeCard("wall", invalid), undefined);
    assert.deepEqual(economy.cards, initialCards);
  }
  assert.equal(economy.placeCard("technology", cell(7, 6)), undefined);
  assert.equal(map.applyDigDamage(cell(3, 4), dirt, 5).cleared, true);
  assert.equal(economy.balance, initialBalance, "dirt clearance has no payout");

  const oldest = economy.placeCard("wall", dirt);
  assert.equal(oldest.hp, buildingHp.wall);
  assert.equal(economy.placeCard("tower", dirt), undefined);
  assert.equal(economy.cards.tower, initialCards.tower);
  for (const col of [4, 5, 6]) {
    const placed = economy.placeCard("wall", cell(col, 3));
    assert.equal(placed.level, col === 6 ? 2 : 1);
    if (col === 6) assert.equal(placed.id, oldest.id);
  }
  assert.equal(economy.cards.wall, 0);
  assert.equal(economy.placeCard("wall", cell(7, 3)), undefined);
  assert.deepEqual([4, 5, 6, 7].map((col) => map.isWalkable(cell(col, 3))), [true, true, true, true]);
  assert.equal(economy.balance, initialBalance);
});

test("production accrues only after placement and counts all completed independent offscreen intervals", () => {
  const { map, economy } = createEconomy();
  economy.advance(productionIntervalMs * 10);
  const producer = economy.placeCard("economy", cell(6, 8));
  assert.equal(producer.hp, buildingHp.economy);
  assert.equal(economy.cards.economy, 0);
  economy.advance(productionIntervalMs - 1);
  for (const invalid of [0, -1000, Infinity, NaN]) economy.advance(invalid);
  assert.equal(economy.balance, initialBalance);
  economy.advance(1);
  assert.equal(economy.balance, initialBalance + productionAmount);
  const later = map.placeBuilding("economy", cell(20, 28), buildingHp.economy);
  economy.advance(productionIntervalMs * 2 + 500);
  assert.equal(economy.balance, initialBalance + 5 * productionAmount);
  assert.ok(map.removeBuilding(later.cell, later.id));
  economy.advance(productionIntervalMs - 500);
  assert.equal(economy.balance, initialBalance + 6 * productionAmount);
});

test("merging producers keeps the incumbent's stable production timer and releases consumed timers", () => {
  const { map, economy } = createEconomy();
  const oldest = map.placeBuilding("economy", cell(5, 5), buildingHp.economy);
  economy.advance(productionIntervalMs - 1000);
  for (const col of [6, 7]) assert.ok(map.placeBuilding("economy", cell(col, 5), buildingHp.economy));
  economy.advance(999);
  const upgraded = economy.placeCard("economy", cell(8, 5));
  assert.equal(upgraded.id, oldest.id);
  assert.equal(upgraded.level, 2);
  assert.equal(economy.cards.economy, 0);
  assert.equal(economy.balance, initialBalance);
  economy.advance(1);
  assert.equal(economy.balance, initialBalance + productionAmount);
  economy.advance(3000);
  assert.equal(economy.balance, initialBalance + productionAmount, "consumed producers cannot pay");
  economy.advance(1000);
  assert.equal(economy.balance, initialBalance + 2 * productionAmount);
});

test("reset restores cards, balance, draw stream, and a fresh facility after map reset", () => {
  const { map, economy } = createEconomy();
  const oldTechnologyId = map.getBuilding(technology).id;
  assert.ok(economy.placeCard("economy", cell(6, 8)));
  economy.advance(productionIntervalMs + 1);
  economy.handleEvent(towerKill(1));
  const firstDraw = economy.drawCard();
  assert.ok(map.removeBuilding(technology));
  assert.equal(economy.hasTechnology, false);

  map.reset();
  economy.reset();
  assert.equal(economy.hasTechnology, true);
  assert.notEqual(map.getBuilding(technology).id, oldTechnologyId);
  assert.equal(economy.balance, initialBalance);
  assert.deepEqual(economy.cards, initialCards);
  economy.advance(productionIntervalMs * 5);
  assert.equal(economy.balance, initialBalance, "pre-reset producers cannot pay again");
  assert.equal(economy.drawCard(), firstDraw);
  economy.handleEvent(towerKill(1));
  assert.equal(economy.balance, initialBalance - drawCost + towerKillReward);
});


test("wave accounting separates elapsed income from its originating combat cohort", () => {
  const { map, economy } = createEconomy();
  const history = new WaveEconomyHistory(economy.totals);
  assert.ok(economy.placeCard("economy", cell(4, 4)));
  economy.advance(2 * productionIntervalMs);
  history.startWave(1, economy.totals);
  assert.equal(economy.researchTool(), true);
  assert.equal(economy.drawCard(), undefined);

  history.creditKill(1, economy.handleEvent(towerKill(5)));
  history.creditKill(1, economy.handleEvent(towerKill(5, "duplicate")));
  history.startWave(2, economy.totals);
  history.creditKill(1, economy.handleEvent(towerKill(6)));
  economy.advance(productionIntervalMs);
  assert.ok(economy.drawCard());
  assert.deepEqual(economy.totals, {
    balance: 2, killIncome: 4, productionIncome: 3, cardsMade: 1, cardSpend: 3, researchSpend: 10,
  });
  assert.deepEqual(history.snapshot(economy.totals), [
    { waveId: 0, openingBalance: 8, balance: 10, net: 2, cohortKillIncome: 0,
      killIncome: 0, productionIncome: 2, cardsMade: 0, cardSpend: 0, researchSpend: 0 },
    { waveId: 1, openingBalance: 10, balance: 2, net: -8, cohortKillIncome: 4,
      killIncome: 2, productionIncome: 0, cardsMade: 0, cardSpend: 0, researchSpend: 10 },
    { waveId: 2, openingBalance: 2, balance: 2, net: 0, cohortKillIncome: 0,
      killIncome: 2, productionIncome: 1, cardsMade: 1, cardSpend: 3, researchSpend: 0 },
  ]);

  map.reset();
  economy.reset();
  history.reset(economy.totals);
  assert.equal(economy.balance, initialBalance);
  assert.deepEqual(history.snapshot(economy.totals), [
    { waveId: 0, openingBalance: 8, balance: 8, net: 0, cohortKillIncome: 0,
      killIncome: 0, productionIncome: 0, cardsMade: 0, cardSpend: 0, researchSpend: 0 },
  ]);
});

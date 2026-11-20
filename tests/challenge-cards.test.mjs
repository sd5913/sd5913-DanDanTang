import assert from "node:assert/strict";
import test from "node:test";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { CHUNK_ROWS, TerrainMap } from "../src/terrain.ts";

const technology = { col: 20, row: 20 };
const wallSite = { col: 3, row: 1 };
const { drawCost } = ECONOMY_PROTOTYPE;
const columns = 24;
const veinWidth = columns - 2;

function fixture(seed, difficulty = "challenge") {
  const layout = Array.from({ length: CHUNK_ROWS }, (_, row) => {
    if (row === 1) return "..S" + ".".repeat(columns - 3);
    if (row >= 2 && row <= 12 && row % 2 === 0) return "." + "+".repeat(veinWidth) + ".";
    return ".".repeat(columns);
  });
  const map = new TerrainMap(layout);
  const economy = new ExpeditionEconomy(map, seed, technology, difficulty);
  let minedTiles = 0;

  function mine(tiles) {
    for (let i = 0; i < tiles; i += 1) {
      const col = 1 + minedTiles % veinWidth;
      const row = 2 + 2 * Math.floor(minedTiles / veinWidth);
      const result = map.applyDigDamage({ col, row: row - 1 }, { col, row }, 5);
      assert.equal(result.cleared, true);
      assert.equal(economy.creditMiningDamage(result.damage), 0.5);
      minedTiles += 1;
    }
  }

  function payAndDraw() {
    mine(drawCost / 0.5);
    const card = economy.drawCard();
    assert.ok(card);
    return card;
  }

  function buyTechnology() {
    mine(economy.technologyBuildCost / 0.5);
    assert.ok(economy.buildTechnology(technology));
  }

  function reset() {
    map.reset();
    economy.reset();
    minedTiles = 0;
  }

  return { map, economy, mine, buyTechnology, payAndDraw, reset };
}

test("Challenge can force either defense on the third paid draw and resumes the ordinary sequence", () => {
  for (const [seed, guarantee] of [[1091, "tower"], [1092, "wall"]]) {
    const { economy, buyTechnology, payAndDraw } = fixture(seed);
    assert.equal(economy.balance, 0);
    assert.deepEqual(economy.cards, { wall: 0, tower: 0, economy: 0 });
    buyTechnology();

    for (const [index, expected] of ["economy", "economy", guarantee, "economy", "tower"].entries()) {
      assert.equal(payAndDraw(), expected);
      assert.equal(economy.balance, 0);
      assert.equal(economy.totals.cardSpend, (index + 1) * drawCost);
      assert.equal(economy.totals.cardsMade, index + 1);
      assert.equal(Object.values(economy.cards).reduce((sum, count) => sum + count, 0), index + 1);
    }
  }
});

test("insufficient funds or absent or destroyed technology cannot advance the guaranteed draw", () => {
  const { map, economy, mine, buyTechnology, payAndDraw } = fixture(1091);
  const control = fixture(1091);
  const actual = [];
  assert.equal(economy.drawFailure, "technology-missing");
  assert.equal(economy.drawCard(), undefined);
  buyTechnology();
  assert.equal(economy.drawFailure, "insufficient-funds");
  assert.equal(economy.drawCard(), undefined);
  actual.push(payAndDraw(), payAndDraw());

  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(economy.drawCard(), undefined);
  mine(6);
  assert.ok(map.removeBuilding(technology));
  assert.equal(economy.drawFailure, "technology-destroyed");
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(economy.drawCard(), undefined);
  assert.deepEqual(economy.cards, { wall: 0, tower: 0, economy: 2 });
  assert.equal(economy.balance, 3);
  assert.equal(economy.totals.cardSpend, 6);
  assert.equal(economy.totals.cardsMade, 2);
  assert.equal(economy.rebuildTechnology(), undefined);
  buyTechnology();
  actual.push(economy.drawCard(), payAndDraw(), payAndDraw());

  assert.equal(actual[2], "tower");
  control.buyTechnology();
  assert.deepEqual(actual, Array.from({ length: 5 }, control.payAndDraw));
});

test("placing an earlier defense still qualifies as having drawn defense", () => {
  const { economy, buyTechnology, payAndDraw } = fixture(14);
  buyTechnology();
  assert.equal(payAndDraw(), "wall");
  assert.ok(economy.placeCard("wall", wallSite));
  assert.equal(economy.cards.wall, 0);
  assert.deepEqual(Array.from({ length: 3 }, payAndDraw), ["economy", "economy", "wall"]);
});

test("restarting restores the guarantee and regular draws for the same seed", () => {
  const round = fixture(1092);
  const drawFive = () => {
    round.buyTechnology();
    return Array.from({ length: 5 }, round.payAndDraw);
  };
  const expected = ["economy", "economy", "wall", "economy", "tower"];
  assert.deepEqual(drawFive(), expected);
  round.reset();
  assert.equal(round.economy.hasTechnology, false);
  assert.equal(round.economy.totals.cardsMade, 0);
  assert.deepEqual(round.economy.cards, { wall: 0, tower: 0, economy: 0 });
  assert.deepEqual(drawFive(), expected);
});

test("each sampled Challenge seed draws legal defense within three purchases", () => {
  const seeds = [0, 1, 12, 1090, 1091, 1092, 1096, 1117, 1122, 20_261_120, 0xffff_ffff];
  for (const seed of seeds) {
    const { economy, buyTechnology, payAndDraw } = fixture(seed);
    buyTechnology();
    const cards = Array.from({ length: 3 }, payAndDraw);
    assert.ok(cards.some((card) => card === "wall" || card === "tower"), "seed " + seed);
    assert.ok(cards.every((card) => card === "economy" || card === "wall" || card === "tower"));
    assert.equal(economy.balance, 0);
    assert.equal(economy.totals.cardSpend, 3 * drawCost);
  }
});

test("research is still a direct technology purchase and does not count as a card draw", () => {
  const { economy, mine, buyTechnology, payAndDraw } = fixture(1091);
  buyTechnology();
  mine(39);
  assert.equal(economy.researchTool(), false);
  mine(1);
  assert.equal(economy.researchTool(), true);
  assert.equal(economy.toolLevel, 2);
  assert.equal(economy.balance, 0);
  assert.equal(economy.totals.researchSpend, 20);
  assert.equal(economy.totals.technologySpend, 10);
  assert.equal(economy.totals.cardsMade, 0);
  assert.deepEqual(Array.from({ length: 3 }, payAndDraw), ["economy", "economy", "tower"]);
});

test("Baseline, A and B keep the unchanged draw stream on seeds with three economy cards", () => {
  for (const difficulty of ["baseline", "a", "b"]) {
    const { economy } = fixture(1091, difficulty);
    let enemyId = 0;
    const cards = Array.from({ length: 5 }, () => {
      while (economy.balance < drawCost) {
        economy.handleEvent({ type: "towerKill", enemyId: ++enemyId, towerId: "test-tower" });
      }
      return economy.drawCard();
    });
    assert.deepEqual(cards, ["economy", "economy", "economy", "economy", "tower"]);
  }
});

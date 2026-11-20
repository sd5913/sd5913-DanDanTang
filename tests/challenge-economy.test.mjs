import assert from "node:assert/strict";
import test from "node:test";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { MiningSession } from "../src/mining.ts";
import { CHUNK_ROWS, TerrainMap } from "../src/terrain.ts";
import { WaveEconomyHistory } from "../src/wave-economy-history.ts";

const cell = (col, row) => ({ col, row });
const origin = cell(5, 5);
const dirt = cell(5, 4);
const empty = cell(6, 5);
const rock = cell(4, 5);
const water = cell(5, 6);
const hardDirt = cell(6, 6);
const technology = cell(20, 20);

function fixture(difficulty = "challenge") {
  const tiles = Array.from({ length: CHUNK_ROWS }, () => Array(24).fill("."));
  tiles[origin.row][origin.col] = "S";
  tiles[dirt.row][dirt.col] = "+";
  tiles[rock.row][rock.col] = "#";
  tiles[water.row][water.col] = "~";
  tiles[hardDirt.row][hardDirt.col] = "2";
  for (let col = 2; col <= 7; col += 1) tiles[10][col] = "+";
  for (let col = 1; col <= 20; col += 1) tiles[12][col] = "+";
  const map = new TerrainMap(tiles.map((row) => row.join("")));
  const economy = new ExpeditionEconomy(map, 12, technology, difficulty);
  const credit = (strike) => economy.creditMiningDamage(strike?.result.damage ?? 0);
  return { map, economy, credit };
}

test("Challenge only credits legal damage and never pays again for emptied terrain", () => {
  const { map, economy, credit } = fixture();
  const mining = new MiningSession(map);
  for (const [from, target, reason] of [
    [origin, rock, "rock"], [origin, water, "water"], [origin, empty, "empty"],
    [origin, hardDirt, "out-of-reach"], [empty, hardDirt, "tool-level"],
    [origin, cell(-1, 5), "out-of-bounds"],
  ]) {
    const rejected = mining.begin(from, target, 0);
    assert.equal(rejected.result.reason, reason);
    assert.equal(credit(rejected), 0);
  }
  assert.equal(economy.balance, 0);
  assert.equal(economy.totals.miningIncome, 0);
  assert.equal(credit(mining.begin(origin, dirt, 0)), 0.1);
  assert.equal(map.getCell(dirt).hp, 4);
  assert.equal(credit(mining.update(origin, 500)), 0.4, "catch-up pays all four effective strikes");
  assert.equal(map.getCell(dirt).terrain, "empty");
  assert.equal(credit(mining.begin(origin, dirt, 625)), 0);
  assert.equal(economy.balance, 0.5);
  assert.equal(economy.totals.miningIncome, 0.5);
});

test("interruptions preserve HP and cooldown; total coin credit is independent of damage and speed", () => {
  for (const [tool, finishAt] of [
    [{ damage: 1, attackIntervalMs: 125 }, 500],
    [{ damage: 2, attackIntervalMs: 70 }, 140],
    [{ damage: 4, attackIntervalMs: 240 }, 240],
  ]) {
    const { map, economy, credit } = fixture();
    const mining = new MiningSession(map, tool);
    assert.equal(credit(mining.begin(origin, dirt, 0)), tool.damage / 10);
    mining.stop();
    assert.equal(credit(mining.update(origin, 1)), 0);
    assert.equal(map.getCell(dirt).hp, 5 - tool.damage);
    assert.equal(credit(mining.begin(origin, dirt, tool.attackIntervalMs - 1)), 0);
    assert.equal(credit(mining.update(origin, finishAt)), (5 - tool.damage) / 10);
    assert.equal(map.getCell(dirt).hp, 0);
    assert.equal(economy.balance, 0.5);
    assert.equal(economy.totals.miningIncome, 0.5);
  }
});

test("after buying technology, exactly 30 more mined HP can pay for the first card", () => {
  const { map, economy, credit } = fixture();
  for (let col = 1; col <= 20; col += 1) {
    const result = map.applyDigDamage(cell(col, 13), cell(col, 12), 5);
    assert.equal(economy.creditMiningDamage(result.damage), 0.5);
  }
  assert.equal(economy.balance, 10);
  assert.equal(economy.drawFailure, "technology-missing");
  assert.ok(economy.buildTechnology(technology));
  const mining = new MiningSession(map);
  let time = 0;
  for (let col = 2; col <= 7; col += 1) {
    const from = cell(col, 11);
    const target = cell(col, 10);
    assert.equal(credit(mining.begin(from, target, time)), 0.1);
    assert.equal(credit(mining.update(from, time + 375)), 0.3);
    if (col === 7) {
      assert.equal(economy.balance, 2.9);
      assert.equal(economy.drawFailure, "insufficient-funds");
      assert.equal(economy.drawCard(), undefined);
    }
    assert.equal(credit(mining.update(from, time + 500)), 0.1);
    time += 625;
  }
  assert.equal(economy.balance, 3);
  assert.ok(economy.drawCard());
  assert.equal(economy.balance, 0);
  assert.equal(economy.totals.miningIncome, 13);
  assert.equal(economy.totals.technologySpend, 10);
  assert.equal(economy.totals.cardSpend, 3);
  assert.equal(economy.totals.cardsMade, 1);
});

test("the wave ledger subtracts tenths exactly and preserves unrelated income attribution", () => {
  const { map, economy, credit } = fixture();
  const history = new WaveEconomyHistory(economy.totals);
  const mining = new MiningSession(map);
  credit(mining.begin(origin, dirt, 0));
  credit(mining.update(origin, 125));
  history.startWave(1, economy.totals);
  credit(mining.update(origin, 250));
  assert.deepEqual(history.snapshot(economy.totals).map((wave) =>
    [wave.openingBalance, wave.balance, wave.net, wave.miningIncome]), [
    [0, 0.2, 0.2, 0.2], [0.2, 0.3, 0.1, 0.1],
  ]);

  const towerKill = { type: "towerKill", enemyId: 42, towerId: "test-tower" };
  history.creditKill(1, economy.handleEvent(towerKill));
  history.creditKill(1, economy.handleEvent(towerKill));
  assert.ok(map.placeBuilding("economy", empty, 6));
  economy.advance(ECONOMY_PROTOTYPE.productionIntervalMs);
  assert.deepEqual(history.snapshot(economy.totals)[1], {
    waveId: 1, openingBalance: 0.2, balance: 3.3, net: 3.1,
    cohortKillIncome: 2, killIncome: 2, productionIncome: 1,
    cardsMade: 0, cardSpend: 0, researchSpend: 0, miningIncome: 0.1, technologySpend: 0,
  });
});

test("Challenge counts tenths exactly across repeated credits and clears economy with terrain on R", () => {
  const { map, economy, credit } = fixture();
  const mining = new MiningSession(map);
  const history = new WaveEconomyHistory(economy.totals);
  assert.equal(credit(mining.begin(origin, dirt, 0)), 0.1);
  for (let i = 0; i < 1002; i += 1) economy.creditMiningDamage(1);
  for (const invalidDamage of [0, -1, NaN, Infinity, 0.5]) {
    assert.equal(economy.creditMiningDamage(invalidDamage), 0);
  }
  assert.equal(economy.balance, 100.3);
  assert.equal(economy.totals.miningIncome, 100.3);
  assert.equal(map.getCell(dirt).hp, 4);

  map.reset();
  mining.reset();
  economy.reset();
  history.reset(economy.totals);
  assert.equal(map.getCell(dirt).hp, 5);
  assert.equal(economy.balance, 0);
  assert.equal(economy.totals.miningIncome, 0);
  assert.equal(history.snapshot(economy.totals)[0].miningIncome, 0);
  assert.equal(economy.hasTechnology, false);
  assert.equal(credit(mining.begin(origin, dirt, 0)), 0.1);
});

test("Baseline, A and B still mine without income or a new ledger field", () => {
  for (const difficulty of ["baseline", "a", "b"]) {
    const { map, economy, credit } = fixture(difficulty);
    const mining = new MiningSession(map, { damage: 10, attackIntervalMs: 125 });
    const history = new WaveEconomyHistory(economy.totals);
    const strike = mining.begin(origin, dirt, 0);
    assert.equal(strike.result.damage, 5);
    assert.equal(strike.result.cleared, true);
    assert.equal(credit(strike), 0);
    assert.equal(economy.balance, 8);
    assert.equal(Object.hasOwn(economy.totals, "miningIncome"), false);
    assert.equal(Object.hasOwn(economy.totals, "technologySpend"), false);
    assert.equal(Object.hasOwn(history.snapshot(economy.totals)[0], "miningIncome"), false);
    assert.equal(Object.hasOwn(history.snapshot(economy.totals)[0], "technologySpend"), false);
  }
});

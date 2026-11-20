import assert from "node:assert/strict";
import test from "node:test";
import { buildingMaxHp, productionAttributes, towerAttributes } from "../src/building-balance.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { EnemyNavigation } from "../src/enemy-navigation.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { TerrainMap } from "../src/terrain.ts";
import { runBuildingGrowthComparison } from "./building-growth-comparison.mjs";

const cell = (col, row) => ({ col, row });
const spawn = cell(2, 2);

function mapWithCells(open, buildingBalance = "w25", highland) {
  const layout = Array.from({ length: 32 }, () => Array(24).fill("#"));
  for (const { col, row } of open) layout[row][col] = ".";
  layout[spawn.row][spawn.col] = "S";
  const biomes = Array.from({ length: 32 }, () => Array(24).fill("ordinary"));
  if (highland) biomes[highland.row][highland.col] = "highland";
  return new TerrainMap(layout.map((row) => row.join("")), { buildingBalance, biomes, autoMerge: false });
}

test("wall synthesis preserves absolute missing HP, incumbent identity and released navigation", () => {
  const sites = [6, 7, 8, 9].map((col) => cell(col, 5));
  const approach = cell(10, 5);
  for (const [balance, levelOne, levelTwo] of [
    ["control", 50, 50], ["w35", 35, 70], ["w25", 25, 50], ["w15", 15, 30],
  ]) {
    const map = mapWithCells([...sites, approach], balance);
    const walls = sites.map((site) => map.placeBuilding("wall", site));
    const [oldest] = walls;
    assert.equal(oldest.hp, levelOne);
    assert.equal(map.impactWall(oldest.cell, oldest.id, 10)?.hp, levelOne - 10);
    const beforeRevision = map.revision;
    const navigation = new EnemyNavigation(map);
    assert.equal(navigation.next(approach, sites[1], false).kind, "unreachable");
    const upgraded = map.synthesizeBuilding(sites.at(-1));
    assert.deepEqual([upgraded.id, upgraded.buildOrder, upgraded.level, upgraded.hp, upgraded.maxHp],
      [oldest.id, oldest.buildOrder, 2, levelTwo - 10, levelTwo]);
    assert.equal(upgraded.cell, oldest.cell);
    assert.equal(upgraded.maxHp, buildingMaxHp("wall", balance, 2));
    assert.equal(map.revision, beforeRevision + 1);
    assert.ok(!map.isWalkable(oldest.cell));
    assert.ok(sites.slice(1).every((site) => map.isWalkable(site)));
    assert.deepEqual(navigation.next(approach, sites[1], false), { kind: "move", cell: sites[3] });
  }
});

test("an unsupported upgraded wall capacity leaves every input intact", () => {
  const sites = [6, 7, 8, 9].map((col) => cell(col, 5));
  const map = mapWithCells(sites);
  const walls = sites.map((site) => map.placeBuilding("wall", site, Number.MAX_SAFE_INTEGER));
  const revision = map.revision;
  assert.equal(map.synthesizeBuilding(sites[0]), undefined);
  assert.equal(map.revision, revision);
  assert.deepEqual([...map.getBuildings()], walls);
});

test("candidate tower progression preserves the next shot deadline and rewards the clipped kill once", () => {
  const sites = [5, 6, 7, 8].map((col) => cell(col, 7));
  const entry = cell(6, 5);
  const technology = cell(3, 7);
  const map = mapWithCells([...sites, entry, technology]);
  const economy = new ExpeditionEconomy(map, 512, technology);
  const oldest = map.placeBuilding("tower", sites[0]);
  const shots = [];
  const kills = [];
  const battle = new DefenseSimulation(map, entry, entry, (event, { timeMs }) => {
    economy.handleEvent(event);
    if (event.type === "towerShot") shots.push([timeMs, event.damage, event.towerId]);
    if (event.type === "towerKill") kills.push(event);
  }, true);
  assert.equal(battle.spawn(1, 1, { hp: 8, contactDamage: 1 }), 1);
  battle.step(1);
  assert.deepEqual(shots, [[1, 2, oldest.id]]);

  for (const site of sites.slice(1)) assert.ok(map.placeBuilding("tower", site));
  const upgraded = map.synthesizeBuilding(sites.at(-1));
  assert.equal(upgraded.cell, oldest.cell);
  assert.deepEqual([upgraded.id, upgraded.level, upgraded.hp, upgraded.maxHp], [oldest.id, 2, 1, 1]);
  battle.step(349);
  assert.equal(shots.length, 1);
  battle.step(1);
  assert.deepEqual(shots.at(-1), [351, 5, oldest.id]);
  battle.step(299);
  assert.equal(shots.length, 2);
  battle.step(1);
  assert.deepEqual(shots.at(-1), [651, 1, oldest.id]);
  battle.step(1_000);
  assert.equal(shots.length, 3);
  assert.equal(kills.length, 1);
  assert.equal(economy.handleEvent(kills[0]), 0);
  assert.equal(economy.totals.killIncome, ECONOMY_PROTOTYPE.towerKillReward);
});

test("highland extends the upgraded tower's actual firing range and Control retains old attributes", () => {
  assert.deepEqual(towerAttributes("control", 2), { damage: 2, range: 5, intervalMs: 350 });
  assert.deepEqual(towerAttributes("w25", 2), { damage: 5, range: 6, intervalMs: 300 });
  assert.deepEqual(towerAttributes("w25", 2, "highland"), { damage: 5, range: 8, intervalMs: 300 });
  const sites = [5, 6, 7, 8].map((row) => cell(5, row));
  const entry = cell(13, 5);
  for (const highland of [undefined, sites[0]]) {
    const map = mapWithCells([...sites, entry], "w25", highland);
    for (const site of sites) assert.equal(map.placeBuilding("tower", site)?.hp, 1);
    assert.equal(map.synthesizeBuilding(sites.at(-1))?.level, 2);
    const shots = [];
    const battle = new DefenseSimulation(map, entry, entry, (event) => {
      if (event.type === "towerShot") shots.push(event.damage);
    }, true);
    battle.spawn(1, 1, { hp: 10, contactDamage: 1 });
    battle.step(1);
    assert.deepEqual(shots, highland ? [5] : []);
  }
});

test("producer synthesis retains partial time without duplicating payouts from consumed buildings", () => {
  const sites = [5, 6, 7, 8].map((col) => cell(col, 7));
  const technology = cell(3, 7);
  for (const balance of ["control", "w25"]) {
    const map = mapWithCells([...sites, technology], balance);
    const economy = new ExpeditionEconomy(map, 1091, technology);
    const oldest = map.placeBuilding("economy", sites[0]);
    economy.advance(3_000);
    for (const site of sites.slice(1)) assert.ok(map.placeBuilding("economy", site));
    economy.advance(999);
    const upgrade = map.synthesizeBuilding(sites.at(-1));
    assert.equal(upgrade.cell, oldest.cell);
    assert.deepEqual([upgrade.id, upgrade.level, upgrade.hp, upgrade.maxHp], [oldest.id, 2, 1, 1]);
    const amount = balance === "control" ? 1 : 2;
    assert.deepEqual(productionAttributes(balance, 2), { amount, intervalMs: 4_000 });
    assert.equal(economy.totals.productionIncome, 0);
    economy.advance(1);
    assert.equal(economy.totals.productionIncome, amount);
    economy.advance(3_999);
    assert.equal(economy.totals.productionIncome, amount);
    economy.advance(1);
    assert.equal(economy.totals.productionIncome, amount * 2);
    assert.equal(buildingMaxHp("technology", balance, 2), 1);
  }
});

test("four paid structures and an actual merge give reproducible coverage, space and income tradeoffs", () => {
  const result = runBuildingGrowthComparison();
  assert.deepEqual(runBuildingGrowthComparison(), result);
  const { dispersed, merged } = result.towers;
  assert.equal(dispersed.cardsUsed, 4);
  assert.equal(merged.cardsUsed, 4);
  assert.equal(dispersed.cardSpend, merged.cardSpend);
  assert.deepEqual(dispersed.before.levels, [1, 1, 1, 1]);
  assert.deepEqual(merged.before.levels, [2]);
  assert.equal(merged.before.released.length, 3);
  assert.ok(dispersed.coveredLaneTiles > merged.coveredLaneTiles);
  assert.ok(dispersed.kills > 0 && merged.kills > 0);
  assert.ok(dispersed.firingSpanMs > 0 && merged.firingSpanMs > 0);

  const spreadProducers = result.production.dispersed;
  const mergedProducer = result.production.merged;
  assert.equal(spreadProducers.cardsUsed, 4);
  assert.equal(mergedProducer.cardsUsed, 4);
  assert.equal(spreadProducers.cardSpend, mergedProducer.cardSpend);
  assert.deepEqual(spreadProducers.footprint.levels, [1, 1, 1, 1]);
  assert.deepEqual(mergedProducer.footprint.levels, [2]);
  assert.equal(mergedProducer.footprint.released.length, 3);
  assert.equal(spreadProducers.productionDuringWindow, 12);
  assert.equal(mergedProducer.productionDuringWindow, 6);
  assert.deepEqual(spreadProducers.breachProbe, {
    producersDestroyed: 1, remainingProducers: 3, productionInNextIsolatedCycle: 3,
  });
  assert.deepEqual(mergedProducer.breachProbe, {
    producersDestroyed: 1, remainingProducers: 0, productionInNextIsolatedCycle: 0,
  });
});

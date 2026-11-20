import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { towerAttributes } from "../src/building-balance.ts";
import { placementFailure } from "../src/build-placement.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { cellCenter } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const entry = cell(2, 5);
const wallSite = cell(20, 5);
const goal = cell(22, 5);
const technology = cell(2, 7);
const dispersed = [6, 10, 14, 18].map((col) => cell(col, 7));
const connected = [6, 7, 8, 9].map((col) => cell(col, 7));
const order = { count: 16, enemyHp: 4, wallDamage: 1, contactDamage: 1 };
const stepMs = 25;
const productionWindowMs = 12_000;
const buildingBalance = "w25";

// A playable gallery separated by permanent rock from the lane isolates ranged output.
// Standard inventory is used only for the equal-cost fixture, not for a Challenge opening.
const layout = Array.from({ length: 32 }, (_, row) => Array.from({ length: 24 }, (_, col) => {
  if (row === 8 && col === 3) return "S";
  if (row === goal.row && col === goal.col) return "G";
  if (row === entry.row && col >= entry.col && col <= goal.col) return ".";
  if ((row === 7 || row === 8) && col >= 2 && col <= 20) return ".";
  return "#";
}).join(""));

function openFixture(seed) {
  const map = new TerrainMap(layout, { buildingBalance });
  return { map, economy: new ExpeditionEconomy(map, seed, technology) };
}

function placeInGallery(map, economy, kind, position) {
  const standing = cell(position.col, position.row + 1);
  assert.ok(map.isWalkable(standing));
  assert.equal(placementFailure(map, position, {
    playerPosition: cellCenter(standing), roundEnded: false, visible: true,
    reserved: false, enemyOccupies: () => false, cardCount: economy.cards[kind],
  }), undefined);
  const building = economy.placeCard(kind, position);
  assert.ok(building);
  return building;
}

function draw(economy, kind, count) {
  for (let index = 0; index < count; index += 1) assert.equal(economy.drawCard(), kind);
}

function footprint(map, kind, sites, oldest) {
  const buildings = [...map.getBuildings()].filter((building) => building.kind === kind);
  assert.equal(map.getBuilding(oldest.cell)?.id, oldest.id);
  return {
    occupied: buildings.length,
    levels: buildings.map(({ level }) => level),
    site: oldest.cell,
    released: sites.filter((position) => map.isWalkable(position)),
  };
}

function compareTowers(sites) {
  const { map, economy } = openFixture(512);
  draw(economy, "tower", 2);
  const [oldest] = sites.map((site) => placeInGallery(map, economy, "tower", site));
  assert.equal(economy.cards.tower, 0);
  const before = footprint(map, "tower", sites, oldest);
  const wall = map.placeBuilding("wall", wallSite);
  assert.ok(wall);

  const towers = [...map.getBuildings()].filter((building) => building.kind === "tower");
  let coveredLaneTiles = 0;
  for (let col = entry.col; col < wallSite.col; col += 1) {
    if (towers.some(({ cell: at, level }) => {
      const { range } = towerAttributes(buildingBalance, level, map.getBiome(at));
      return Math.hypot(at.col - col, at.row - entry.row) <= range;
    })) coveredLaneTiles += 1;
  }

  const shots = [];
  const killed = new Set();
  const battle = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    economy.handleEvent(event);
    if (event.type === "towerShot") shots.push({ enemyId: event.enemyId, damage: event.damage, timeMs: metadata.timeMs });
    if (event.type === "towerKill") {
      assert.ok(!killed.has(event.enemyId), "Each real removal is rewarded once");
      killed.add(event.enemyId);
    }
  }, true);
  assert.equal(battle.requestWave(1, order), order.count);
  for (let elapsed = 0; elapsed < 10_000; elapsed += stepMs) {
    const { spawned, removed, pending } = battle.spawnCounts;
    if (spawned === removed && pending === 0) break;
    battle.step(stepMs);
  }

  const combat = battle.getWaveMetrics(1);
  assert.equal(combat.spawned, order.count);
  assert.equal(combat.active + combat.pending, 0);
  assert.equal(combat.spawned, combat.towerKills + combat.wallImpacts);
  assert.equal(combat.towerKills, killed.size);
  assert.ok(shots.length > 0);
  const output = shots.reduce((value, shot) => value + shot.damage, 0);
  const damageByUnit = new Map();
  for (const { enemyId, damage } of shots) {
    assert.ok(Number.isSafeInteger(damage) && damage > 0);
    damageByUnit.set(enemyId, (damageByUnit.get(enemyId) ?? 0) + damage);
  }
  for (const [enemyId, damage] of damageByUnit) {
    assert.ok(damage <= order.enemyHp);
    if (killed.has(enemyId)) assert.equal(damage, order.enemyHp);
  }
  const { cardSpend, killIncome } = economy.totals;
  assert.equal(killIncome, combat.towerKills * ECONOMY_PROTOTYPE.towerKillReward);
  const survivingTowers = footprint(map, "tower", sites, oldest).occupied;

  return {
    cardsUsed: sites.length, cardSpend, killIncome, netAfterCardSpend: killIncome - cardSpend,
    totalAppliedDamage: output, shots: shots.length, kills: combat.towerKills,
    coveredLaneTiles, firstShotAtMs: shots[0].timeMs, lastShotAtMs: shots.at(-1).timeMs,
    firingSpanMs: shots.at(-1).timeMs - shots[0].timeMs,
    averageExposureToKillMs: combat.averageTowerExposureToKillMs,
    spawned: combat.spawned, wallImpacts: combat.wallImpacts,
    wallArrivalShare: combat.wallImpacts / combat.spawned,
    wallHpAfter: map.getBuilding(wallSite)?.hp ?? 0,
    before, survivingTowers, towerSurvivalShare: survivingTowers / before.occupied,
  };
}

function compareProduction(sites) {
  const { map, economy } = openFixture(1091);
  const oldest = placeInGallery(map, economy, "economy", sites[0]);
  economy.advance(4_000);
  const bootstrapIncome = economy.totals.productionIncome;
  assert.equal(bootstrapIncome, 1, "The first producer funds the third paid card");
  draw(economy, "economy", 3);
  for (const site of sites.slice(1)) placeInGallery(map, economy, "economy", site);
  assert.equal(economy.cards.economy, 0);
  economy.advance(productionWindowMs);
  const { cardSpend, productionIncome } = economy.totals;
  const beforeBreach = footprint(map, "economy", sites, oldest);

  // Isolate the cost of a single breach: one attacker starts inside the gallery.
  // Continue production alone for one cycle to measure capacity after the hit.
  const breachEntry = cell(oldest.cell.col, oldest.cell.row + 1);
  const hits = [];
  const battle = new DefenseSimulation(map, breachEntry, goal, (event) => {
    if (event.type === "buildingHit") hits.push(event);
  }, true);
  assert.equal(battle.spawn(1, 1, { hp: 4, contactDamage: 1 }), 1);
  battle.step(50);
  assert.deepEqual(hits.map(({ buildingId, damage, destroyed }) => [buildingId, damage, destroyed]),
    [[oldest.id, 1, true]]);
  assert.equal([...battle.enemies].length, 1);
  const remainingProducers = [...map.getBuildings()].filter(({ kind }) => kind === "economy").length;
  economy.advance(4_000);

  return {
    cardsUsed: sites.length, cardSpend, bootstrapIncome,
    productionDuringWindow: productionIncome - bootstrapIncome,
    netAfterCardSpend: productionIncome - cardSpend,
    footprint: beforeBreach,
    breachProbe: { producersDestroyed: hits.length, remainingProducers,
      productionInNextIsolatedCycle: economy.totals.productionIncome - productionIncome },
  };
}

export function runBuildingGrowthComparison() {
  return {
    buildingBalance, stepMs, productionWindowMs,
    setup: "Equal-cost paid card fixtures with standard starting inventory on a shared protected gallery",
    towers: { seed: 512, order, dispersed: compareTowers(dispersed), merged: compareTowers(connected) },
    production: { seed: 1091, dispersed: compareProduction(dispersed), merged: compareProduction(connected) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runBuildingGrowthComparison(), null, 2));
}

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { evolvedTowerAttributes, towerAttributes } from "../src/building-balance.ts";
import { placementFailure } from "../src/build-placement.ts";
import { DEFENSE_CONFIG, DefenseSimulation, enemyPosition } from "../src/defense-simulation.ts";
import { DIFFICULTY_PROFILES } from "../src/expedition-difficulty.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { MIDGAME_EXPERIMENTS, waveDeployment } from "../src/midgame-experiments.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { cellCenter } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { buildEvolvedTowerCoverage, evolvedTargetDistanceSquared } from "../src/tower-attack.ts";

const cell = ([col, row]) => ({ col, row });
const key = ({ col, row }) => `${col},${row}`;
const columns = 36;
const rows = 32;
const seed = 515;
const stepMs = 10;
const waveId = 6;
const setupNames = ["dispersed", "legacy", "piercing", "burst"];
const normal = DIFFICULTY_PROFILES.challenge.stages[0];
const sponsorSite = cell([2, 26]);
const sponsorStance = cell([3, 26]);
const mineSites = Array.from({ length: 25 }, (_, index) => index + 4)
  .flatMap((col) => [cell([col, 25]), cell([col, 27])]);

const routes = [
  {
    id: "short-straight", bends: [[9, 9], [20, 9]],
    line: [[8, 9], [7, 9], [6, 9], [5, 9]],
    corner: [[8, 9], [8, 8], [7, 8], [7, 9]],
    dispersed: [[8, 9], [11, 7], [14, 7], [18, 10]],
  },
  {
    id: "long-straight", bends: [[9, 9], [33, 9]],
    line: [[8, 9], [7, 9], [6, 9], [5, 9]],
    corner: [[8, 9], [8, 8], [7, 8], [7, 9]],
    dispersed: [[8, 9], [13, 11], [20, 11], [26, 11]],
  },
  {
    id: "s-turns", bends: [[9, 9], [14, 9], [14, 13], [21, 13], [21, 17], [28, 17], [28, 22]],
    line: [[13, 12], [12, 12], [11, 12], [10, 12]],
    corner: [[13, 12], [12, 12], [12, 13], [13, 13]],
    dispersed: [[13, 12], [10, 7], [17, 11], [23, 15]],
  },
  {
    id: "l-corner", bends: [[9, 9], [15, 9], [15, 18]],
    line: [[13, 8], [13, 7], [13, 6], [13, 5]],
    corner: [[13, 8], [12, 8], [12, 7], [13, 7]],
    dispersed: [[13, 8], [10, 6], [17, 11], [17, 15]],
    sight: [[14, 8], [15, 8]],
  },
  {
    id: "narrow-entry", bends: [[9, 12], [12, 12], [12, 15], [20, 15], [20, 20]],
    line: [[11, 13], [11, 14], [11, 15], [11, 16]],
    corner: [[11, 13], [10, 13], [10, 14], [11, 14]],
    dispersed: [[11, 13], [8, 10], [15, 13], [18, 13]],
  },
  {
    id: "highland", bends: [[10, 9], [29, 9]],
    line: [[9, 9], [8, 9], [7, 9], [6, 9]],
    corner: [[9, 9], [9, 8], [8, 8], [8, 9]],
    dispersed: [[9, 9], [7, 9], [8, 8], [22, 11]],
    highland: true,
  },
];

function corridor(bends) {
  const path = [cell(bends[0])];
  for (const point of bends.slice(1).map(cell)) {
    let { col, row } = path.at(-1);
    assert.ok(col === point.col || row === point.row);
    while (col !== point.col || row !== point.row) {
      col += Math.sign(point.col - col);
      row += Math.sign(point.row - row);
      path.push({ col, row });
    }
  }
  assert.equal(new Set(path.map(key)).size, path.length);
  return path;
}

function setting(route, setup) {
  const path = corridor(route.bends);
  const entry = path[0];
  const goal = path.at(-1);
  const wallSite = path.at(-2);
  const exposedPath = path.slice(0, -2);
  const pathKeys = new Set(path.map(key));
  const candidates = new Map([route.line, route.corner, route.dispersed].flat().map((pair) => [String(pair), cell(pair)]));
  const layout = Array.from({ length: rows }, () => Array(columns).fill("#"));
  const mark = ({ col, row }, glyph = ".") => { layout[row][col] = glyph; };
  assert.equal(new Set([route.line, route.corner, route.dispersed].map(([at]) => String(at))).size, 1);
  for (const site of candidates.values()) assert.ok(!pathKeys.has(key(site)), "A build site cannot replace the lane");
  for (const point of [...path, ...candidates.values(), ...(route.sight ?? []).map(cell)]) mark(point);

  const stances = new Map();
  for (const site of candidates.values()) {
    const { col, row } = site;
    const neighbors = [[col, row - 1], [col - 1, row], [col, row + 1], [col + 1, row]].map(cell);
    const valid = neighbors.filter((point) => !candidates.has(key(point))
      && key(point) !== key(wallSite) && key(point) !== key(goal));
    const stance = valid.find((point) => layout[point.row][point.col] === ".") ?? valid[0];
    assert.ok(stance);
    stances.set(key(site), stance);
    mark(stance);
  }

  mark(goal, "G");
  mark(sponsorSite);
  mark(sponsorStance, "S");
  for (const target of mineSites) {
    mark(cell([target.col, 26]));
    mark(target, "+");
  }
  const biomes = route.highland
    ? layout.map((row, index) => row.map(() => index < 24 ? "highland" : "ordinary"))
    : undefined;
  const map = new TerrainMap(layout.map((row) => row.join("")), {
    buildingBalance: "w25", biomes, towerEvolution: setup !== "legacy",
  });
  return { map, entry, goal, wallSite, exposedPath, stances, availableTowerSites: candidates.size };
}

function assertPlacement(map, position, stance, cardCount) {
  assert.ok(map.isWalkable(stance));
  assert.equal(placementFailure(map, position, {
    playerPosition: cellCenter(stance), roundEnded: false, visible: true,
    reserved: false, enemyOccupies: () => false, cardCount,
  }), undefined);
}

function install(route, setup, { map, stances }) {
  const economy = new ExpeditionEconomy(map, seed, sponsorSite, "challenge", MIDGAME_EXPERIMENTS.combined.economy);
  assert.equal(economy.balance, 0);
  assert.equal(economy.cards.tower, 0);
  assert.equal(economy.hasTechnology, false);

  // An isolated excavation strip funds the same Challenge budget before the battle clock starts.
  for (const target of mineSites) {
    const from = cell([target.col, 26]);
    for (let strike = 0; strike < MINING_CONFIG.dirtMaxHp; strike += MINING_CONFIG.damage) {
      const hit = map.applyDigDamage(from, target, MINING_CONFIG.damage, economy.toolLevel);
      assert.ok(hit.effective);
      economy.creditMiningDamage(hit.damage);
    }
  }
  const budget = economy.balance;
  assertPlacement(map, sponsorSite, sponsorStance);
  assert.ok(economy.buildTechnology(sponsorSite));
  const paid = [];
  for (let count = 0; count < 4; count += 1) {
    paid.push(economy.drawCost);
    assert.equal(economy.drawCard(), "tower");
  }
  assert.equal(economy.balance, 0);
  assert.equal(budget, economy.totals.cardSpend + economy.totals.technologySpend);

  const sites = (setup === "dispersed" ? route.dispersed : setup === "burst" ? route.corner : route.line).map(cell);
  const placed = sites.map((site) => {
    assertPlacement(map, site, stances.get(key(site)), economy.cards.tower);
    const tower = economy.placeCard("tower", site);
    assert.ok(tower);
    return tower;
  });
  assert.equal(economy.cards.tower, 0);
  const towers = [...map.getBuildings()].filter(({ kind }) => kind === "tower");
  const retained = map.getBuilding(sites[0]);
  assert.equal(retained.id, placed[0].id);
  assert.equal(retained.hp, 1);
  assert.equal(towers.length, setup === "dispersed" ? 4 : 1);
  assert.equal(retained.level, setup === "dispersed" ? 1 : 2);
  assert.equal(retained.evolution?.kind, setup === "piercing" || setup === "burst" ? setup : undefined);
  const released = sites.filter((site) => map.isWalkable(site));
  assert.equal(released.length, sites.length - towers.length);

  return { economy, towers, budget, paid, retained, released };
}

function eligibleArea(map, tower) {
  const biome = map.getBiome(tower.cell);
  if (tower.evolution) {
    const attributes = evolvedTowerAttributes(tower.evolution, biome);
    const coverage = buildEvolvedTowerCoverage(map, tower.cell, attributes);
    return (point) => evolvedTargetDistanceSquared(map, coverage, point) !== undefined;
  }
  const limit = towerAttributes(map.buildingBalance, tower.level, biome).range ** 2;
  return ({ x, y }) => (x - tower.cell.col - 0.5) ** 2 + (y - tower.cell.row - 0.5) ** 2 <= limit;
}

const populations = [
  { id: "normal", count: 16, deployment: { intervalMs: DEFENSE_CONFIG.spawnIntervalMs } },
  { id: "armored-25", count: 16, deployment: waveDeployment("armored", waveId, { seed, stage: 1, count: 16 }) },
  { id: "dense", count: 24, deployment: waveDeployment("dense", waveId) },
];

function compare(route, population, setup) {
  const fixture = setting(route, setup);
  const { map, entry, goal, wallSite, exposedPath, availableTowerSites } = fixture;
  const { economy, towers, budget, paid, retained, released } = install(route, setup, fixture);
  const wall = map.placeBuilding("wall", wallSite);
  assert.ok(wall);
  const eligible = towers.map((tower) => eligibleArea(map, tower));
  const covers = (point) => eligible.some((isEligible) => isEligible(point));
  const coveredLaneTiles = exposedPath.filter(({ col, row }) => covers({ x: col + 0.5, y: row + 0.5 })).length;
  const routeKeys = new Set(exposedPath.map(key));
  const firstEligible = new Map();
  const attackHits = new Map();
  const damageByUnit = new Map();
  const killIds = new Set();
  const wallArrivalIds = new Set();
  const killedKinds = { normal: 0, armored: 0 };
  const damageByKind = { normal: 0, armored: 0 };
  const overkillByKind = { normal: 0, armored: 0 };
  const exposures = [];
  let overkill = 0;
  let reward = 0;
  let maxActiveInRange = 0;

  // Fixed navigation target keeps each route and wall constant. The real Challenge
  // browser regression covers hostile building selection and the time-limited paid opening.
  const battle = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    reward += economy.handleEvent(event, metadata.waveId);
    if (event.type === "towerShot") {
      const { enemyId, towerId, damage, to } = event;
      const { kind, rawDamage, overkill: overflow } = metadata.towerHit;
      assert.equal(kind, retained.evolution?.kind ?? "standard");
      assert.ok(damage > 0 && overflow >= 0);
      assert.equal(rawDamage, damage + overflow);
      assert.ok(!killIds.has(enemyId));
      overkill += overflow;
      damageByKind[metadata.enemyKind] += damage;
      overkillByKind[metadata.enemyKind] += overflow;
      damageByUnit.set(enemyId, (damageByUnit.get(enemyId) ?? 0) + damage);
      const attack = `${towerId}:${metadata.timeMs}`;
      const targets = attackHits.get(attack) ?? new Set();
      assert.ok(!targets.has(enemyId), "An enemy can be hit only once by the same attack");
      targets.add(enemyId);
      attackHits.set(attack, targets);
      if (!firstEligible.has(enemyId) && covers(to)) firstEligible.set(enemyId, metadata.timeMs);
    }
    if (event.type === "towerKill") {
      assert.ok(!killIds.has(event.enemyId));
      assert.equal(damageByUnit.get(event.enemyId), metadata.enemyKind === "armored" ? population.deployment.armor.hp : normal.enemyHp);
      killIds.add(event.enemyId);
      killedKinds[metadata.enemyKind] += 1;
      const first = firstEligible.get(event.enemyId);
      if (first !== undefined) exposures.push(metadata.timeMs - first);
    }
    if (event.type === "wallImpact") {
      assert.equal(event.wallId, wall.id);
      assert.ok(!wallArrivalIds.has(event.enemyId) && !killIds.has(event.enemyId));
      wallArrivalIds.add(event.enemyId);
    }
  });
  const order = { ...normal, count: population.count };
  assert.equal(battle.requestWave(waveId, order, population.deployment), population.count);
  for (let elapsed = 0; elapsed <= 15_000; elapsed += stepMs) {
    const { spawned, removed, pending } = battle.spawnCounts;
    if (spawned === removed && pending === 0) break;
    let activeInRange = 0;
    for (const enemy of battle.enemies) {
      assert.ok(routeKeys.has(key(enemy.cell)), `${route.id} ${setup} departed from its common lane at ${key(enemy.cell)}`);
      if (covers(enemyPosition(enemy))) {
        activeInRange += 1;
        if (!firstEligible.has(enemy.id)) firstEligible.set(enemy.id, battle.elapsedMs);
      }
    }
    maxActiveInRange = Math.max(activeInRange, maxActiveInRange);
    battle.step(stepMs);
  }
  const combat = battle.getWaveMetrics(waveId);
  assert.equal(combat.spawned, population.count);
  assert.equal(combat.active + combat.pending, 0);
  assert.equal(combat.enemyKinds.armored.spawned, population.deployment.armor?.slots.length ?? 0);
  assert.equal(combat.spawned, killIds.size + wallArrivalIds.size);
  assert.equal(combat.towerKills, killIds.size);
  assert.equal(combat.towerHitEnemies, damageByUnit.size);
  assert.equal(combat.wallImpacts, wallArrivalIds.size);
  assert.equal(economy.totals.killIncome, reward);
  const wallHpLost = wall.hp - (map.getBuilding(wallSite)?.hp ?? 0);
  assert.equal(combat.wallDamage, wallHpLost);
  const damage = [...damageByUnit.values()].reduce((total, value) => total + value, 0);
  const attackSizes = [...attackHits.values()].map((targets) => targets.size);

  return {
    route: route.id, population: population.id, setup, budget, technologySpend: economy.totals.technologySpend,
    paid, cardSpend: economy.totals.cardSpend, cardsUsed: paid.length, killIncome: reward,
    enemies: combat.spawned, armored: combat.enemyKinds.armored.spawned,
    plannedSpawnIntervalMs: combat.plannedSpawnIntervalMs,
    actualSpawnsPerSecond: combat.actualSpawnsPerSecond,
    entryOccupancyBlocks: combat.entryOccupancyBlocks, peakActive: combat.peakActive, maxActiveInRange,
    attackCount: attackHits.size, maxEnemiesPerAttack: Math.max(0, ...attackSizes), hits: combat.towerHits,
    hitEnemies: damageByUnit.size, hitEnemiesByKind: {
      normal: combat.enemyKinds.normal.towerHitEnemies, armored: combat.enemyKinds.armored.towerHitEnemies,
    },
    damage, rawDamage: damage + overkill, overkill, damageByKind, overkillByKind,
    kills: killIds.size, killedKinds, wallArrivals: wallArrivalIds.size, wallHpLost,
    totalResolvedEnemies: killIds.size + wallArrivalIds.size,
    firstEffectiveRangeToKillMs: exposures.length ? exposures.reduce((total, ms) => total + ms, 0) / exposures.length : null,
    killsWithSampledExposure: exposures.length, killsWithoutSampledExposure: killIds.size - exposures.length,
    laneTiles: exposedPath.length, coveredLaneTiles, availableTowerSites, occupiedTowerSites: towers.length,
    retained: { location: retained.cell, hp: retained.hp, level: retained.level, evolution: retained.evolution ?? null },
    released, killIds: [...killIds], wallArrivalIds: [...wallArrivalIds], damageByEnemy: Object.fromEntries(damageByUnit),
  };
}

export function runTowerEvolutionComparison() {
  return routes.flatMap((route) => populations.flatMap((population) => setupNames.map((setup) => compare(route, population, setup))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({
    seed, stepMs, buildingBalance: "w25", normalHp: normal.enemyHp, standardKillReward: ECONOMY_PROTOTYPE.towerKillReward,
    battle: "Fixed target, physical enemies, W25 wall and identical Challenge/Combined paid budgets per setup",
    exposure: "First eligible aim sampled at 10ms intervals or on impact. Splash may kill targets before direct exposure.",
    rows: runTowerEvolutionComparison(),
  }, null, 2));
}

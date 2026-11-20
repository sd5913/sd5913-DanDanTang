import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { BIOME_PROTOTYPE } from "../src/biome-effects.ts";
import { CONTROL_TOWER_TUNING, PLAYTEST_TOWER_TUNING, evolvedTowerAttributes, towerAttributes } from "../src/building-balance.ts";
import { placementFailure } from "../src/build-placement.ts";
import { DefenseSimulation, sameCell } from "../src/defense-simulation.ts";
import { EnemyNavigation } from "../src/enemy-navigation.ts";
import { DIFFICULTY_PROFILES, wavePopulation } from "../src/expedition-difficulty.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { ExplorationFog } from "../src/fog.ts";
import { MIDGAME_EXPERIMENTS, waveDeployment } from "../src/midgame-experiments.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { cellCenter, Player } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { buildEvolvedTowerCoverage, evolvedTargetDistanceSquared } from "../src/tower-attack.ts";

const cell = (col, row) => ({ col, row });
const key = ({ col, row }) => `${col},${row}`;
const [front, join, hinge, end, elbow] = [cell(6, 12), cell(7, 12), cell(8, 12), cell(9, 12), cell(6, 11)];
const spawn = cell(7, 11);
const entry = cell(1, 12);
const wallSite = cell(12, 9);
const goal = cell(12, 8);
const routeProbe = cell(8, 17);
const technology = cell(2, 26);
const technologyStance = cell(3, 26);
const seed = 848;
const initialPrice = [3, 3, 3, 6];
const extensionPrice = [6, 6, 6];
const stepMs = 20;
const combatLimitMs = 12_000;
const setups = {
  dispersed: [front, hinge, end, elbow],
  piercing: [front, join, hinge, end],
  burst: [front, join, hinge, elbow],
};
const expansionSites = [cell(9, 8), cell(7, 8), cell(10, 9), cell(8, 9), join, hinge, end, elbow];
const miningRows = [22, 24, 27, 29];
const mineSites = Array.from({ length: 86 }, (_, index) => cell(4 + Math.floor(index / miningRows.length),
  miningRows[index % miningRows.length]));

function segment(map, points) {
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const dc = Math.sign(to.col - from.col);
    const dr = Math.sign(to.row - from.row);
    assert.ok(dc === 0 || dr === 0);
    for (let col = from.col, row = from.row; ; col += dc, row += dr) {
      map[row][col] = ".";
      if (col === to.col && row === to.row) break;
    }
  }
}

function fixture(space) {
  const layout = Array.from({ length: 32 }, () => Array(28).fill("#"));
  const mainLane = [entry, cell(5, 12), cell(5, 17), cell(15, 17), cell(15, 12), cell(12, 12), goal];
  segment(layout, mainLane);
  segment(layout, [routeProbe, cell(8, 13)]);
  segment(layout, [cell(10, 12), cell(12, 12)]);
  for (const site of [front, join, hinge, end, elbow, spawn, cell(8, 11), technology, technologyStance]) {
    layout[site.row][site.col] = ".";
  }
  if (space === "open") {
    for (let row = 6; row <= 11; row += 1) {
      for (let col = 6; col <= 11; col += 1) layout[row][col] = ".";
    }
    layout[8][11] = "#"; // Keep the shared wall on the only approach to the fixed goal.
  } else {
    // These dirt tiles are a possible expansion route that neither policy excavates in the matched run.
    layout[10][7] = "+";
    layout[10][8] = "+";
    layout[10][9] = "+";
    layout[9][7] = ".";
    layout[9][8] = ".";
    layout[9][9] = ".";
  }

  // Common, isolated preparation strip. A deterministic deck and equal excavation income fund both stages.
  // Alternating floor and seam rows leave a valid neighboring stance for every mined tile.
  for (const target of mineSites) {
    layout[target.row][target.col] = "+";
    layout[target.row + 1][target.col] = ".";
  }

  layout[spawn.row][spawn.col] = "S";
  layout[goal.row][goal.col] = "G";
  const map = new TerrainMap(layout.map((row) => row.join("")), { buildingBalance: "w25", towerEvolution: true });
  return {
    map, availableTiles: layout.slice(0, 20).flat().filter((glyph) => glyph === "." || glyph === "S").length,
    layout: layout.map((row) => row.join("")),
  };
}

function adjacent({ col, row }, diagonal = false) {
  const neighboring = [cell(col, row - 1), cell(col + 1, row), cell(col, row + 1), cell(col - 1, row)];
  return diagonal ? [...neighboring, cell(col - 1, row - 1), cell(col + 1, row - 1),
    cell(col + 1, row + 1), cell(col - 1, row + 1)] : neighboring;
}

function reachableStances(map, start) {
  assert.ok(map.isWalkable(start));
  const order = [start];
  const prior = new Map([[key(start), null]]);
  for (let index = 0; index < order.length; index += 1) {
    const point = order[index];
    for (const neighbor of adjacent(point)) {
      if (!map.isWalkable(neighbor) || prior.has(key(neighbor))) continue;
      prior.set(key(neighbor), point);
      order.push(neighbor);
    }
  }
  return { order, prior };
}

function placementAt(map, site, at, stock, battle) {
  const visible = new ExplorationFog(map.columns, map.rows);
  const sources = [...map.getBuildings()].filter(({ kind }) => kind === "tower").map(({ cell: tower }) => ({
    cell: tower,
    radius: BIOME_PROTOTYPE.towerVision + (map.getBiome(tower) === "highland" ? BIOME_PROTOTYPE.highlandTowerVisionBonus : 0),
  }));
  visible.reveal(at, sources);
  return placementFailure(map, site, {
    playerPosition: cellCenter(at), roundEnded: false, visible: visible.visibility(site) === "visible",
    reserved: sameCell(site, entry) || sameCell(site, goal) || sameCell(site, technology),
    enemyOccupies: (position) => battle?.occupies(position) ?? false, cardCount: stock,
  });
}

function reachablePlacementTargets(map, start, stock, battle) {
  const { order } = reachableStances(map, start);
  const targets = new Map();
  for (const at of order) {
    for (const site of adjacent(at, true)) {
      if (!targets.has(key(site)) && map.isWalkable(site) && !placementAt(map, site, at, stock, battle)) {
        targets.set(key(site), site);
      }
    }
  }
  return targets;
}

function placeTower(run, site) {
  const { map, economy, player, battle } = run;
  const current = player.cell;
  const { order, prior } = reachableStances(map, current);
  const stance = order.find((at) => !placementAt(map, site, at, economy.cards.tower, battle));
  if (!stance) return undefined;

  const walkSteps = walkTo(player, map, stance, prior);
  assert.equal(placementAt(map, site, player.cell, economy.cards.tower, battle), undefined);
  const preview = map.previewBuildingSynthesis("tower", site);
  const before = economy.cards.tower;
  const revisionBefore = map.revision;
  const placed = economy.placeCard("tower", site);
  assert.ok(placed);
  assert.equal(economy.cards.tower, before - 1);
  assert.ok(map.revision > revisionBefore);
  assert.equal(placed.hp, 1);
  if (preview) {
    assert.deepEqual(placed.cell, preview.retained);
    assert.deepEqual(placed.evolution, preview.evolution);
    assert.ok(preview.released.every((position) => map.isWalkable(position)));
  }

  return {
    site, stance, walkSteps, id: placed.id, evolution: placed.evolution ?? null,
    released: preview?.released ?? [], retained: preview?.retained ?? null,
    revisionBefore, revisionAfter: map.revision,
  };
}

function walkTo(player, map, destination, prior) {
  const reversed = [destination];
  for (let origin = prior.get(key(destination)); origin; origin = prior.get(key(origin))) reversed.push(origin);
  const path = reversed.reverse();
  for (let index = 1; index < path.length; index += 1) {
    const [from, to] = [path[index - 1], path[index]];
    for (let step = 0; step < 4; step += 1) player.move(to.col - from.col, to.row - from.row, 50, map);
    assert.deepEqual(player.position, cellCenter(to));
  }
  return path.length - 1;
}

function excavateExtension({ map, economy, player, battle }) {
  const { order, prior } = reachableStances(map, player.cell);
  for (const stance of order) {
    const site = adjacent(stance).find((neighbor) => map.getCell(neighbor)?.terrain === "dirt");
    if (!site || battle.occupies(site)) continue;
    walkTo(player, map, stance, prior);
    const incomeBefore = economy.balance;
    mineTile(map, economy, player.cell, site);
    return { site, income: Number((economy.balance - incomeBefore).toFixed(1)) };
  }
  return undefined;
}

function mineTile(map, economy, stance, target) {
  let strike;
  do {
    strike = map.applyDigDamage(stance, target, MINING_CONFIG.damage, economy.toolLevel);
    assert.ok(strike.effective);
    economy.creditMiningDamage(strike.damage);
  } while (!strike.cleared);
}

function purchase(economy, prices) {
  return prices.map((cost) => {
    assert.equal(economy.drawCost, cost);
    const before = economy.balance;
    assert.equal(economy.drawCard(), "tower");
    assert.equal(economy.balance, before - cost);
    return cost;
  });
}

function inspectRoute(navigation, start) {
  let position = start;
  const cells = [start];
  for (let step = 0; step < 100; step += 1) {
    const action = navigation.next(position, goal);
    if (action.kind !== "move") {
      return { status: action.kind, steps: cells.length - 1, cells, obstacle: action.kind === "wall" ? action.cell : null,
        searches: navigation.searchCount };
    }
    position = action.cell;
    cells.push(position);
  }
  assert.fail("Route probe should terminate in the finite arena");
}

function coverage(map, towerTuning, targets) {
  const ranges = [...map.getBuildings()].filter(({ kind }) => kind === "tower").map((tower) => {
    const biome = map.getBiome(tower.cell);
    if (tower.evolution) {
      const attributes = evolvedTowerAttributes(tower.evolution, biome, towerTuning);
      const area = buildEvolvedTowerCoverage(map, tower.cell, attributes);
      return (position) => evolvedTargetDistanceSquared(map, area, position) !== undefined;
    }
    const maxDistance = towerAttributes(map.buildingBalance, tower.level, biome).range ** 2;
    return ({ x, y }) => (x - tower.cell.col - 0.5) ** 2 + (y - tower.cell.row - 0.5) ** 2 <= maxDistance;
  });

  return targets.filter(({ col, row }) => ranges.some((inRange) => inRange({ x: col + 0.5, y: row + 0.5 }))).length;
}

function eventLedger() {
  return { damage: 0, hits: 0, fireGroups: new Set(), overkill: 0, kills: 0, killIncome: 0, wallHits: 0, wallDamage: 0,
    wallDestroyed: 0, destroyedBuildings: [], wallAttackers: [], visited: new Map() };
}

function applyEvent(log, event, metadata, reward) {
  if (!log) return;
  if (event.type === "towerShot") {
    log.hits += 1;
    log.fireGroups.add(`${event.towerId}:${metadata.timeMs}`);
    log.damage += event.damage;
    log.overkill += metadata.towerHit.overkill;
  } else if (event.type === "towerKill") {
    log.kills += 1;
    log.killIncome += reward;
  } else if (event.type === "wallImpact") {
    log.wallHits += 1;
    log.wallDamage += event.damage;
    log.wallDestroyed += Number(event.destroyed);
    log.wallAttackers.push(event.enemyId);
  } else if (event.type === "buildingHit" && event.destroyed) {
    log.destroyedBuildings.push({ cell: event.cell, kind: event.buildingKind, id: event.buildingId });
  }
}

function summarize({ visited, fireGroups, ...totals }) {
  return { ...totals, fireCount: fireGroups.size, visitedCells: [...visited.values()] };
}

function scenario(space, setup, extension, towerTuning) {
  const arena = fixture(space);
  const { map } = arena;
  const deployExtra = extension !== "hold";
  const allowMergeDuringExtension = setup !== "dispersed" || extension === "allow-merge";
  const economy = new ExpeditionEconomy(map, seed, technology, "challenge", MIDGAME_EXPERIMENTS.combined.economy);
  assert.equal(economy.balance, 0);
  for (const target of mineSites) {
    const stance = cell(target.col, target.row + 1);
    assert.ok(map.isWalkable(stance));
    mineTile(map, economy, stance, target);
  }
  assert.equal(economy.balance, 43);
  const technologyProblem = placementFailure(map, technology, { playerPosition: cellCenter(technologyStance),
    roundEnded: false, visible: true, reserved: false, enemyOccupies: () => false });
  assert.equal(technologyProblem, undefined);
  assert.ok(economy.buildTechnology(technology));
  assert.deepEqual(purchase(economy, initialPrice), initialPrice);
  assert.equal(economy.balance, 18);
  const wall = map.placeBuilding("wall", wallSite);
  assert.equal(wall.hp, 25);
  const navigation = new EnemyNavigation(map);
  const waveLedgers = new Map();
  let inProgress;
  const battle = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    const reward = economy.handleEvent(event, metadata.waveId);
    applyEvent(inProgress, event, metadata, reward);
    applyEvent(waveLedgers.get(metadata.waveId), event, metadata, reward);
  }, true, { towerTuning });
  const player = new Player(spawn);
  const run = { map, economy, battle, player };

  function fight(wave, stage) {
    const count = wavePopulation("challenge", wave, 0);
    const deployment = waveDeployment("combined", wave, { seed, stage, count });
    const cohort = eventLedger();
    const phase = eventLedger();
    waveLedgers.set(wave, cohort);
    inProgress = phase;
    const order = { ...DIFFICULTY_PROFILES.challenge.stages[stage], count };
    const initialDefense = [...map.getBuildings()].filter(({ kind }) => kind === "tower");
    const targets = Array.from({ length: map.rows }, (_, row) =>
      Array.from({ length: map.columns }, (_, col) => cell(col, row))).flat()
      .filter((point) => point.row < 20 && map.isWalkable(point));
    const coverageTiles = coverage(map, towerTuning, targets);
    const searchStart = battle.searchCount;
    const wallHpBefore = map.getBuilding(wallSite)?.hp ?? 0;
    assert.equal(battle.requestWave(wave, order, deployment), count);
    let elapsedMs = 0;
    while (elapsedMs < combatLimitMs) {
      for (const enemy of battle.enemies) {
        const position = key(enemy.cell);
        phase.visited.set(position, enemy.cell);
        waveLedgers.get(enemy.waveId)?.visited.set(position, enemy.cell);
      }
      const { spawned, removed, pending } = battle.spawnCounts;
      if (spawned === removed && pending === 0) break;
      battle.step(stepMs);
      elapsedMs += stepMs;
    }
    const combat = battle.getWaveMetrics(wave);
    assert.equal(combat.spawned, count);
    assert.equal(combat.enemyKinds.armored.spawned, deployment.armor?.slots.length ?? 0);
    assert.equal(combat.towerKills, cohort.kills);
    assert.equal(combat.wallImpacts, cohort.wallHits);
    assert.equal(combat.wallDamage, cohort.wallDamage);
    const wallHpAfter = map.getBuilding(wallSite)?.hp ?? 0;
    assert.equal(wallHpBefore - wallHpAfter, phase.wallDamage);
    assert.equal(phase.wallDestroyed, Number(wallHpBefore > 0 && wallHpAfter === 0));
    inProgress = undefined;
    return {
      wave, elapsedMs, enemies: count, armored: combat.enemyKinds.armored.spawned, activeAtEnd: combat.active,
      towersBefore: initialDefense.map(({ id, cell: location, level, evolution }) => ({ id, cell: location, level, evolution: evolution ?? null })),
      coverageTiles, candidateCoverageTiles: targets.length, wallHpBefore, wallHpAfter, navigationSearches: battle.searchCount - searchStart,
      ...summarize(phase),
    };
  }

  const initialPlaced = [];
  for (const site of setups[setup].slice(0, 3)) {
    const placement = placeTower(run, site);
    assert.ok(placement);
    initialPlaced.push(placement);
  }
  const beforeMerge = inspectRoute(navigation, routeProbe);
  assert.equal(beforeMerge.status, "wall");
  assert.deepEqual(beforeMerge.obstacle, wallSite);
  const fourth = placeTower(run, setups[setup][3]);
  assert.ok(fourth);
  initialPlaced.push(fourth);
  const afterMerge = inspectRoute(navigation, routeProbe);
  assert.equal(afterMerge.status, "wall");
  assert.deepEqual(afterMerge.obstacle, wallSite);
  assert.ok(afterMerge.searches > beforeMerge.searches);
  assert.equal(fourth.released.length, setup === "dispersed" ? 0 : 3);
  if (setup !== "dispersed") {
    assert.equal(fourth.evolution?.kind, setup);
    assert.equal(fourth.id, initialPlaced[0].id);
  }
  assert.equal(economy.cards.tower, 0);
  assert.equal([...map.getBuildings()].filter(({ kind }) => kind === "tower").length, setup === "dispersed" ? 4 : 1);
  const stance = player.cell;
  const emptyInReach = [...reachablePlacementTargets(map, stance, 1, battle).values()]
    .find((site) => !placementAt(map, site, stance, 1, battle));
  assert.ok(emptyInReach);
  assert.equal(placementAt(map, emptyInReach, stance, 0, battle), "out-of-stock");
  assert.ok(reachableStances(map, stance).order.some((at) => placementAt(map, front, at, 1, battle) === "occupied"));
  assert.equal(placementAt(map, routeProbe, stance, 1, battle), "out-of-range");
  const waveOne = fight(1, 0);

  assert.deepEqual(purchase(economy, extensionPrice), extensionPrice);
  assert.equal(economy.cards.tower, 3);
  assert.equal(economy.totals.technologySpend + economy.totals.cardSpend, 43);
  const nextBefore = inspectRoute(navigation, routeProbe);
  const followUpPlaced = [];
  const followUpExcavation = [];
  const initiallyAvailable = reachablePlacementTargets(map, player.cell, economy.cards.tower, battle);
  while (deployExtra && economy.cards.tower > 0) {
    const available = reachablePlacementTargets(map, player.cell, economy.cards.tower, battle);
    const preferred = [...fourth.released, ...expansionSites, ...available.values()];
    const target = preferred.find((site) => available.has(key(site))
      && (allowMergeDuringExtension || !map.previewBuildingSynthesis("tower", site)));
    if (!target) {
      const expanded = extension === "excavate" && excavateExtension(run);
      if (!expanded) break;
      followUpExcavation.push(expanded);
      continue;
    }
    const placement = placeTower(run, target);
    assert.ok(placement);
    followUpPlaced.push(placement);
  }
  const nextAfter = inspectRoute(navigation, routeProbe);
  if (followUpPlaced.length) assert.ok(nextAfter.searches > nextBefore.searches);
  const unspent = economy.cards.tower;
  const remaining = unspent ? [...reachablePlacementTargets(map, player.cell, unspent, battle).values()] : [];
  const affordableUnbuilt = unspent ? remaining.filter((site) => allowMergeDuringExtension || !map.previewBuildingSynthesis("tower", site)) : [];
  if (deployExtra) assert.equal(affordableUnbuilt.length, 0);
  const combat = [waveOne, fight(2, 1), fight(3, 1)];
  const cohortTotals = [...waveLedgers].map(([wave, ledger]) => ({ wave, ...summarize(ledger) }));
  assert.equal(combat.reduce((sum, phase) => sum + phase.killIncome, 0), economy.totals.killIncome);
  return {
    space, setup, extension, deployExtra, allowMergeDuringExtension, prePaidBudget: 43, initialPrice, extensionPrice,
    geometry: arena.layout, floorTilesBeforeFunding: arena.availableTiles, initialPlaced,
    beforeMerge, afterMerge, nextBefore, nextAfter, initiallyAvailable: [...initiallyAvailable.values()],
    followUpPlaced, followUpExcavation,
    reusedReleased: followUpPlaced.filter(({ site }) => fourth.released.some((at) => sameCell(at, site))).length,
    undeployedCards: unspent, remainingLegalSites: remaining,
    unusedReason: !unspent ? null : !deployExtra ? "hold-for-matched-control" : remaining.length ? "would-force-merge" : "no-reachable-legal-floor",
    economy: economy.totals, combat, cohortTotals,
  };
}

export function runTowerSpaceComparison(towerTuning = PLAYTEST_TOWER_TUNING) {
  const runs = ["open", "limited"].flatMap((space) => Object.keys(setups).flatMap((setup) =>
    ["hold", "extend"].map((extension) => scenario(space, setup, extension, towerTuning))));
  runs.push(scenario("limited", "dispersed", "allow-merge", towerTuning),
    scenario("limited", "dispersed", "excavate", towerTuning));
  return { seed, towerTuning, stepMs, combatLimitMs, budgets: { first: 25, extension: 18 }, runs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tuning = process.argv.includes("--control") ? CONTROL_TOWER_TUNING : PLAYTEST_TOWER_TUNING;
  console.log(JSON.stringify(runTowerSpaceComparison(tuning), null, 2));
}

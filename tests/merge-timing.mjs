import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { BIOME_PROTOTYPE } from "../src/biome-effects.ts";
import { PLAYTEST_TOWER_TUNING, evolvedTowerAttributes } from "../src/building-balance.ts";
import { placementFailure } from "../src/build-placement.ts";
import { DefenseSimulation, enemyWorldPosition, sameCell } from "../src/defense-simulation.ts";
import { EnemyNavigation } from "../src/enemy-navigation.ts";
import { DIFFICULTY_PROFILES, wavePopulation } from "../src/expedition-difficulty.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { ExplorationFog } from "../src/fog.ts";
import { MIDGAME_EXPERIMENTS, waveDeployment } from "../src/midgame-experiments.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { cellCenter, Player, worldToCell } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const key = ({ col, row }) => `${col},${row}`;
const entry = cell(1, 12);
const spawn = cell(7, 11);
const retained = cell(6, 12);
const goal = cell(12, 8);
const wallSite = cell(12, 9);
const probe = cell(8, 17);
const technology = cell(2, 26);
const technologyStance = cell(3, 26);
const seed = 848;
const stepMs = 20;
const rebuildInputSpacingMs = 60;
const initialPrices = [3, 3, 3, 6];
const reservePrices = [6, 6, 6];
const towerSites = {
  piercing: [retained, cell(7, 12), cell(8, 12), cell(9, 12)],
  burst: [retained, cell(7, 12), cell(8, 12), cell(6, 11)],
};
const scenarios = {
  opening: { wave: 1, stage: 0 },
  armored: { wave: 3, stage: 1 },
};
const knownArena = { allKnown: true, revision: 0, isKnown: () => true, isVisible: () => true };
const policies = ["control", "manual-early", "manual-approach", "manual-late", "hold"];
const miningRows = [22, 24, 27, 29];
const oreSites = Array.from({ length: 86 }, (_, i) => cell(4 + Math.floor(i / miningRows.length), miningRows[i % miningRows.length]));

function layoutForTiming() {
  const grid = Array.from({ length: 32 }, () => Array(28).fill("#"));
  const floor = ({ col, row }) => { grid[row][col] = "."; };
  const lane = [entry, cell(5, 12), cell(5, 17), cell(15, 17), cell(15, 12), cell(12, 12), goal];
  for (const [i, origin] of lane.slice(0, -1).entries()) {
    const destination = lane[i + 1];
    const dc = Math.sign(destination.col - origin.col);
    const dr = Math.sign(destination.row - origin.row);
    for (let p = origin; !sameCell(p, destination); p = cell(p.col + dc, p.row + dr)) floor(p);
  }
  for (let row = 13; row <= 17; row += 1) floor(cell(8, row));
  for (let col = 6; col <= 12; col += 1) floor(cell(col, 12));
  for (const site of [cell(6, 11), spawn, cell(8, 11), cell(9, 11), technology, technologyStance]) floor(site);
  for (const target of oreSites) {
    grid[target.row][target.col] = "+";
    floor(cell(target.col, target.row + 1));
  }
  grid[spawn.row][spawn.col] = "S";
  grid[goal.row][goal.col] = "G";
  return grid.map((row) => row.join(""));
}

function cardinal({ col, row }) {
  return [cell(col, row - 1), cell(col + 1, row), cell(col, row + 1), cell(col - 1, row)];
}

function legalPlacement(run, target, stance) {
  const { map, economy, battle } = run;
  const fog = new ExplorationFog(map.columns, map.rows);
  const sources = [...map.getBuildings()].filter(({ kind }) => kind === "tower")
    .map(({ cell: site }) => ({ cell: site, radius: BIOME_PROTOTYPE.towerVision }));
  fog.reveal(stance, sources);
  return placementFailure(map, target, {
    playerPosition: cellCenter(stance), roundEnded: run.round.phase === "lost", visible: fog.visibility(target) === "visible",
    reserved: [entry, goal, technology].some((site) => sameCell(site, target)),
    enemyOccupies: (position) => battle.occupies(position), cardCount: economy.cards.tower,
  });
}

function buildNearby(run, target) {
  const path = findPlacementPath(run, target);
  if (!path) return undefined;
  const start = run.battle.elapsedMs;
  for (const [i, from] of path.slice(0, -1).entries()) {
    const to = path[i + 1];
    for (let step = 0; step < 4; step += 1) {
      run.player.move(to.col - from.col, to.row - from.row, 50, run.map);
      run.tick(50);
      if (run.round.phase === "lost") return undefined;
    }
    assert.deepEqual(run.player.position, cellCenter(to));
  }
  if (legalPlacement(run, target, run.player.cell)) return undefined;
  const previousStock = run.economy.cards.tower;
  const placed = run.economy.placeCard("tower", target);
  assert.ok(placed, "a validated placement consumes a card and occupies the real map");
  assert.equal(run.economy.cards.tower, previousStock - 1);
  return { placed, target, stance: run.player.cell, startedAtMs: start, finishedAtMs: run.battle.elapsedMs };
}

function findPlacementPath(run, target) {
  const from = run.player.cell;
  const frontier = [from];
  const prior = new Map([[key(from), undefined]]);
  for (let index = 0; index < frontier.length; index += 1) {
    const position = frontier[index];
    if (Math.max(Math.abs(position.col - target.col), Math.abs(position.row - target.row)) === 1
      && !legalPlacement(run, target, position)) {
      const path = [position];
      for (let previous = prior.get(key(position)); previous; previous = prior.get(key(previous))) path.push(previous);
      return path.reverse();
    }
    for (const next of cardinal(position)) {
      if (prior.has(key(next)) || !run.map.isWalkable(next)) continue;
      prior.set(key(next), position);
      frontier.push(next);
    }
  }
  return undefined;
}

function payForTowers(economy) {
  for (const price of [...initialPrices, ...reservePrices]) {
    assert.equal(economy.drawCost, price);
    const balanceBefore = economy.balance;
    assert.equal(economy.drawCard(), "tower", "the fixed seed must issue the same paid supply");
    assert.equal(economy.balance, balanceBefore - price);
  }
}

function createRun(autoMerge) {
  const map = new TerrainMap(layoutForTiming(), { autoMerge, buildingBalance: "w25", towerEvolution: true });
  const economy = new ExpeditionEconomy(map, seed, technology, "challenge", MIDGAME_EXPERIMENTS.combined.economy);
  assert.equal(economy.balance, 0);
  // This separate preparation area supplies identical earned funds without changing the combat lanes.
  for (const target of oreSites) {
    const stance = cell(target.col, target.row + 1);
    let result;
    do {
      result = map.applyDigDamage(stance, target, MINING_CONFIG.damage, economy.toolLevel);
      assert.ok(result.effective);
      economy.creditMiningDamage(result.damage);
    } while (!result.cleared);
  }
  assert.equal(economy.balance, 43);
  assert.equal(placementFailure(map, technology, { playerPosition: cellCenter(technologyStance),
    roundEnded: false, visible: true, reserved: false, enemyOccupies: () => false }), undefined);
  assert.ok(economy.buildTechnology(technology));
  payForTowers(economy);
  assert.equal(economy.balance, 0);
  assert.equal(economy.cards.tower, 7);
  assert.equal(map.placeBuilding("wall", wallSite).hp, 25, "the wall is identical starting fortification in every setup");

  const events = [];
  const player = new Player(spawn);
  const round = new ExpeditionRound(false, "challenge");
  const battle = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    const reward = economy.handleEvent(event, metadata.waveId);
    let appliedPlayerDamage = 0;
    if (event.type === "playerHit") {
      const previousHp = round.playerHp;
      round.hitPlayer(event.damage);
      appliedPlayerDamage = previousHp - round.playerHp;
      battle.recordPlayerDamage(metadata.waveId, appliedPlayerDamage, metadata.timeMs);
      if (round.phase === "lost") battle.clearBattle();
    }
    events.push({ event, metadata, reward, appliedPlayerDamage });
  }, true, { towerTuning: PLAYTEST_TOWER_TUNING });
  const tick = (delta) => {
    economy.advance(delta);
    battle.step(delta, player);
    for (const enemy of battle.enemies) {
      const position = enemyWorldPosition(enemy);
      assert.ok(map.isWalkable(worldToCell(position.x, position.y)), "a live enemy center must stay on walkable ground");
    }
  };
  return { map, economy, events, player, round, battle, tick };
}

function inspectRoute(navigation) {
  const route = [probe];
  const visited = new Set([key(probe)]);
  while (true) {
    const step = navigation.next(route.at(-1), goal);
    if (step.kind !== "move") return { steps: route.length - 1, status: step.kind, target: goal, route };
    assert.ok(!visited.has(key(step.cell)), "the route probe must not cycle");
    visited.add(key(step.cell));
    route.push(step.cell);
  }
}

function liveEnemies(battle) {
  return [...battle.enemies].map((enemy) => ({ id: enemy.id, cell: enemy.cell, position: enemyWorldPosition(enemy),
    hp: enemy.hp, target: enemy.targetKey ?? null, move: enemy.move ? { ...enemy.move } : null }));
}

function summarize(events) {
  const shots = events.filter(({ event }) => event.type === "towerShot");
  const kills = events.filter(({ event }) => event.type === "towerKill");
  const contacts = events.filter(({ event }) => event.type === "wallImpact" || event.type === "buildingHit");
  const destroyed = contacts.flatMap(({ event, metadata }) => event.destroyed ? [{ id: event.wallId ?? event.buildingId,
    kind: event.buildingKind ?? "wall", atMs: metadata.timeMs }] : []);
  assert.equal(new Set(kills.map(({ event }) => event.enemyId)).size, kills.length);
  return {
    fireGroups: new Set(shots.map(({ event, metadata }) => `${event.towerId}:${metadata.timeMs}`)).size,
    participatingTowers: new Set(shots.map(({ event }) => event.towerId)).size,
    hits: shots.length, damage: shots.reduce((total, { event }) => total + event.damage, 0),
    kills: kills.length, killIncome: kills.reduce((total, { reward }) => total + reward, 0),
    firstDefenseContactMs: contacts[0]?.metadata.timeMs ?? null,
    wallDamage: contacts.filter(({ event }) => event.type === "wallImpact").reduce((total, { event }) => total + event.damage, 0),
    destroyed,
    playerDamage: events.reduce((total, { appliedPlayerDamage }) => total + appliedPlayerDamage, 0),
  };
}

function runPolicy(shape, policy, scenario, repair) {
  const run = createRun(policy === "control");
  const { map, battle, player, economy, events, round } = run;
  const navigation = new EnemyNavigation(map);
  const sites = towerSites[shape];
  const [oldest] = sites;
  for (const site of sites.slice(0, 3)) assert.ok(buildNearby(run, site));
  const controlForecast = map.previewBuildingSynthesis("tower", sites[3]);
  const beforeFourth = inspectRoute(navigation);
  const fourth = buildNearby(run, sites[3]);
  assert.ok(fourth);
  const ready = map.previewReadySynthesis(oldest);
  const readyIds = ready?.participants.map(({ id }) => id) ?? [];
  assert.equal(readyIds.length, policy === "control" ? 0 : 4);
  let merge;
  let rebuild;

  function recordMerge(before, upgraded, released, combatBefore, searchesBefore, startedBeforeFourth = false) {
    assert.equal(upgraded.level, 2);
    assert.equal(upgraded.hp, 1);
    assert.equal(upgraded.evolution.kind, shape);
    assert.deepEqual(upgraded.cell, oldest);
    assert.equal(released.length, 3);
    assert.ok(released.every((site) => map.isWalkable(site)));
    merge = { status: "merged", atMs: battle.elapsedMs, budget: economy.balance, before, after: inspectRoute(navigation),
      attributes: evolvedTowerAttributes(upgraded.evolution, map.getBiome(upgraded.cell), PLAYTEST_TOWER_TUNING),
      startedBeforeFourth, combatBefore, active: liveEnemies(battle), searchesBefore, released,
      freeCandidateCells: sites.filter((site) => map.isWalkable(site)).length,
      occupancyRevision: map.revision, towerId: upgraded.id };
  }

  function manualMerge() {
    const beforeEnemies = liveEnemies(battle);
    const before = inspectRoute(navigation);
    const oldStats = summarize(events);
    const searches = battle.searchCount;
    const beforeEconomy = economy.totals;
    const observedRisk = battle.previewMergeRoute(ready.released, player.cell, knownArena, true);
    const result = map.executeBuildingSynthesis(ready, player.cell);
    assert.deepEqual(liveEnemies(battle), beforeEnemies, "merge must leave live units and in-flight segments intact");
    assert.deepEqual(economy.totals, beforeEconomy, "manual action has no cost and cannot award money");
    assert.equal(battle.searchCount, searches, "only the following AI segment may replan");
    if (result.success) {
      recordMerge(before, result.building, result.released, oldStats, searches);
      merge.observedRisk = observedRisk;
    } else merge = { status: result.reason, atMs: battle.elapsedMs, active: beforeEnemies, before, combatBefore: oldStats, observedRisk };
  }

  if (policy === "control") {
    assert.ok(controlForecast);
    recordMerge(beforeFourth, fourth.placed, controlForecast.released, summarize(events), battle.searchCount, true);
  } else if (policy === "manual-early") {
    manualMerge();
    assert.equal(merge.status, "merged");
  }

  const { wave, stage } = scenarios[scenario];
  const count = wavePopulation("challenge", wave, 0);
  const order = { ...DIFFICULTY_PROFILES.challenge.stages[stage], count };
  const deployment = waveDeployment("combined", wave, { seed, stage, count });
  const waveStartedAtMs = battle.elapsedMs;
  assert.equal(battle.requestWave(wave, order, deployment), count);
  const deadline = waveStartedAtMs + 10_000;
  while (round.phase !== "lost" && battle.elapsedMs < deadline) {
    const elapsed = battle.elapsedMs - waveStartedAtMs;
    const units = [...battle.enemies];
    const midStride = units.some(({ move }) => move && move.elapsedMs > 0 && move.elapsedMs < move.durationMs);
    if (!merge && midStride && ((policy === "manual-approach" && elapsed >= 260)
      || (policy === "manual-late" && elapsed >= 500))) manualMerge();

    if (repair && !rebuild && merge?.status === "merged" && elapsed >= 720) {
      const startedAtMs = battle.elapsedMs;
      const placements = [];
      for (const [index, site] of merge.released.entries()) {
        // A fixed replay cadence separates individual inputs. This is not a game placement delay.
        for (let waiting = 0; index > 0 && waiting < rebuildInputSpacingMs && round.phase !== "lost"; waiting += stepMs) {
          run.tick(stepMs);
        }
        if (round.phase === "lost") break;
        const placement = buildNearby(run, site);
        if (placement) placements.push(placement);
      }
      rebuild = { startedAtMs, finishedAtMs: battle.elapsedMs, placements,
        delayFromMergeMs: startedAtMs - merge.atMs,
        paidCardsLeft: economy.cards.tower, restoredRoute: inspectRoute(navigation) };
    }

    const { spawned, removed, pending } = battle.spawnCounts;
    if (pending === 0 && spawned === removed) break;
    run.tick(stepMs);
  }

  const combat = summarize(events);
  const waveMetrics = battle.getWaveMetrics(wave);
  assert.equal(waveMetrics.towerKills, combat.kills);
  assert.equal(waveMetrics.playerDamage, combat.playerDamage);
  assert.equal(economy.totals.killIncome, combat.killIncome);
  assert.equal(economy.totals.cardSpend, 33);
  if (merge?.status === "merged") {
    merge.searchesAfter = battle.searchCount;
    merge.timeFromWaveStartMs = merge.atMs - waveStartedAtMs;
    if (merge.active.length) assert.ok(battle.searchCount > merge.searchesBefore);
  }
  return { shape, policy, scenario, repair, wave, waveStartedAtMs, order, deployment, readyIds, merge: merge ?? null,
    rebuild: rebuild ?? null, economy: economy.totals, combat, liveAtEnd: liveEnemies(battle), playerHp: round.playerHp,
    spawned: waveMetrics.spawned, activeAtEnd: waveMetrics.active, navigationSearches: battle.searchCount,
    endLevelOneTowers: [...map.getBuildings()].filter(({ kind, level }) => kind === "tower" && level === 1).length };
}

export function runMergeTiming() {
  const runs = Object.keys(towerSites).flatMap((shape) => Object.keys(scenarios).flatMap((scenario) =>
    policies.flatMap((policy) => [false, true].map((repair) => runPolicy(shape, policy, scenario, repair)))));
  return { seed, stepMs, rebuildInputSpacingMs, setup: "Challenge/W25/Combined, shared W25 starting wall, physically paid 4+3 cards.",
    prices: { technology: 10, initial: initialPrices, reserve: reservePrices },
    probe: "Fixed-goal EnemyNavigation route from the corridor probe; separate from any live unit's target.", runs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runMergeTiming(), null, 2));
}

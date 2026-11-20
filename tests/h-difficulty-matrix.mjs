import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { placementFailure } from "../src/build-placement.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { generateExpeditionBiomes } from "../src/expedition-biomes.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { addExpeditionApproach, addExpeditionTiers, PLAY_GENERATOR_VERSION } from "../src/expedition-terrain.ts";
import { ExplorationFog } from "../src/fog.ts";
import { DEFAULT_MAP_SEED, generateExpeditionWorld, GENERATED_ENEMY_ENTRY, GENERATED_GOAL } from "../src/generated-map.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { MiningSession } from "../src/mining.ts";
import { cellCenter, Player } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { WaveEconomyHistory } from "../src/wave-economy-history.ts";

const profiles = ["baseline", "a", "b"];
const speeds = { normal: false, "wait-test": "wait-test", "legacy-fast": true };
const seeds = [
  { seed: 12, kind: "reference" },
  { seed: 84, kind: "short excavation" },
  { seed: 71, kind: "detours" },
  { seed: 89, kind: "high rock" },
];
const strategies = ["no-defense", "basic", "tunnel"];
const stepMs = 25;
const moveMs = 200;
const deadlineMs = 190_000;
const tunnelEnd = { col: 20, row: 91 };

function cell(col, row) { return { col, row }; }
function same(a, b) { return a.col === b.col && a.row === b.row; }
function finished(round) { return round?.phase === "won" || round?.phase === "lost"; }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function commandCost(tile) {
  return moveMs + (tile.terrain === "dirt" ? Math.max(0, Math.ceil(tile.hp / MINING_CONFIG.damage) - 1) * MINING_CONFIG.attackIntervalMs : 0);
}

function openDistance(map, start, end) {
  const queue = [{ ...start, distance: 0 }];
  const key = ({ col, row }) => row * map.columns + col;
  const visited = new Set([key(start)]);
  for (let i = 0; i < queue.length; i += 1) {
    const { col, row, distance } = queue[i];
    if (same(end, { col, row })) return distance;
    for (const next of map.getWalkableNeighbors({ col, row })) {
      if (visited.has(key(next))) continue;
      visited.add(key(next));
      queue.push({ ...next, distance: distance + 1 });
    }
  }
  return null;
}

function shortestRoute(map, start, goal, costOf) {
  // Test-only weighted search; the recorded player still moves and digs through the real models.
  const key = ({ col, row }) => row * map.columns + col;
  const first = key(start);
  const last = key(goal);
  const size = map.columns * map.rows;
  const best = new Float64Array(size).fill(Infinity);
  const parent = new Int32Array(size).fill(-1);
  const settled = new Uint8Array(size);
  best[first] = 0;
  for (;;) {
    let current = -1;
    for (let i = 0; i < size; i += 1) {
      if (!settled[i] && best[i] < (current < 0 ? Infinity : best[current])) current = i;
    }
    assert.notEqual(current, -1, "fixed seed has no legal excavation route");
    if (current === last) break;
    settled[current] = 1;
    const col = current % map.columns;
    const row = Math.floor(current / map.columns);
    for (const next of [cell(col, row - 1), cell(col + 1, row), cell(col, row + 1), cell(col - 1, row)]) {
      const tile = map.getCell(next);
      if (!tile || tile.buildingId !== null || (tile.terrain !== "empty" && tile.terrain !== "dirt")) continue;
      const index = key(next);
      const cost = best[current] + costOf(tile);
      if (cost >= best[index]) continue;
      best[index] = cost;
      parent[index] = current;
    }
  }
  const path = [];
  for (let current = last; current !== first; current = parent[current]) {
    path.push(cell(current % map.columns, Math.floor(current / map.columns)));
  }
  return { path: path.reverse(), cost: best[last] };
}

function createTerrain(seed) {
  const world = generateExpeditionWorld(seed);
  assert.equal(world.effectiveSeed, seed, "matrix seeds are selected real maps");
  const { layout, biomes } = generateExpeditionBiomes(world.layout, world.effectiveSeed);
  const finalLayout = addExpeditionApproach(addExpeditionTiers(layout, world.effectiveSeed));
  return { map: new TerrainMap(finalLayout, { biomes }), fingerprint: digest([finalLayout, biomes]) };
}

function inspectSeed({ seed, kind }) {
  const { map, fingerprint } = createTerrain(seed);
  let interiorRocks = 0;
  let water = 0;
  for (let row = 1; row < map.rows - 1; row += 1) {
    for (let col = 1; col < map.columns - 1; col += 1) {
      const tile = map.getCell(cell(col, row));
      if (tile.terrain === "rock") interiorRocks += 1;
      if (tile.terrain === "water") water += 1;
    }
  }
  const shortest = shortestRoute(map, map.spawn, GENERATED_GOAL, () => 1);
  const fastest = shortestRoute(map, map.spawn, GENERATED_GOAL, commandCost);
  const excavation = { level1: 0, level2: 0 };
  for (const position of fastest.path) {
    const tile = map.getCell(position);
    if (tile.terrain === "dirt") excavation[tile.terrainLevel === 2 ? "level2" : "level1"] += 1;
  }
  return {
    seed, kind, fingerprint, interiorRocks, water, shortestCarvableSteps: shortest.cost,
    weightedRouteSteps: fastest.path.length, estimatedTravelAndMiningMs: fastest.cost,
    ...excavation,
  };
}

export function screenDifficultySeeds() {
  const screened = [...Array.from({ length: 99 }, (_, index) => index), DEFAULT_MAP_SEED, 0xffff_ffff];
  return screened.map((seed) => inspectSeed({ seed }));
}

function createRun(seed, clock, profile) {
  const { map, fingerprint } = createTerrain(seed);
  const economy = new ExpeditionEconomy(map, seed);
  const player = new Player(map.spawn);
  const fog = new ExplorationFog(map.columns, map.rows);
  const mining = new MiningSession(map, MINING_CONFIG, () => economy.toolLevel);
  const round = profile ? new ExpeditionRound(speeds[clock], profile) : undefined;
  const ledger = new WaveEconomyHistory(economy.totals);
  const waveOrders = [];
  const losses = { wall: 0, tower: 0, economy: 0, technology: 0 };
  let firstPhysicalContactAtMs = null;
  const failures = [];
  const purchases = [];
  const tickTimes = [];
  let now = 0;
  let exit = null;
  let excavated = 0;
  let peakActiveSampled = 0;
  let maximumPendingSampled = 0;

  const battle = round && new DefenseSimulation(map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, (event, metadata) => {
    ledger.creditKill(metadata.waveId, economy.handleEvent(event));
    if (event.type === "wallImpact" && event.destroyed) losses.wall += 1;
    if (event.type === "buildingHit" && event.destroyed) {
      losses[event.buildingKind] += 1;
    }
    if (event.type === "playerHit") {
      firstPhysicalContactAtMs ??= metadata.timeMs;
      const previous = round.playerHp;
      round.hitPlayer(event.damage);
      battle.recordPlayerDamage(metadata.waveId, previous - round.playerHp, metadata.timeMs);
      if (finished(round)) endAt(metadata.timeMs);
    }
    if (event.type === "buildingHit" || event.type === "wallImpact") {
      firstPhysicalContactAtMs ??= metadata.timeMs;
    }
  }, true);

  function samplePopulation() {
    const { spawned, removed, pending } = battle.spawnCounts;
    peakActiveSampled = Math.max(peakActiveSampled, spawned - removed);
    maximumPendingSampled = Math.max(maximumPendingSampled, pending);
  }

  function endAt(timeMs) {
    exit = { timeMs, population: { ...battle.spawnCounts } };
    battle.clearBattle();
  }

  function advance(onTick) {
    if (finished(round)) return;
    const started = performance.now();
    now += stepMs;
    if (onTick) onTick();
    if (round && map.isGoal(player.cell) && round.reachGoal(economy.toolLevel)) {
      endAt(now);
    }
    if (round && !finished(round)) {
      const phase = round.phase;
      const { spawned, removed, pending } = battle.spawnCounts;
      const active = spawned - removed;
      const order = round.update(stepMs, player.cell.row, active, pending);
      if (order) {
        waveOrders.push({ waveId: round.wave, stage: round.stage, pressure: round.pressure, issuedAtMs: now, ...order });
        ledger.startWave(round.wave, economy.totals);
        assert.equal(battle.requestWave(round.wave, order), order.count);
        samplePopulation();
      }
      if (phase === "attacking" && round.phase === "recovering") {
        battle.finishAttackPhase(round.wave, active === 0 && pending === 0 ? "resolved" : "time-limit");
      }
      economy.advance(stepMs);
      battle.step(stepMs, player.cell);
      samplePopulation();
    } else if (!round) {
      economy.advance(stepMs);
    }
    if (battle) tickTimes.push(performance.now() - started);
  }

  function wait(durationMs, callback) {
    assert.equal(durationMs % stepMs, 0, "all scripted times use fixed simulation steps");
    for (let elapsed = 0; elapsed < durationMs && !finished(round); elapsed += stepMs) {
      advance();
      if (!finished(round)) callback?.();
    }
  }

  function fail(action, reason) {
    failures.push({ action: action.type, target: action.target, card: action.kind, timeMs: now, reason });
  }

  function execute(action) {
    if (finished(round)) return;
    const { type, target, durationMs } = action;
    if (type === "move") {
      const from = player.cell;
      if (!same(from, action.from)) {
        fail(action, "origin-changed");
        wait(durationMs);
        return;
      }
      const dx = target.col - from.col;
      const dy = target.row - from.row;
      for (let elapsed = 0; elapsed < durationMs && !finished(round); elapsed += stepMs) {
        advance(() => player.move(dx, dy, stepMs, map));
      }
      if (!finished(round) && !same(player.cell, target)) fail(action, "movement-blocked");
    } else if (type === "mine") {
      const from = player.cell;
      const reason = map.getDigFailure(from, target, economy.toolLevel);
      if (reason) {
        fail(action, reason);
        wait(durationMs);
        return;
      }
      mining.begin(from, target, now);
      wait(durationMs, () => mining.update(from, now, target));
      mining.stop();
      if (map.isWalkable(target)) excavated += 1;
      else if (!finished(round)) fail(action, "not-excavated");
    } else if (type === "place") {
      fog.reveal(player.cell);
      const reason = placementFailure(map, target, {
        playerPosition: player.position,
        roundEnded: finished(round),
        visible: fog.visibility(target) === "visible",
        reserved: same(target, GENERATED_ENEMY_ENTRY) || same(target, GENERATED_GOAL) || same(target, economy.technologyCell),
        enemyOccupies: (position) => battle?.occupies(position) ?? false,
        cardCount: economy.cards[action.kind],
      });
      if (reason || !economy.placeCard(action.kind, target)) fail(action, reason ?? "placement-rejected");
    } else if (type === "research") {
      if (!economy.researchTool()) fail(action, "research-rejected");
    } else if (type === "draw") {
      const reason = economy.drawFailure;
      const card = economy.drawCard();
      purchases.push({ atMs: now, card: card ?? null, reason: reason ?? null });
    } else {
      assert.equal(type, "wait");
      wait(durationMs);
    }
  }

  function snapshot() {
    const waveEconomy = ledger.snapshot(economy.totals);
    const waves = battle.waveMetrics.map((wave, index) => ({
      ...wave, order: waveOrders[index],
      towerKillRate: wave.spawned === 0 ? null : wave.towerKills / wave.spawned,
      economy: waveEconomy[index + 1],
    }));
    const initial = (field) => waves.map((wave) => wave[field]).filter((time) => time !== null).reduce((a, b) => a === null ? b : Math.min(a, b), null);
    const times = tickTimes.toSorted((a, b) => a - b);
    return {
      seed, clock, profile, fingerprint, finalPhase: round.phase,
      outcome: finished(round) ? round.phase : "timeout", elapsedMs: exit?.timeMs ?? now, executedUntilMs: now,
      player: { cell: player.cell, hp: round.playerHp, stage: round.stage, pressure: round.pressure },
      wave: round.wave, waves, preWaveEconomy: waveEconomy[0], economy: economy.totals, purchases, failures, excavated,
      spawnTotals: battle.spawnCounts, preTerminalPopulation: exit?.population ?? null,
      peakActiveSampled, maximumPendingSampled, losses,
      firstSpawnAtMs: initial("firstSpawnAtMs"), firstThreatAtMs: initial("firstThreatAtMs"), firstPhysicalContactAtMs,
      firstBuildingDamageAtMs: initial("firstBuildingDamageAtMs"), firstPlayerDamageAtMs: initial("firstPlayerDamageAtMs"),
      counters: { ...battle.counters },
      modelPerformance: {
        navigationSearches: battle.searchCount, navigationCpuMs: battle.searchTimeMs,
        tickP95Ms: times[Math.ceil(times.length * .95) - 1], tickMaxMs: times.at(-1),
      },
    };
  }

  return { map, player, economy, execute, snapshot, failures, get now() { return now; } };
}

function compileScenario(seed, strategy, clock) {
  // The plan has no round or enemies. Combat can change outcomes during replay, but never changes this input.
  const plan = createRun(seed, clock);
  const actions = [];
  function doAction(action) {
    actions.push(action);
    plan.execute(action);
    assert.equal(plan.failures.length, 0, JSON.stringify(plan.failures.at(-1)));
  }
  function waitTo(timeMs) {
    if (timeMs > plan.now) doAction({ type: "wait", durationMs: timeMs - plan.now });
  }
  function place(kind, col, row) { doAction({ type: "place", kind, target: cell(col, row) }); }
  function mine(target) {
    if (plan.map.isWalkable(target)) return;
    const durationMs = commandCost(plan.map.getCell(target)) - moveMs;
    doAction({ type: "mine", target, durationMs });
  }
  function move(target, dig) {
    if (dig) mine(target);
    const from = plan.player.cell;
    assert.equal(Math.abs(target.col - from.col) + Math.abs(target.row - from.row), 1, "only adjacent motion is scripted");
    doAction({ type: "move", from, target, durationMs: moveMs });
    assert.deepEqual(plan.player.position, cellCenter(target));
  }
  function line(col, row, dig = false) {
    const from = plan.player.cell;
    const dc = Math.sign(col - from.col);
    const dr = Math.sign(row - from.row);
    assert.ok(dc === 0 || dr === 0, "script lines are cardinal");
    const length = Math.abs(col - from.col) + Math.abs(row - from.row);
    for (let i = 1; i <= length; i += 1) move(cell(from.col + i * dc, from.row + i * dr), dig);
  }

  const startingEntryRoute = openDistance(plan.map, GENERATED_ENEMY_ENTRY, tunnelEnd);
  if (strategy !== "no-defense") place("economy", 18, 92);
  line(21, 92);
  line(21, 94);
  if (strategy === "no-defense") {
    line(26, 94);
  } else if (strategy === "basic") {
    line(28, 94);
    place("tower", 29, 93);
    line(29, 94);
    place("tower", 30, 93);
    line(23, 94);
    place("wall", 24, 94);
    line(21, 94);
    line(21, 92);
    line(plan.map.spawn.col, plan.map.spawn.row);
  } else {
    assert.equal(strategy, "tunnel");
    place("wall", 22, 94);
    line(21, 86);
    place("tower", 22, 85);
    line(21, 88);
    place("tower", 22, 89);
    line(21, 86);
    line(30, 86, true);
    line(30, 90, true);
    mine(cell(30, 91));
    line(30, 86);
    line(19, 86);
    line(plan.map.spawn.col, plan.map.spawn.row);
  }

  const approachSteps = openDistance(plan.map, GENERATED_ENEMY_ENTRY, tunnelEnd);
  let departureAtMs = null;
  if (strategy !== "no-defense") {
    waitTo(8_000);
    doAction({ type: "research" });
    for (const timeMs of clock === "normal" ? [20_000, 32_000] : [plan.now + 500, plan.now + 1_000]) {
      waitTo(timeMs);
      doAction({ type: "draw" });
    }
    if (clock === "normal") waitTo(95_000);
    departureAtMs = plan.now;
    const route = shortestRoute(plan.map, plan.player.cell, GENERATED_GOAL, commandCost);
    for (const target of route.path) move(target, true);
  }
  waitTo(deadlineMs);

  const script = { seed, strategy, clock, actions };
  return {
    ...script, digest: digest({ seed, strategy, actions }), departureAtMs,
    geometry: { startingEntryRoute, approachSteps, position: tunnelEnd },
  };
}

export function replayDifficultyScenario(script, profile) {
  const { seed, strategy, clock } = script;
  const run = createRun(seed, clock, profile);
  for (const action of script.actions) run.execute(action);
  return { strategy, inputDigest: script.digest, ...run.snapshot() };
}

export function runDifficultyMatrix({ includeLegacy = false } = {}) {
  const scripts = [];
  const cases = [];
  for (const clock of includeLegacy ? ["normal", "wait-test", "legacy-fast"] : ["normal", "wait-test"]) {
    for (const { seed } of seeds) {
      for (const strategy of strategies) {
        const script = compileScenario(seed, strategy, clock);
        scripts.push(script);
        for (const profile of profiles) cases.push(replayDifficultyScenario(script, profile));
      }
    }
  }
  return {
    schemaVersion: 1, generatorVersion: PLAY_GENERATOR_VERSION, stepMs, deadlineMs, nodeVersion: process.version,
    seeds: seeds.map(inspectSeed), scripts, cases,
  };
}

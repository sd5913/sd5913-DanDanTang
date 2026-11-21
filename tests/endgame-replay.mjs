import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isWithinSynthesisRange } from "../src/buildings.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { generateExpeditionBiomes } from "../src/expedition-biomes.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { addExpeditionApproach, addExpeditionTiers } from "../src/expedition-terrain.ts";
import { GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionWorld } from "../src/generated-map.ts";
import { PLAYTEST_PROFILE } from "../src/launch-config.ts";
import { evacuationDeployment, MIDGAME_EXPERIMENTS, waveDeployment } from "../src/midgame-experiments.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { MiningSession } from "../src/mining.ts";
import { TerrainMap } from "../src/terrain.ts";
import { OpeningRun } from "./challenge-opening.mjs";

const { difficulty, buildingBalance, midgame, towerTuning } = PLAYTEST_PROFILE;
const frameMs = 25;
const openingSite = { col: 29, row: 94 };
const openingBuilder = { col: 28, row: 94 };
const fixedSeeds = [9, 12, 515, 1091];
const strategies = ["B1", "B2", "B3", "B4"];
const directions = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const cell = (col, row) => ({ col, row });
const distance = (a, b) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
const adjacent = ({ col, row }) => directions.map(([dx, dy]) => cell(col + dx, row + dy));
const surrounding = (from) => [-1, 0, 1].flatMap((dy) => [-1, 0, 1].flatMap((dx) =>
  dx === 0 && dy === 0 ? [] : [cell(from.col + dx, from.row + dy)]));

function traceRoute(map, from, destination, accepts, weight = () => 1) {
  const index = ({ col, row }) => row * map.columns + col;
  const position = (key) => cell(key % map.columns, Math.floor(key / map.columns));
  const best = new Float64Array(map.columns * map.rows).fill(Infinity);
  const previous = new Int32Array(best.length).fill(-1);
  const start = index(from);
  const finish = index(destination);
  const queue = [{ key: start, cost: 0 }];
  best[start] = 0;
  while (queue.length) {
    queue.sort((a, b) => b.cost - a.cost);
    const { key, cost } = queue.pop();
    if (cost !== best[key]) continue;
    if (key === finish) {
      const route = [];
      for (let current = finish; current !== -1; current = previous[current]) route.push(position(current));
      return route.reverse();
    }
    for (const neighbor of adjacent(position(key))) {
      if (!map.isInside(neighbor) || !accepts(neighbor)) continue;
      const next = index(neighbor);
      const nextCost = cost + weight(neighbor);
      if (nextCost >= best[next]) continue;
      best[next] = nextCost;
      previous[next] = key;
      queue.push({ key: next, cost: nextCost });
    }
  }
  return [];
}

function excavatableRoute(map, from, goal) {
  return traceRoute(map, from, goal, (next) => {
    const tile = map.getCell(next);
    return map.isWalkable(next) || (tile.terrain === "dirt" && tile.terrainLevel <= 2);
  }, (next) => {
    const tile = map.getCell(next);
    return tile.terrain === "dirt" ? 8 + tile.hp * 5 : 8;
  });
}

function floorRoute(map, from, to, avoided = [], extraFloor = []) {
  return traceRoute(map, from, to, (next) => (map.isWalkable(next) || extraFloor.some((site) => distance(site, next) === 0)) &&
    !avoided.some((site) => distance(site, next) === 0));
}

class EndgameRun extends OpeningRun {
  constructor(seed, rules = {}) {
    super(seed, difficulty, buildingBalance, midgame);
    const world = generateExpeditionWorld(seed);
    const { layout, biomes } = generateExpeditionBiomes(world.layout, world.effectiveSeed);
    this.map = new TerrainMap(addExpeditionApproach(addExpeditionTiers(layout, world.effectiveSeed)), {
      biomes, buildingBalance, towerEvolution: rules.classicTowers !== true, autoMerge: false,
    });
    this.economy = new ExpeditionEconomy(this.map, this.effectiveSeed, undefined, difficulty, MIDGAME_EXPERIMENTS[midgame].economy);
    this.mining = new MiningSession(this.map, MINING_CONFIG, () => this.economy.toolLevel);
    this.round = new ExpeditionRound(false, difficulty, true);
    this.merges = [];
    this.facilities = [];
    this.actions = [];
    this.finalKillIncome = 0;
    this.simulation = new DefenseSimulation(this.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, (event, metadata) => {
      const { waveId, evacuationBatch, timeMs } = metadata;
      if (["playerHit", "wallImpact", "buildingHit", "towerKill", "towerEffect", "towerShot", "evacuationHit"].includes(event.type)) {
        this.combatEvents.push({ ...event, waveId, evacuationBatch, timeMs, towerHit: metadata.towerHit?.kind });
      }
      const cohort = waveId ?? (evacuationBatch === undefined ? undefined : -evacuationBatch);
      const credit = this.economy.handleEvent(event, cohort);
      if (evacuationBatch !== undefined) this.finalKillIncome += credit;
      if (event.type === "playerHit") {
        const previousHp = this.round.playerHp;
        this.round.hitPlayer(event.damage);
        this.simulation.recordPlayerDamage(waveId, previousHp - this.round.playerHp, timeMs);
      }
      if (event.type === "evacuationHit") {
        const damage = this.round.hitEvacuation(event.damage);
        this.simulation.recordEvacuationDamage(evacuationBatch, damage);
      }
      if (this.finished) this.resolve();
    }, true, { towerTuning: rules.towerTuning ?? towerTuning, towerTargeting: true });
    this.initial = this.economicState();
  }

  resolve() {
    this.endAtMs = this.now;
    this.simulation.clearBattle();
  }

  tick(move, deltaMs = frameMs) {
    if (this.finished) return;
    this.now += deltaMs;
    move?.();
    const { spawned, removed, pending } = this.simulation.spawnCounts;
    const phase = this.round.phase;
    const order = this.round.update(deltaMs, this.player.cell.row, spawned - removed, pending);
    if (order) {
      this.waves.push({ atMs: this.now, order });
      assert.equal(this.simulation.requestWave(this.round.wave, order, waveDeployment(midgame, this.round.wave, {
        seed: this.effectiveSeed, stage: this.round.stage, count: order.count,
      })), order.count);
    }
    if (phase === "attacking" && this.round.phase === "recovering") {
      this.simulation.finishAttackPhase(this.round.wave, spawned === removed && pending === 0 ? "resolved" : "time-limit");
    }
    this.economy.advance(deltaMs);
    this.observeAffordability();
    this.simulation.step(deltaMs, this.player);
    if (this.round.phase !== "evacuating") return;
    const batch = this.round.updateEvacuation(deltaMs, this.simulation.evacuationBatches);
    if (batch) this.queue(batch);
    if (this.finished) this.resolve();
  }

  queue({ batch, order }) {
    const deployment = evacuationDeployment(midgame, batch, {
      seed: this.effectiveSeed, stage: this.round.stage, count: order.count,
    });
    assert.equal(this.simulation.requestEvacuationBatch(batch, order, deployment), order.count);
  }

  buildTechnology(site) {
    assert.equal(this.checkPlacement("technology", site), undefined);
    assert.ok(this.economy.buildTechnology(site));
    this.facilities.push({ from: this.player.cell, site, atMs: this.now });
    this.record({ type: "technology", target: site });
  }

  record(action) { this.actions.push({ ...action, atMs: this.now }); }

  mine(target) {
    this.record({ type: "dig", target });
    return super.mine(target);
  }

  draw() {
    const card = super.draw();
    this.record({ type: "draw", card });
    return card;
  }

  place(kind, target) {
    this.record({ type: "place", kind, target });
    return super.place(kind, target);
  }

  moveOne(target) {
    this.record({ type: "walk", target });
    super.moveOne(target);
    if (!this.finished && distance(this.player.cell, GENERATED_GOAL) === 0) this.arrivedAt ??= this.now;
  }

  openRoute(route) {
    for (const next of route.slice(1)) {
      if (this.finished) return;
      if (!this.map.isWalkable(next)) this.mine(next);
      if (!this.finished) this.moveOne(next);
    }
  }

  startEvacuation() {
    assert.ok(distance(this.player.cell, GENERATED_GOAL) <= 1);
    assert.equal(this.round.reachGoal(this.economy.toolLevel), false);
    assert.notEqual(this.round.phase, "won");
    const batch = this.round.activateEvacuation(this.economy.toolLevel, this.player.cell.row);
    assert.ok(batch);
    this.activatedAt = this.now;
    this.record({ type: "evacuate" });
    this.queue(batch);
  }

  report(strategy) {
    return {
      strategy, seed: this.seed, effectiveSeed: this.effectiveSeed, arrivedAt: this.arrivedAt ?? null,
      activatedAt: this.activatedAt ?? null, endedAt: this.endAtMs ?? this.now,
      start: this.initial, final: this.economicState(), playerCell: this.player.cell,
      outcome: this.round.phase, lossReason: this.round.lossReason ?? null, evacuation: this.round.evacuation,
      batches: this.simulation.evacuationBatches, peakFinalEnemies: this.simulation.evacuationPeakActive,
      routeBlocked: this.simulation.evacuationRouteBlocked, finalKillIncome: this.finalKillIncome,
      facilities: this.facilities, draws: this.draws, construction: this.construction, merges: this.merges,
      waves: this.waves, ordinaryCombat: this.simulation.waveMetrics, combat: this.combatEvents,
      opening: this.opening, actions: this.actions,
    };
  }
}

function approachNorth(run) {
  assert.equal(run.economy.balance, 0);
  assert.deepEqual(run.economy.cards, { wall: 0, tower: 0, economy: 0 });
  assert.equal([...run.map.getBuildings()].length, 0);
  run.mineToIncome(100);
  const facilityOre = run.miningActions.map(({ from, target }) => ({ from, target }));
  run.moveTo(openingBuilder);
  run.buildTechnology(openingSite);
  run.mineToIncome(300);
  const researchOre = run.miningActions.slice(facilityOre.length).map(({ from, target }) => ({ from, target }));
  assert.ok(run.economy.researchTool());
  run.record({ type: "research" });
  const north = excavatableRoute(run.map, run.player.cell, GENERATED_GOAL);
  assert.ok(north.length > 1, "the route must reach the north");
  run.opening = { facilityOre, builder: openingBuilder, site: openingSite, researchOre, north };
  run.openRoute(north);
}

export function endgameOpening(seed) {
  const run = new EndgameRun(seed);
  approachNorth(run);
  return run.opening;
}

function openNorthernOre(run, funds, deadline) {
  const area = 18;
  while (run.economy.balance < funds && !run.finished && run.now < deadline) {
    const starts = [run.player.cell];
    const visited = new Set();
    let target;
    let origin;
    for (const start of starts) {
      const key = start.row * run.map.columns + start.col;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const next of adjacent(start)) {
        if (distance(next, GENERATED_GOAL) > area) continue;
        if (run.map.isWalkable(next)) starts.push(next);
        else if (!run.map.getDigFailure(start, next, run.economy.toolLevel) && preserveGates(run, [next])) {
          target = next;
          origin = start;
          break;
        }
      }
      if (target) break;
    }
    if (!target) return false;
    run.moveTo(origin);
    if (!run.finished) run.mine(target);
  }
  return run.economy.balance >= funds && !run.finished;
}

function preserveGates(run, excavations) {
  const gates = run.protectedGates ?? [];
  return gates.every((gate) => !floorRoute(run.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, [gate], [...gates, ...excavations]).length);
}

function obtainCards(run, walls, towers, onDraw, deadline = 260_000) {
  if (!run.economy.hasTechnology) {
    run.moveTo(GENERATED_GOAL);
    const site = surrounding(run.player.cell).find((candidate) =>
      !run.checkPlacement("technology", candidate) &&
      floorRoute(run.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, [candidate]).length);
    assert.ok(site, "an out-of-corridor facility site");
    run.buildTechnology(site);
  }
  while ((run.economy.cards.wall < walls || run.economy.cards.tower < towers) && !run.finished) {
    if (!openNorthernOre(run, run.economy.drawCost, deadline)) return false;
    const card = run.draw();
    if (!card) return false;
    if (card === "economy" && run.protectedGates && run.economy.totals.productionIncome < 20) {
      const orchard = surrounding(run.player.cell).find((site) => distance(site, GENERATED_GOAL) >= 4 &&
        run.protectedGates.every((gate) => distance(site, gate) >= 3) && !run.checkPlacement("economy", site));
      if (orchard) run.place("economy", orchard);
    }
    onDraw?.(card);
    // Paid crafting has no in-game wait, but leave time to select and confirm the action.
    for (let i = 0; i < 4 && !run.finished; i += 1) run.tick();
  }
  return !run.finished;
}

function placeAt(run, kind, site, prefer = () => 0) {
  const options = surrounding(site)
    .filter((builder) => run.map.isWalkable(builder))
    .filter((builder) => floorRoute(run.map, builder, GENERATED_GOAL, [site]).length)
    .map((builder) => ({ builder, route: floorRoute(run.map, run.player.cell, builder) }))
    .filter(({ route }) => route.length)
    .sort((a, b) => prefer(a.builder) - prefer(b.builder) || a.route.length - b.route.length);
  for (const { route } of options) {
    run.openRoute(route);
    if (run.finished) return false;
    if (run.checkPlacement(kind, site)) continue;
    run.place(kind, site);
    return true;
  }
  return false;
}

function fortify(run, strategy) {
  const attackRoute = floorRoute(run.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL);
  assert.ok(attackRoute.length, "entry must have a connected, excavated route");
  if (strategy === "B1") return;
  if (strategy === "B4") {
    fortifyAdvanced(run, attackRoute);
    return;
  }
  const expected = strategy === "B2" ? [1, 0] : [4, 2];
  if (!obtainCards(run, ...expected)) return;
  // Deploy from the south-facing side towards the goal to maintain access to all planned wall sites.
  const openRoute = floorRoute(run.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL);
  const cuts = openRoute.filter((site) => site.row >= 7 && site.row < 32 &&
    !floorRoute(run.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, [site]).length);
  const wallSites = cuts.slice(-expected[0]);
  const front = wallSites[0];
  if (!front) return;
  for (const site of wallSites) {
    if (run.finished) return;
    if (!placeAt(run, "wall", site, (builder) => distance(builder, GENERATED_GOAL))) break;
  }
  if (expected[1] && !run.finished) buildTowers(run, strategy, openRoute, wallSites.at(-1));
}

function fortifyAdvanced(run, assault) {
  const cuts = assault.filter((site) => site.row >= 7 && site.row < 32 &&
    !floorRoute(run.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, [site]).length);
  const reserveSite = cuts.at(-1);
  const gates = cuts.slice(-6, -1);
  const first = gates[0];
  const second = gates[1];
  if (!first || !second) return;
  run.protectedGates = [...gates, reserveSite];
  if (!obtainCards(run, 1, 0) || !placeAt(run, "wall", first, (builder) => distance(builder, GENERATED_GOAL))) return;
  if (!obtainCards(run, 1, 0) || !placeAt(run, "wall", second, (builder) => distance(builder, GENERATED_GOAL))) return;
  let nextGate = 2;
  const reinforce = () => {
    const site = gates[nextGate];
    if (run.economy.cards.wall && site && placeAt(run, "wall", site, (builder) => distance(builder, GENERATED_GOAL))) {
      nextGate += 1;
    }
  };
  if (!obtainCards(run, 0, 4, reinforce)) return;
  if (run.finished) return;
  buildTowers(run, "B4", assault, cuts.at(-1));
  while (run.merges.length && nextGate < gates.length && !run.finished) {
    if (!obtainCards(run, 1, 0)) break;
    const before = nextGate;
    reinforce();
    if (before === nextGate) break;
  }
  if (run.merges.length && !run.finished) {
    const anchor = run.merges[0].building.cell;
    const supports = surrounding(anchor).filter((site) => run.map.isWalkable(site) &&
      !assault.some((routeSite) => distance(site, routeSite) === 0))
      .sort((a, b) => distance(a, cuts.at(-1)) - distance(b, cuts.at(-1)));
    for (const site of supports.slice(0, run.economy.cards.tower)) {
      if (run.finished) break;
      placeAt(run, "tower", site);
    }
    run.reinforcement = reserveSite;
  }
}

function buildTowers(run, strategy, assault, focus) {
  const towerSites = [];
  const gate = assault.filter((position) => distance(position, focus) <= 5 && run.map.isWalkable(position) &&
    floorRoute(run.map, GENERATED_GOAL, position).length);
  for (const node of gate) {
    for (const site of adjacent(node)) {
      if (assault.some((position) => distance(position, site) === 0) ||
        towerSites.some((position) => distance(position, site) === 0)) continue;
      const terrain = run.map.getCell(site);
      if (run.map.isWalkable(site) || (terrain?.terrain === "dirt" && terrain.terrainLevel <= 2)) towerSites.push(site);
    }
  }
  towerSites.sort((a, b) => distance(a, focus) - distance(b, focus));
  const desired = strategy === "B3" ? 2 : 4;
  let sites = towerSites.slice(0, desired);
  if (strategy === "B4") {
    const room = towerSites.flatMap((anchor) => [
      [anchor, cell(anchor.col + 1, anchor.row), cell(anchor.col, anchor.row + 1), cell(anchor.col + 1, anchor.row + 1)],
      [anchor, cell(anchor.col - 1, anchor.row), cell(anchor.col, anchor.row - 1), cell(anchor.col - 1, anchor.row - 1)],
      [anchor, cell(anchor.col + 1, anchor.row), cell(anchor.col + 2, anchor.row), cell(anchor.col + 3, anchor.row)],
      [anchor, cell(anchor.col, anchor.row + 1), cell(anchor.col, anchor.row + 2), cell(anchor.col, anchor.row + 3)],
    ]);
    sites = room.find((pattern) => preserveGates(run, pattern) && pattern.every((site) => {
      const tile = run.map.getCell(site);
      return (run.map.isWalkable(site) || (tile?.terrain === "dirt" && tile.terrainLevel <= 2))
        && !assault.some((candidate) => distance(site, candidate) === 0);
    })) ?? [];
  }
  for (const site of sites) {
    if (run.finished) return;
    if (run.map.isWalkable(site)) continue;
    const digFrom = adjacent(site).map((origin) => floorRoute(run.map, run.player.cell, origin))
      .filter((route) => route.length).sort((a, b) => a.length - b.length)[0];
    if (!digFrom) continue;
    run.openRoute(digFrom);
    if (!run.finished && !run.map.getDigFailure(run.player.cell, site, run.economy.toolLevel)) run.mine(site);
  }
  for (const site of sites) {
    if (run.finished || !run.map.isWalkable(site)) return;
    if (!placeAt(run, "tower", site)) return;
  }
  if (strategy !== "B4" || !sites.length) return;
  const ready = run.map.previewReadySynthesis(sites[0]);
  assert.ok(ready, "paid tower cards must form a legal merge");
  if (!isWithinSynthesisRange(ready, run.player.cell)) {
    const nearby = surrounding(ready.retained).find((site) => run.map.isWalkable(site) && run.canMoveTo(site));
    assert.ok(nearby);
    run.moveTo(nearby);
  }
  if (run.finished) return;
  const merge = run.map.executeBuildingSynthesis(ready, run.player.cell);
  assert.ok(merge.success && merge.building.level === 2);
  run.merges.push({ atMs: run.now, from: run.player.cell, ...merge });
  run.record({ type: "merge", target: ready.retained });
  if (run.economy.cards.tower) {
    const cover = towerSites.find((site) => !sites.some((position) => distance(site, position) === 0) &&
      run.map.isWalkable(site));
    if (cover) placeAt(run, "tower", cover);
  }
}

export function replayEndgame(seed, strategy, rules) {
  assert.ok(strategies.includes(strategy));
  const run = new EndgameRun(seed, rules);
  approachNorth(run);
  if (run.finished) return run.report(strategy);
  fortify(run, strategy);
  if (run.finished) return run.report(strategy);
  if (!run.canMoveTo(GENERATED_GOAL)) return run.report(strategy);
  run.moveTo(GENERATED_GOAL);
  if (run.finished) return run.report(strategy);
  run.startEvacuation();
  if (run.reinforcement && obtainCards(run, 1, 0, undefined, run.now + 14_000)) {
    placeAt(run, "wall", run.reinforcement, (builder) => distance(builder, GENERATED_GOAL));
  }
  if (run.finished) return run.report(strategy);
  const assault = floorRoute(run.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL);
  const shelterRoutes = [cell(10, 4), cell(28, 4), cell(13, 2), cell(24, 2)]
    .map((site) => excavatableRoute(run.map, run.player.cell, site))
    .filter((route) => route.length)
    .sort((a, b) => shelterCost(a) - shelterCost(b));
  function shelterCost(route) {
    return route.slice(1).reduce((cost, site) => {
      const hp = run.map.getCell(site).hp;
      return cost + 8 + 5 * hp + (assault.some((cell) => distance(site, cell) === 0) ? 100 : 0);
    }, 0);
  }
  if (shelterRoutes.length) run.openRoute(shelterRoutes[0]);
  const timeLimit = run.now + 75_000;
  while (!run.finished && run.now < timeLimit) run.tick();
  return run.report(strategy);
}

export function replayWithoutTowers(candidate) {
  const run = new EndgameRun(candidate.seed);
  for (const action of candidate.actions) {
    while (run.now < action.atMs && !run.finished) run.tick();
    if (run.finished) break;
    const { type, target } = action;
    if (type === "walk") run.moveOne(target);
    else if (type === "dig") run.mine(target);
    else if (type === "technology") run.buildTechnology(target);
    else if (type === "research") assert.ok(run.economy.researchTool());
    else if (type === "draw") assert.equal(run.draw(), action.card);
    else if (type === "place" && action.kind !== "tower") run.place(action.kind, target);
    else if (type === "evacuate") run.startEvacuation();
  }
  while (!run.finished && run.now < candidate.endedAt + 10_000) run.tick();
  return run.report("B4-walls-only");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const givenSeed = process.argv.find((arg) => arg.startsWith("--random-seed="));
  const randomSeed = givenSeed ? Number(givenSeed.split("=")[1]) : randomBytes(4).readUInt32LE();
  assert.ok(Number.isSafeInteger(randomSeed) && randomSeed >= 0 && randomSeed <= 0xffff_ffff);
  const selected = process.argv.find((arg) => arg.startsWith("--strategy="))?.split("=")[1];
  const seedFilter = process.argv.find((arg) => arg.startsWith("--seed="))?.split("=")[1];
  const seeds = seedFilter === undefined ? [...fixedSeeds, randomSeed] : [Number(seedFilter)];
  const data = seeds.flatMap((seed) => (selected ? [selected] : strategies).map((strategy) => replayEndgame(seed, strategy)));
  console.log(JSON.stringify({ randomSeed, stepMs: frameMs, profile: PLAYTEST_PROFILE, data }));
}

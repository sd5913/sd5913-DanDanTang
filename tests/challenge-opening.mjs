import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { placementFailure } from "../src/build-placement.ts";
import { DefenseSimulation, sameCell } from "../src/defense-simulation.ts";
import { generateExpeditionBiomes } from "../src/expedition-biomes.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy, toEconomyTenths } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { addExpeditionApproach, addExpeditionTiers, PLAY_GENERATOR_VERSION } from "../src/expedition-terrain.ts";
import { ExplorationFog } from "../src/fog.ts";
import { DEFAULT_MAP_SEED, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionWorld } from "../src/generated-map.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { MiningSession } from "../src/mining.ts";
import { cellCenter, Player } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { WaveEconomyHistory } from "../src/wave-economy-history.ts";

const frameMs = 25;
const moveMs = 200;
const replayDeadlineMs = 150_000;
const representativeSeeds = [12, 9, 512, 1091, 0, DEFAULT_MAP_SEED, 0xffff_ffff];
const defensiveKinds = new Set(["wall", "tower"]);
const facilitySite = { col: 18, row: 92 };
const facilityBuilder = { col: 19, row: 92 };

function cell(col, row) { return { col, row }; }
function distance(a, b) { return Math.abs(a.col - b.col) + Math.abs(a.row - b.row); }

function reachable(map, start) {
  const key = ({ col, row }) => row * map.columns + col;
  const queue = [{ cell: start, steps: 0, parent: null }];
  const visited = new Map([[key(start), queue[0]]]);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    for (const next of map.getWalkableNeighbors(current.cell)) {
      if (visited.has(key(next))) continue;
      const node = { cell: next, steps: current.steps + 1, parent: current };
      visited.set(key(next), node);
      queue.push(node);
    }
  }
  return { queue, find: (target) => visited.get(key(target)) };
}

function route(node) {
  const cells = [];
  for (let current = node; current?.parent; current = current.parent) cells.push(current.cell);
  return cells.reverse();
}

function adjacent({ col, row }) {
  return [cell(col, row + 1), cell(col - 1, row), cell(col, row - 1), cell(col + 1, row)];
}

function isStarterOre(map, target) {
  if ((target.col > 22 && target.row >= 93) || distance(map.spawn, target) > 12) return false;
  const tile = map.getCell(target);
  return tile?.terrain === "dirt" && tile.terrainLevel === 1;
}

function createPlayTerrain(seed, buildingBalance) {
  const world = generateExpeditionWorld(seed);
  const { layout, biomes } = generateExpeditionBiomes(world.layout, world.effectiveSeed);
  const playLayout = addExpeditionApproach(addExpeditionTiers(layout, world.effectiveSeed));
  return {
    map: new TerrainMap(playLayout, { biomes, buildingBalance }),
    effectiveSeed: world.effectiveSeed,
    fingerprint: createHash("sha256").update(JSON.stringify([playLayout, biomes])).digest("hex"),
  };
}

function initialOre(map) {
  const open = reachable(map, map.spawn);
  const ore = new Map();
  for (const { cell: origin } of open.queue) {
    for (const target of adjacent(origin)) {
      // Keep all excavation behind the intake barrier line so it cannot bypass the wall fixture.
      if (isStarterOre(map, target)) {
        ore.set(target.row * map.columns + target.col, target);
      }
    }
  }
  return { openCells: open.queue.length, ore };
}

export class OpeningRun {
  constructor(seed, difficulty = "challenge", buildingBalance = "control") {
    const { map, effectiveSeed, fingerprint } = createPlayTerrain(seed, buildingBalance);
    this.seed = seed;
    this.effectiveSeed = effectiveSeed;
    this.fingerprint = fingerprint;
    this.difficulty = difficulty;
    this.now = 0;
    this.map = map;
    this.economy = new ExpeditionEconomy(this.map, effectiveSeed, undefined, difficulty);
    this.round = new ExpeditionRound(false, difficulty);
    this.player = new Player(this.map.spawn);
    this.fog = new ExplorationFog(this.map.columns, this.map.rows);
    this.mining = new MiningSession(this.map, MINING_CONFIG, () => this.economy.toolLevel);
    this.history = new WaveEconomyHistory(this.economy.totals);
    this.setupResources = initialOre(this.map);
    this.initial = this.economicState();
    this.miningActions = [];
    this.draws = [];
    this.construction = [];
    this.waves = [];
    this.combatEvents = [];
    this.waveEnds = [];
    this.clock = { stepped: 0, bulkSpans: 0, advancedFrames: 0 };
    this.firstTenAtMs = null;
    this.firstIncomeAtMs = null;
    this.firstCanDrawAtMs = this.economy.drawFailure ? null : 0;
    this.firstDefenseDrawAtMs = null;
    this.endOfFirstAttack = null;
    this.endAtMs = null;
    this.simulation = new DefenseSimulation(this.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, (event, metadata) => {
      if (["playerHit", "wallImpact", "buildingHit", "towerShot", "towerKill"].includes(event.type)) {
        this.combatEvents.push({ ...event, waveId: metadata.waveId, atMs: metadata.timeMs });
      }
      const credit = this.economy.handleEvent(event);
      this.history.creditKill(metadata.waveId, credit);
      if (event.type === "playerHit") {
        const hp = this.round.playerHp;
        this.round.hitPlayer(event.damage);
        this.simulation.recordPlayerDamage(metadata.waveId, hp - this.round.playerHp, metadata.timeMs);
        if (this.round.phase === "lost") {
          this.endAtMs = metadata.timeMs;
          this.simulation.clearBattle();
        }
      }
    }, true);
  }

  economicState() {
    const technology = this.economy.technologyCell && this.map.getBuilding(this.economy.technologyCell);
    return {
      totals: this.economy.totals, cards: this.economy.cards, playerHp: this.round.playerHp,
      technologyHp: technology?.hp ?? null, toolLevel: this.economy.toolLevel,
      buildings: Array.from(this.map.getBuildings(), ({ id, kind, level, cell, hp, maxHp }) => ({ id, kind, level, cell, hp, maxHp })),
    };
  }

  get finished() { return this.round.phase === "won" || this.round.phase === "lost"; }

  tick(movement, elapsedMs = frameMs) {
    if (this.finished) return;
    this.clock.stepped += 1;
    this.clock.advancedFrames += elapsedMs / frameMs;
    this.now += elapsedMs;
    movement?.();
    if (this.map.isGoal(this.player.cell) && this.round.reachGoal(this.economy.toolLevel)) {
      this.endAtMs = this.now;
      this.simulation.clearBattle();
      return;
    }
    const phase = this.round.phase;
    const { spawned, removed, pending } = this.simulation.spawnCounts;
    const active = spawned - removed;
    const order = this.round.update(elapsedMs, this.player.cell.row, active, pending);
    if (order) {
      this.waves.push({
        atMs: this.now, order, economy: this.economicState(), playerCell: this.player.cell,
      });
      this.history.startWave(this.round.wave, this.economy.totals);
      assert.equal(this.simulation.requestWave(this.round.wave, order), order.count);
    }
    if (phase === "attacking" && this.round.phase === "recovering") {
      this.simulation.finishAttackPhase(this.round.wave, active === 0 && pending === 0 ? "resolved" : "time-limit");
      this.waveEnds.push({ waveId: this.round.wave, atMs: this.now, ...this.economicState() });
      if (this.round.wave === 1) {
        this.endOfFirstAttack = { atMs: this.now, recoveryMs: this.round.remainingMs, ...this.economicState() };
      }
    }
    this.economy.advance(elapsedMs);
    this.observeAffordability();
    this.simulation.step(elapsedMs, this.player);
  }

  idleUntil(limitMs, accelerated = false) {
    const { spawned, removed, pending } = this.simulation.spawnCounts;
    const waiting = this.round.phase === "preparing" || this.round.phase === "recovering";
    const canSkipAffordabilitySample = this.firstCanDrawAtMs !== null || !this.economy.hasTechnology ||
      !Array.from(this.map.getBuildings()).some(({ kind }) => kind === "economy");
    // The final frame before a wave order is always advanced normally.
    const interior = Math.min(limitMs - this.now, this.round.remainingMs - frameMs);
    if (accelerated && waiting && spawned === removed && pending === 0 && canSkipAffordabilitySample && interior > frameMs) {
      this.clock.bulkSpans += 1;
      this.tick(undefined, Math.floor(interior / frameMs) * frameMs);
    } else {
      this.tick();
    }
  }

  observeAffordability() {
    if (this.economy.balance >= 10) this.firstTenAtMs ??= this.now;
    if (!this.economy.drawFailure) this.firstCanDrawAtMs ??= this.now;
  }

  canMoveTo(target) { return reachable(this.map, this.player.cell).find(target) !== undefined; }

  moveTo(target) {
    const finish = reachable(this.map, this.player.cell).find(target);
    assert.ok(finish, `cannot walk to ${JSON.stringify(target)}`);
    for (const next of route(finish)) {
      this.moveOne(next);
      if (this.finished) return;
    }
  }

  moveOne(target) {
    if (this.finished) return;
    const from = this.player.cell;
    assert.equal(distance(target, from), 1, "movement must trace a cardinal step");
    for (let elapsed = 0; elapsed < moveMs && !this.finished; elapsed += frameMs) {
      this.tick(() => this.player.move(target.col - from.col, target.row - from.row, frameMs, this.map));
    }
    if (!this.finished) assert.deepEqual(this.player.position, cellCenter(target));
  }

  mine(target) {
    const from = this.player.cell;
    assert.equal(this.map.getDigFailure(from, target, this.economy.toolLevel), undefined, `legal dig from ${JSON.stringify(from)} to ${JSON.stringify(target)}`);
    const startedAtMs = this.now;
    const before = this.map.getCell(target).hp;
    const initialIncome = toEconomyTenths(this.economy.totals.miningIncome ?? 0);
    let damage = 0;
    const settle = (strike) => {
      if (!strike?.result.effective) return;
      damage += strike.result.damage;
      const credit = this.economy.creditMiningDamage(strike.result.damage);
      if (credit > 0) this.firstIncomeAtMs ??= this.now;
      this.observeAffordability();
    };
    settle(this.mining.begin(from, target, this.now));
    while (!this.map.isWalkable(target) && !this.finished) {
      assert.ok(this.now - startedAtMs < 3_000, "mining must make progress");
      this.tick();
      if (!this.finished) settle(this.mining.update(from, this.now, target));
    }
    this.mining.stop();
    if (!this.finished) assert.equal(damage, before);
    this.miningActions.push({
      from, target, startedAtMs, finishedAtMs: this.now, damage,
      incomeTenths: toEconomyTenths(this.economy.totals.miningIncome ?? 0) - initialIncome,
    });
  }

  mineToIncome(tenths, pauseMs = 0, deadlineMs = Infinity) {
    assert.equal(this.difficulty, "challenge");
    while (toEconomyTenths(this.economy.totals.miningIncome) < tenths && !this.finished && this.now < deadlineMs) {
      const choices = [];
      for (const origin of reachable(this.map, this.player.cell).queue) {
        for (const target of adjacent(origin.cell)) {
          if (!isStarterOre(this.map, target)) continue;
          choices.push({ origin, target });
        }
      }
      const first = choices.sort((a, b) => a.origin.steps - b.origin.steps ||
        distance(this.map.spawn, a.target) - distance(this.map.spawn, b.target) ||
        b.target.row - a.target.row || a.target.col - b.target.col)[0];
      if (!first && Number.isFinite(deadlineMs)) break;
      assert.ok(first, `seed ${this.seed} has no remaining accessible starter ore`);
      if (this.now + first.origin.steps * moveMs + 5 * MINING_CONFIG.attackIntervalMs + pauseMs > deadlineMs) break;
      this.moveTo(first.origin.cell);
      if (!this.finished) this.mine(first.target);
      for (let elapsed = 0; elapsed < pauseMs && !this.finished; elapsed += frameMs) this.tick();
    }
    return toEconomyTenths(this.economy.totals.miningIncome) >= tenths;
  }

  draw() {
    const balanceBefore = this.economy.balance;
    const reason = this.economy.drawFailure;
    const card = this.economy.drawCard();
    if (defensiveKinds.has(card)) this.firstDefenseDrawAtMs ??= this.now;
    this.draws.push({ atMs: this.now, balanceBefore, balanceAfter: this.economy.balance, card: card ?? null, reason: reason ?? null });
    return card;
  }

  checkPlacement(kind, target) {
    this.fog.reveal(this.player.cell);
    const reserved = [GENERATED_ENEMY_ENTRY, GENERATED_GOAL];
    if (kind !== "technology" && this.economy.technologyCell) reserved.push(this.economy.technologyCell);
    return placementFailure(this.map, target, {
      playerPosition: this.player.position,
      roundEnded: this.finished, visible: this.fog.visibility(target) === "visible",
      reserved: reserved.some((cell) => sameCell(target, cell)),
      enemyOccupies: (position) => this.simulation.occupies(position), cardCount: this.economy.cards[kind],
    });
  }

  place(kind, target) {
    const reason = this.checkPlacement(kind, target);
    assert.equal(reason, undefined, `legal ${kind} placement at ${JSON.stringify(target)}`);
    const placed = this.economy.placeCard(kind, target);
    assert.ok(placed);
    this.construction.push({ atMs: this.now, kind, target, from: this.player.cell, id: placed.id,
      level: placed.level, cell: placed.cell, hp: placed.hp, maxHp: placed.maxHp });
    return placed;
  }

  fundFacility(pauseMs = 0) {
    const cost = this.economy.technologyBuildCost;
    this.mineToIncome(toEconomyTenths(cost), pauseMs);
    this.moveTo(facilityBuilder);
    assert.equal(this.checkPlacement("technology", facilitySite), undefined);
    const balanceBefore = this.economy.balance;
    assert.ok(this.economy.buildTechnology(facilitySite));
    assert.equal(this.economy.balance, balanceBefore - cost);
    this.facility = { atMs: this.now, balanceBefore, balanceAfter: this.economy.balance, cost,
      target: facilitySite, from: this.player.cell };
    return toEconomyTenths(cost);
  }

  snapshot() {
    return {
      seed: this.seed, effectiveSeed: this.effectiveSeed, difficulty: this.difficulty, fingerprint: this.fingerprint,
      start: this.initial, finish: this.economicState(), elapsedMs: this.endAtMs ?? this.now,
      playerCell: this.player.cell, phase: this.round.phase, wave: this.round.wave,
      firstIncomeAtMs: this.firstIncomeAtMs, firstTenAtMs: this.firstTenAtMs,
      firstCanDrawAtMs: this.firstCanDrawAtMs, firstDefenseDrawAtMs: this.firstDefenseDrawAtMs,
      initialOpenCells: this.setupResources.openCells, initialStarterDirt: this.setupResources.ore.size,
      miningActions: this.miningActions, draws: this.draws, construction: this.construction, facility: this.facility ?? null,
      waves: this.waves, waveEnds: this.waveEnds, endOfFirstAttack: this.endOfFirstAttack,
      combat: this.simulation.waveMetrics, combatEvents: this.combatEvents, economyHistory: this.history.snapshot(this.economy.totals),
    };
  }
}

export function replayChallengeFunding(seed) {
  const run = new OpeningRun(seed);
  assert.equal(run.effectiveSeed, seed);
  const budgets = [];
  const facilityCost = run.fundFacility();
  for (const cardCount of [1, 2, 3]) {
    const thresholdTenths = facilityCost + toEconomyTenths(cardCount * ECONOMY_PROTOTYPE.drawCost);
    run.mineToIncome(thresholdTenths);
    assert.ok(run.economy.balance >= ECONOMY_PROTOTYPE.drawCost);
    const timestamp = run.now;
    const availableBefore = run.economy.balance;
    const card = run.draw();
    assert.ok(card);
    budgets.push({ thresholdTenths, atMs: timestamp, availableBefore, card });
  }
  assert.ok(run.now < 60_000);
  return { ...run.snapshot(), budgets };
}

export function replayChallengeResearch(seed, pauseMs) {
  const run = new OpeningRun(seed);
  const facilityCost = run.fundFacility(pauseMs);
  const cardCost = toEconomyTenths(ECONOMY_PROTOTYPE.drawCost);
  run.mineToIncome(facilityCost + cardCost, pauseMs);
  const firstCard = run.draw();
  const cardAtMs = run.now;
  assert.ok(firstCard);
  assert.equal(run.economy.researchTool(), false, "A first craft cannot also fund the upgrade");
  const researchCost = run.economy.researchCost;
  run.mineToIncome(facilityCost + cardCost + toEconomyTenths(researchCost), pauseMs);
  const researchAtMs = run.round.phase !== "lost" && run.economy.researchTool() ? run.now : null;
  return { seed, pauseMs, facilityAtMs: run.facility.atMs, cardAtMs, firstCard, researchCost, researchAtMs,
    toolLevel: run.economy.toolLevel, income: run.economy.totals.miningIncome, firstWaveAtMs: run.waves[0]?.atMs ?? null,
    phase: run.round.phase, playerHp: run.round.playerHp, hasTechnology: run.economy.hasTechnology, elapsedMs: run.now };
}

export function screenChallengeFunding() {
  const seeds = [...new Set([
    ...Array.from({ length: 99 }, (_, index) => index), DEFAULT_MAP_SEED, 0xffff_ffff,
    ...Array.from({ length: 99 }, (_, index) => ((index + 1) * 43_663_117) >>> 0), 512, 1091,
  ])];
  const samples = seeds.map(replayChallengeFunding);
  const summaries = samples.map(({ seed, effectiveSeed, fingerprint, initialOpenCells, initialStarterDirt,
    firstIncomeAtMs, firstCanDrawAtMs, firstDefenseDrawAtMs, budgets, miningActions }) => ({
    seed, effectiveSeed, fingerprint, initialOpenCells, initialStarterDirt, firstIncomeAtMs, firstCanDrawAtMs, firstDefenseDrawAtMs,
    budgets, firstTargets: miningActions.slice(0, 6).map(({ target }) => target),
  }));
  return {
    stepMs: frameMs, generatorVersion: PLAY_GENERATOR_VERSION,
    summaries, representative: representativeSeeds.map((seed) => samples.find((trial) => trial.seed === seed)),
  };
}

function waitUntil(run, condition, limitMs = replayDeadlineMs) {
  while (!condition() && run.round.phase !== "lost" && run.now < limitMs) run.tick();
  assert.ok(condition() || run.round.phase === "lost", "fixed replay hit its deadline");
}

function placeIntakeWall(run) {
  run.moveTo(cell(23, 94));
  run.place("wall", cell(24, 94));
}

function placeIntakeTower(run, target) {
  run.moveTo(cell(22, 93));
  if (!run.map.isWalkable(target)) run.mine(target);
  run.place("tower", target);
}

function fundAndDraw(run, tenths, expected) {
  run.mineToIncome(tenths);
  assert.equal(run.draw(), expected);
}

function challengeStrategy(run, strategy) {
  const facilityCost = run.fundFacility();
  if (strategy === "wall" || strategy === "mixed") {
    fundAndDraw(run, facilityCost + 30, "wall");
    placeIntakeWall(run);
  }
  if (strategy === "mixed") {
    fundAndDraw(run, facilityCost + 60, "tower");
    placeIntakeTower(run, cell(23, 93));
    fundAndDraw(run, facilityCost + 90, "tower");
    placeIntakeTower(run, cell(22, 92));
  }
  if (strategy === "tower") {
    fundAndDraw(run, facilityCost + 30, "tower");
    placeIntakeTower(run, cell(23, 93));
    fundAndDraw(run, facilityCost + 60, "tower");
    placeIntakeTower(run, cell(22, 92));
  }
}

function splitRevenue(totals, previous = {}) {
  const entries = Object.fromEntries(["miningIncome", "killIncome", "productionIncome"].map((key) => [
    key, toEconomyTenths(totals[key] ?? 0) - toEconomyTenths(previous[key] ?? 0),
  ]));
  const total = Object.values(entries).reduce((sum, amount) => sum + amount, 0);
  return {
    mining: entries.miningIncome / 10, kills: entries.killIncome / 10, production: entries.productionIncome / 10,
    miningShare: total === 0 ? null : entries.miningIncome / total,
    killShare: total === 0 ? null : entries.killIncome / total,
    productionShare: total === 0 ? null : entries.productionIncome / total,
  };
}

export function replayOpeningBattle({ seed, strategy, difficulty = "challenge" }) {
  const run = new OpeningRun(seed, difficulty);
  assert.equal(run.effectiveSeed, seed);
  if (strategy === "unarmed") {
    run.moveTo(cell(26, 94));
  } else {
    if (difficulty === "challenge") {
      challengeStrategy(run, strategy);
    } else {
      assert.equal(strategy, "starting-stock");
      placeIntakeWall(run);
      run.moveTo(cell(21, 93));
      run.mine(cell(22, 93));
      placeIntakeTower(run, cell(23, 93));
      placeIntakeTower(run, cell(22, 92));
    }
    run.moveTo(run.map.spawn);
  }

  waitUntil(run, () => run.endOfFirstAttack !== null);
  const firstAttackEnd = run.endOfFirstAttack ?? { atMs: run.endAtMs, ...run.economicState() };
  const first = run.waves[0];
  assert.ok(first);
  const openingBuildings = first.economy.buildings;
  const firstCombat = run.simulation.getWaveMetrics(1);
  const firstExchange = run.combatEvents.find(({ type, waveId }) => waveId === 1 && type !== "towerKill") ?? null;

  let afterWave = null;
  if (run.round.phase !== "lost") {
    const balanceBefore = run.economy.balance;
    const miningBefore = toEconomyTenths(run.economy.totals.miningIncome ?? 0);
    let paid = null;
    if (difficulty === "challenge") {
      // A wall grants no kill income. Earn another paid draw through ordinary rear excavation.
      run.mineToIncome(miningBefore + (strategy === "wall" ? 30 : 5));
      paid = run.draw();
      assert.ok(paid, "surviving strategy can fund another card before wave 2");
    }
    afterWave = {
      atMs: run.now, balanceBefore, balanceAfter: run.economy.balance,
      additionalMining: (toEconomyTenths(run.economy.totals.miningIncome ?? 0) - miningBefore) / 10,
      paidCard: paid,
    };
    waitUntil(run, () => run.round.wave >= 2);
  }
  const snapshot = run.snapshot();
  return {
    ...snapshot, strategy,
    result: snapshot.phase === "lost" ? "lost" : "wave-2",
    firstWave: {
      issuedAtMs: first.atMs, order: first.order,
      initialBalance: first.economy.totals.balance,
      initialWallCount: openingBuildings.filter(({ kind }) => kind === "wall").length,
      initialTowerCount: openingBuildings.filter(({ kind }) => kind === "tower").length,
      firstActualExchange: firstExchange,
      combatAtEnd: firstCombat,
      firstAttackEnd,
      earnedDuringAttack: splitRevenue(firstAttackEnd.totals, first.economy.totals),
      earnedThroughAttack: splitRevenue(firstAttackEnd.totals, snapshot.start.totals),
      entireWavePeriod: snapshot.economyHistory.find(({ waveId }) => waveId === 1),
    },
    afterWave,
  };
}

export function replayOpeningStrategies() {
  return [
    { seed: 12, strategy: "unarmed" },
    { seed: 9, strategy: "wall" },
    { seed: 512, strategy: "tower" },
    { seed: 12, strategy: "mixed" },
    { seed: 12, strategy: "unarmed", difficulty: "b" },
    { seed: 12, strategy: "starting-stock", difficulty: "b" },
  ].map(replayOpeningBattle);
}

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { towerAttributes } from "../src/building-balance.ts";
import { placementFailure } from "../src/build-placement.ts";
import { DEFENSE_CONFIG, DefenseSimulation, enemyPosition, sameCell } from "../src/defense-simulation.ts";
import { ENEMY_RADIUS } from "../src/enemy-contact.ts";
import { ExpeditionEconomy, toEconomyTenths } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { ExplorationFog } from "../src/fog.ts";
import { GENERATED_ENEMY_ENTRY as entry, GENERATED_GOAL as goal } from "../src/generated-map.ts";
import { cellCenter, Player, TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { WaveEconomyHistory } from "../src/wave-economy-history.ts";

const frameMs = 25;
const reachRadius = ENEMY_RADIUS / TILE_SIZE;
const cell = (col, row) => ({ col, row });
const spawn = cell(12, 89);
const technology = cell(13, 89);
const researchExit = cell(15, 62);
const allocationEveryMs = 15_000;
const placementEveryMs = 45_000;

function design(long) {
  const layout = Array.from({ length: 96 }, () => Array(40).fill("#"));
  const open = (fromCol, fromRow, toCol, toRow) => {
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let col = fromCol; col <= toCol; col += 1) layout[row][col] = ".";
    }
  };
  open(6, 86, 30, 90);
  open(15, researchExit.row, 15, 85);
  if (long) {
    open(16, 94, 30, 94);
    open(16, 93, 16, 93);
    open(16, 92, 29, 92);
    open(29, 91, 29, 91);
  } else {
    open(29, 94, 30, 94);
    open(29, 93, 29, 93);
    open(12, 92, 29, 92);
    open(12, 91, 12, 91);
  }
  layout[spawn.row][spawn.col] = "S";
  layout[goal.row][goal.col] = "G";
  return layout.map((row) => row.join(""));
}

function key(map, position) { return position.row * map.columns + position.col; }

function reachable(map, from) {
  const route = [{ position: from, previous: null }];
  const seen = new Set([key(map, from)]);
  for (let index = 0; index < route.length; index += 1) {
    for (const position of map.getWalkableNeighbors(route[index].position)) {
      const next = key(map, position);
      if (seen.has(next)) continue;
      seen.add(next);
      route.push({ position, previous: route[index] });
    }
  }
  return route;
}

function adjacent(from) {
  const positions = [];
  for (let row = from.row - 1; row <= from.row + 1; row += 1) {
    for (let col = from.col - 1; col <= from.col + 1; col += 1) {
      if (col !== from.col || row !== from.row) positions.push(cell(col, row));
    }
  }
  return positions;
}

function groupedRate(values, firstAtMs) {
  const seconds = {};
  for (const timeMs of values) {
    const second = Math.floor((timeMs - firstAtMs) / 1_000);
    seconds[second] = (seconds[second] ?? 0) + 1;
  }
  return seconds;
}

function cohort(order, waveId, startedAtMs, deployment) {
  return {
    order, deployment, waveId, startedAtMs, spawnTimes: [], exposureTimes: [], spawnRoster: [],
    kindCounts: {}, killsByKind: {}, wallByKind: {}, entryBlockSamples: 0, occupiedEntrySamples: 0,
    overlapAtEntrySamples: 0, maximumPending: 0,
    towerHits: new Map(), shotByEnemy: new Map(), shotsByTower: {}, wallEvents: [], losses: [],
  };
}

/**
 * A mature controlled defense, deliberately separate from zero-resource strategy replays.
 * Terrain is authored and the installed fixture buildings are granted before the clock starts.
 * All subsequent movement, crafts, technology, paid placement, income and combat use game rules.
 */
export function runMidgameFixture({
  seed = 515, waves = 10, stage = 0, stageAfterWave = 2, towerCount = 2, mixed = false,
  long = false, buildingBalance = "w25", spending = "paced", waveDeployment = () => undefined,
  createEconomy = (map) => new ExpeditionEconomy(map, seed, undefined, "challenge"),
} = {}) {
  const map = new TerrainMap(design(long), { buildingBalance });
  const player = new Player(spawn);
  const economy = createEconomy(map);
  const fog = new ExplorationFog(map.columns, map.rows);
  const round = new ExpeditionRound(false, "challenge");
  const history = new WaveEconomyHistory(economy.totals);
  const periods = new Map();
  const seen = new Map();
  const observations = [];
  const transactions = [];
  const wall = long ? cell(26, 92) : cell(15, 92);
  const positions = [22, 18, 25, 16];
  let now = 0;
  let defeatAtMs = null;
  let lastActualSpawnMs = -Infinity;
  let anchorRevision = -1;
  let anchors = [];
  let tierTripDone = false;

  function checkPlacement(kind, target, origin = player.cell, grant = false) {
    fog.reveal(origin, []);
    return placementFailure(map, target, {
      playerPosition: cellCenter(origin), roundEnded: round.phase === "lost",
      cardCount: grant || kind === "technology" ? undefined : economy.cards[kind],
      visible: fog.visibility(target) === "visible",
      reserved: sameCell(target, entry) || sameCell(target, goal),
      enemyOccupies: (point) => simulation.occupies(point),
    });
  }

  function grant(kind, target) {
    const stance = reachable(map, spawn).find(({ position }) => !checkPlacement(kind, target, position, true));
    assert.ok(stance, `fixture building needs a legal neighbor: ${JSON.stringify({ kind, target })}`);
    assert.ok(map.placeBuilding(kind, target));
  }

  const simulation = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    const wave = periods.get(metadata.waveId);
    const credit = economy.handleEvent(event, metadata.waveId);
    history.creditKill(metadata.waveId, credit);
    const record = seen.get(event.enemyId);
    if (event.type === "towerShot" && wave && record) {
      expose(record, metadata.timeMs);
      wave.towerHits.set(event.enemyId, (wave.towerHits.get(event.enemyId) ?? 0) + 1);
      wave.shotByEnemy.set(event.enemyId, (wave.shotByEnemy.get(event.enemyId) ?? 0) + event.damage);
      wave.shotsByTower[event.towerId] = (wave.shotsByTower[event.towerId] ?? 0) + 1;
    }
    if (event.type === "towerKill" && wave && record) {
      const stats = wave.killsByKind[record.kind] ??= { count: 0, hits: 0, exposureToKillMs: 0, reward: 0 };
      stats.count += 1;
      stats.hits += wave.towerHits.get(event.enemyId);
      stats.exposureToKillMs += metadata.timeMs - record.exposureAtMs;
      stats.reward += credit;
    }
    if (event.type === "wallImpact" && wave) {
      wave.wallEvents.push({ atMs: metadata.timeMs, ...event });
      if (record) wave.wallByKind[record.kind] = (wave.wallByKind[record.kind] ?? 0) + 1;
      if (event.destroyed) wave.losses.push({ atMs: metadata.timeMs, kind: "wall", id: event.wallId });
    }
    if (event.type === "buildingHit" && event.destroyed && wave) {
      wave.losses.push({ atMs: metadata.timeMs, kind: event.buildingKind, id: event.buildingId });
    }
    if (event.type === "playerHit") {
      const hp = round.playerHp;
      round.hitPlayer(event.damage);
      simulation.recordPlayerDamage(metadata.waveId, hp - round.playerHp, metadata.timeMs);
      if (round.phase === "lost") {
        defeatAtMs = metadata.timeMs;
        simulation.clearBattle();
      }
    }
  }, true);

  for (const col of [8, 10, 12, 14]) grant("economy", cell(col, 86));
  for (const col of positions.slice(0, towerCount)) {
    for (let row = 90; row >= 87; row -= 1) grant("tower", cell(col, row));
    assert.equal(map.getBuilding(cell(col, 90)).level, 2);
  }
  if (mixed) {
    for (const position of [cell(20, 90), cell(27, 90)]) grant("tower", position);
  }
  grant("wall", wall);
  const startingBuildings = [...map.getBuildings()];
  assert.equal(economy.balance, 0);

  function expose(record, timeMs) {
    if (record.exposureAtMs !== null) return;
    record.exposureAtMs = timeMs;
    periods.get(record.waveId).exposureTimes.push(timeMs);
  }

  function refreshAnchors() {
    if (anchorRevision !== map.revision) {
      anchorRevision = map.revision;
      anchors = [...map.getBuildings()].filter(({ kind }) => kind === "tower").map(({ cell: target, level }) => ({
        x: target.col + 0.5, y: target.row + 0.5,
        radius: towerAttributes(map.buildingBalance, level, map.getBiome(target)).range,
      }));
    }
  }

  function sampleUnits() {
    refreshAnchors();
    const closeToEntry = [];
    for (const enemy of simulation.enemies) {
      const wave = periods.get(enemy.waveId);
      assert.ok(wave);
      const point = enemyPosition(enemy);
      if (Math.hypot(point.x - entry.col - 0.5, point.y - entry.row - 0.5) < 2 * reachRadius) {
        closeToEntry.push(point);
      }
      let record = seen.get(enemy.id);
      if (!record) {
        assert.equal(enemy.spawnedAtMs, simulation.elapsedMs, "new enemies cannot skip the first sample");
        assert.ok(sameCell(enemy.cell, entry), "units must enter from the original southern pocket");
        const kind = enemy.kind ?? "normal";
        record = { id: enemy.id, kind, waveId: enemy.waveId, exposureAtMs: null, spawnedAtMs: enemy.spawnedAtMs, hp: enemy.hp };
        seen.set(enemy.id, record);
        wave.spawnRoster.push(record);
        wave.spawnTimes.push(enemy.spawnedAtMs);
        wave.kindCounts[kind] = (wave.kindCounts[kind] ?? 0) + 1;
        lastActualSpawnMs = enemy.spawnedAtMs;
      }
      if (record.exposureAtMs === null
        && anchors.some(({ x, y, radius }) => Math.hypot(point.x - x, point.y - y) <= radius)) {
        expose(record, simulation.elapsedMs);
      }
    }
    const newest = [...periods.values()].at(-1);
    if (newest && closeToEntry.some((a, index) => closeToEntry.slice(index + 1)
      .some((b) => Math.hypot(a.x - b.x, a.y - b.y) < 2 * reachRadius - 1e-9))) {
      newest.overlapAtEntrySamples += 1;
    }
  }

  function placementSlots() {
    return adjacent(player.cell).filter((target) => !checkPlacement("wall", target, player.cell, true));
  }

  function buildings() {
    const stock = { wall: 0, tower: 0, towerLevel2: 0, economy: 0, technology: 0 };
    for (const building of map.getBuildings()) {
      stock[building.kind] += 1;
      if (building.kind === "tower" && building.level === 2) stock.towerLevel2 += 1;
    }
    return stock;
  }

  function snapshot() {
    refreshAnchors();
    const approach = reachable(map, entry);
    const uncoveredApproachCells = approach.filter(({ position }) => !anchors.some(({ x, y, radius }) =>
      Math.hypot(position.col + 0.5 - x, position.row + 0.5 - y) <= radius)).length;
    return {
      timeMs: now, playerHp: round.playerHp, toolLevel: economy.toolLevel, stage: round.stage,
      wallHp: map.getBuilding(wall)?.hp ?? 0, totals: economy.totals, cards: economy.cards,
      buildings: buildings(), legalNearbySlots: placementSlots().length,
      approachCells: approach.length, uncoveredApproachCells,
    };
  }

  function tick(action) {
    if (round.phase === "lost") return;
    now += frameMs;
    action?.();
    const { spawned, removed, pending } = simulation.spawnCounts;
    const active = spawned - removed;
    const phase = round.phase;
    const order = round.update(frameMs, player.cell.row, active, pending);
    if (order) {
      const waveId = round.wave;
      const deployment = waveDeployment({ order, waveId, stage: round.stage, seed });
      periods.set(waveId, cohort(order, waveId, simulation.elapsedMs, deployment));
      history.startWave(waveId, economy.totals);
      assert.equal(simulation.requestWave(waveId, order, deployment), order.count);
      sampleUnits();
    }
    const pendingBefore = simulation.spawnCounts.pending;
    let feeding;
    if (pendingBefore > 0) {
      for (const wave of periods.values()) {
        const pending = simulation.getWaveMetrics(wave.waveId).pending;
        wave.maximumPending = Math.max(wave.maximumPending, pending);
        if (pending > 0) feeding ??= wave;
      }
    }
    const occupied = feeding && simulation.occupies(entry);
    if (occupied) feeding.occupiedEntrySamples += 1;
    const lastSpawn = lastActualSpawnMs;
    const burst = feeding?.deployment?.burst;
    const insidePause = burst && feeding.spawnTimes.length > 0 && feeding.spawnTimes.length % burst.count === 0;
    const interval = insidePause ? burst.pauseMs : feeding?.deployment?.intervalMs ?? DEFENSE_CONFIG.spawnIntervalMs;
    if (phase === "attacking" && round.phase === "recovering") {
      simulation.finishAttackPhase(round.wave, active === 0 && pending === 0 ? "resolved" : "time-limit");
      periods.get(round.wave).attackEnd = snapshot();
    }
    economy.advance(frameMs);
    simulation.step(frameMs, player);
    sampleUnits();
    if (occupied && lastActualSpawnMs === lastSpawn && now >= lastSpawn + interval && simulation.occupies(entry)) {
      feeding.entryBlockSamples += 1;
    }
    if (now % 60_000 === 0) observations.push(snapshot());
  }

  function visit(destination) {
    const target = reachable(map, player.cell).find(({ position }) => sameCell(destination, position));
    assert.ok(target);
    const steps = [];
    for (let node = target; node.previous; node = node.previous) steps.push(node.position);
    for (const step of steps.reverse()) {
      const dx = step.col - player.cell.col;
      const dy = step.row - player.cell.row;
      for (let elapsed = 0; elapsed < 200; elapsed += frameMs) tick(() => player.move(dx, dy, frameMs, map));
      if (round.phase === "lost") return;
      assert.deepEqual(player.cell, step);
    }
  }

  function allocate() {
    if (!economy.hasTechnology && !economy.technologyFailure && !checkPlacement("technology", technology)) {
      assert.ok(economy.buildTechnology(technology));
      transactions.push({ atMs: now, kind: "technology", cost: economy.technologyBuildCost });
    }
    if (!economy.hasTechnology || now % allocationEveryMs !== 0) return;
    if (economy.researchTool()) transactions.push({ atMs: now, kind: "research", cost: economy.researchCost });
    if (spending === "none" || economy.drawFailure) return;
    const before = economy.totals.cardSpend;
    const card = economy.drawCard();
    assert.ok(card);
    transactions.push({ atMs: now, kind: "craft", card, cost: economy.totals.cardSpend - before });
    if (now % placementEveryMs !== 0) return;
    // Slow paced deployment is identical in each comparison. Keep the original lane and anchors clear.
    const target = placementSlots().find((point) => point.col < player.cell.col);
    if (!target || checkPlacement(card, target)) return;
    const placed = economy.placeCard(card, target);
    assert.ok(placed);
    transactions.push({ atMs: now, kind: "place", card, cell: target, level: placed.level });
  }

  while (now < 1_200_000 && round.phase !== "lost") {
    tick();
    if (round.phase === "lost") break;
    allocate();
    if (stage > 0 && !tierTripDone && round.wave === stageAfterWave && round.phase === "recovering") {
      assert.equal(economy.toolLevel, 2, "the tier-two trip follows paid level-two research");
      visit(researchExit);
      if (round.phase !== "lost") visit(spawn);
      tierTripDone = true;
    }
    if (round.wave === waves && round.phase === "recovering") break;
  }

  const final = snapshot();
  const rows = simulation.waveMetrics.map((metrics) => {
    const wave = periods.get(metrics.waveId);
    const { spawnTimes, exposureTimes, towerHits, shotByEnemy, ...summary } = wave;
    const releaseSpanMs = metrics.spawned > 1 ? spawnTimes.at(-1) - spawnTimes[0] : null;
    assert.equal(spawnTimes.length, metrics.spawned);
    return {
      ...summary, ...metrics, spawnTimes, releaseSpanMs,
      actualSpawnRate: releaseSpanMs ? 1_000 * (metrics.spawned - 1) / releaseSpanMs : null,
      spawnsPerSecond: groupedRate(spawnTimes, wave.startedAtMs),
      towerEntrantsPerSecond: groupedRate(exposureTimes, wave.startedAtMs),
      exposureSamples: exposureTimes.length, entryBlockSampleMs: wave.entryBlockSamples * frameMs,
      occupiedEntrySampleMs: wave.occupiedEntrySamples * frameMs,
      hitEnemies: [...towerHits].map(([id, hits]) => ({ id, hits, damage: shotByEnemy.get(id) })),
      firstWallAtMs: wave.wallEvents[0]?.atMs ?? null,
    };
  });
  assert.equal(seen.size, simulation.spawnCounts.spawned);
  const moneyIn = ["miningIncome", "killIncome", "productionIncome"];
  const moneyOut = ["cardSpend", "technologySpend", "researchSpend"];
  const intervals = observations.concat(observations.at(-1)?.timeMs === final.timeMs ? [] : [final]).map((item, i) => {
    const earlier = observations[i - 1];
    const difference = (name) => (toEconomyTenths(item.totals[name] ?? 0) - toEconomyTenths(earlier?.totals[name] ?? 0)) / 10;
    const income = moneyIn.reduce((sum, name) => sum + difference(name), 0);
    const spending = moneyOut.reduce((sum, name) => sum + difference(name), 0);
    const production = difference("productionIncome");
    return {
      ...item, intervalMs: item.timeMs - (earlier?.timeMs ?? 0), income, spending, production,
      cardsMade: difference("cardsMade"), productionToSpend: spending === 0 ? null : production / spending,
      revenue: Object.fromEntries(moneyIn.map((name) => [name, difference(name)])),
      expenditure: Object.fromEntries(moneyOut.map((name) => [name, difference(name)])),
    };
  });
  return {
    fixture: "controlled mature array", seed, stage, towerCount, mixed, long, buildingBalance, entry, frameMs, wall,
    startingBuildings, final, defeatAtMs, waves: rows, intervals, transactions,
    waveEconomy: history.snapshot(economy.totals), spawnCounters: simulation.spawnCounts,
    navigation: { searches: simulation.searchCount, spentMs: simulation.searchTimeMs },
  };
}

const command = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (command) console.log(JSON.stringify(runMidgameFixture(), null, 2));

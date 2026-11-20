import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { CONTROL_TOWER_TUNING, evolvedTowerAttributes } from "../src/building-balance.ts";
import { DEFENSE_CONFIG, DefenseSimulation, enemyPosition } from "../src/defense-simulation.ts";
import { DIFFICULTY_PROFILES, wavePopulation } from "../src/expedition-difficulty.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { MIDGAME_EXPERIMENTS, waveDeployment } from "../src/midgame-experiments.ts";
import { TerrainMap } from "../src/terrain.ts";
import { buildEvolvedTowerCoverage, evolvedTargetDistanceSquared } from "../src/tower-attack.ts";

const board = { columns: 40, rows: 32 };
const seed = 515;
const stepMs = 10;
const cell = ([col, row]) => ({ col, row });
const center = ({ col, row }) => ({ x: col + 0.5, y: row + 0.5 });
const key = ({ col, row }) => `${col},${row}`;
const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const routes = [
  { id: "short-straight", bends: [[7, 10], [16, 10]], piercing: [[6, 10, "horizontal"]], burst: [[10, 9]] },
  { id: "long-straight", bends: [[7, 10], [32, 10]], piercing: [[6, 10, "horizontal"]], burst: [[14, 9]],
    support: [[18, 11]] },
  { id: "two-wide", bends: [[7, 11], [9, 11], [9, 10], [30, 10]],
    open: [[9, 11, 26, 11]], piercing: [[6, 11, "horizontal"]], burst: [[14, 9]] },
  { id: "l-corner", bends: [[8, 10], [17, 10], [17, 21]],
    piercing: [[17, 9, "vertical"]], burst: [[16, 12]], support: [[18, 17]] },
  { id: "s-turns", bends: [[7, 9], [14, 9], [14, 13], [21, 13], [21, 17], [31, 17]],
    piercing: [[13, 13, "horizontal"]], burst: [[19, 12]] },
  { id: "queued-entry", bends: [[6, 9], [11, 9], [11, 15], [30, 15]],
    piercing: [[10, 15, "horizontal"]], burst: [[13, 12]] },
  { id: "dense-chamber", bends: [[6, 11], [13, 11], [13, 17], [28, 17]],
    open: [[9, 11, 19, 16]], piercing: [[12, 17, "horizontal"]], burst: [[15, 14]] },
  { id: "highland", bends: [[13, 7], [13, 30]], highland: true,
    piercing: [[13, 6, "vertical"]], burst: [[12, 13]], support: [[14, 18]] },
];
const mature = {
  id: "mature-front", bends: [[5, 9], [15, 9], [15, 20], [37, 20]],
  piercing: [[4, 9, "horizontal"], [15, 8, "vertical"], [14, 20, "horizontal"]],
  burst: [[10, 8], [14, 15], [22, 19]], support: [[24, 21], [27, 19]],
};
const populations = [
  { id: "ordinary", wave: 2, stage: 0, experiment: "control" },
  { id: "armored-mix", wave: 3, stage: 1, experiment: "combined" },
  { id: "dense-armored-mix", wave: 6, stage: 1, experiment: "combined" },
];
const cases = [
  { id: "burst-control", kind: "burst", tuning: CONTROL_TOWER_TUNING },
  { id: "burst-R175", kind: "burst", tuning: { ...CONTROL_TOWER_TUNING, burstRadius: 1.75 } },
  { id: "burst-R200", kind: "burst", tuning: { ...CONTROL_TOWER_TUNING, burstRadius: 2 } },
  { id: "pierce-control", kind: "piercing", tuning: CONTROL_TOWER_TUNING },
  { id: "pierce-C750", kind: "piercing", tuning: { ...CONTROL_TOWER_TUNING, piercingIntervalMs: 750 } },
];

function walkLine(bends) {
  const path = [cell(bends[0])];
  for (const waypoint of bends.slice(1).map(cell)) {
    let { col, row } = path.at(-1);
    assert.ok(col === waypoint.col || row === waypoint.row, "The lane moves only along a grid axis");
    while (col !== waypoint.col || row !== waypoint.row) {
      col += Math.sign(waypoint.col - col);
      row += Math.sign(waypoint.row - row);
      path.push({ col, row });
    }
  }
  return path;
}

function group(kind, [col, row, axis]) {
  if (kind === "burst") return [[col, row], [col - 1, row], [col - 1, row - 1], [col, row - 1]].map(cell);
  return Array.from({ length: 4 }, (_, offset) => ({
    col: col - (axis === "horizontal" ? offset : 0), row: row - (axis === "vertical" ? offset : 0),
  }));
}

function prepareField(route, kind, withSupport) {
  const path = walkLine(route.bends);
  const entry = path[0];
  const goal = path.at(-1);
  const wallSite = path.at(-2);
  const lane = new Set(path.map(key));
  const open = Array.from({ length: board.rows }, () => Array(board.columns).fill("#"));
  const mark = ({ col, row }, glyph = ".") => { open[row][col] = glyph; };
  for (const section of route.open ?? []) {
    const [left, top, right, bottom] = section;
    for (let row = top; row <= bottom; row += 1) {
      for (let col = left; col <= right; col += 1) mark({ col, row });
    }
  }
  path.forEach((site) => mark(site));
  const groups = route[kind].map((anchor) => group(kind, anchor));
  const supports = route.support?.map(cell) ?? [];
  // Seats always exist in both arms of a supported/unsupported comparison.
  for (const site of [...groups.flat(), ...supports]) {
    assert.ok(!lane.has(key(site)), `A tower seat must be off the authored lane: ${route.id} ${kind} ${key(site)}`);
    mark(site);
  }
  mark(entry, "S");
  mark(goal, "G");
  const biomes = route.highland ? open.map((row) => row.map(() => "highland")) : undefined;
  const map = new TerrainMap(open.map((row) => row.join("")), { towerEvolution: true, buildingBalance: "w25", biomes });
  const towers = groups.map((sites, index) => {
    for (const site of sites) assert.ok(map.placeBuilding("tower", site));
    const tower = map.getBuilding(sites[0]);
    assert.equal(tower.evolution.kind, kind);
    assert.equal(tower.evolution.axis, route[kind][index][2]);
    assert.equal(tower.hp, 1);
    return tower;
  });
  if (withSupport) {
    for (const site of supports) assert.equal(map.placeBuilding("tower", site)?.level, 1);
  }
  const wall = map.placeBuilding("wall", wallSite);
  assert.equal(wall.hp, 25);
  return { map, entry, goal, wallSite, towers, path };
}

function flightSamples(event, hits, simulation) {
  // Match the attack instant, including units that were killed since the latest tick sample.
  const points = new Map([...simulation.enemies].map((enemy) => [enemy.id, enemyPosition(enemy)]));
  for (const hit of hits) points.set(hit.enemyId, hit.to);
  const primary = hits[0];
  const gaps = [...points].filter(([id]) => id !== primary.enemyId)
    .map(([, point]) => distance(point, primary.to)).sort((a, b) => a - b);
  const countWithin = (radius) => gaps.filter((gap) => gap - radius <= 1e-9).length;
  return {
    ids: event.enemyIds, primary: primary.to, nearest: gaps[0] ?? null, secondNearest: gaps[1] ?? null,
    within1: countWithin(1), within1_25: countWithin(1.25), within1_75: countWithin(1.75), within2: countWithin(2),
    impactDistances: hits.map(({ to }) => distance(primary.to, to)),
  };
}

function prepareWave(population) {
  const { wave, stage, experiment } = population;
  const count = wavePopulation("challenge", wave, 0);
  const order = { ...DIFFICULTY_PROFILES.challenge.stages[stage], count };
  const deployment = waveDeployment(experiment, wave, { seed, stage, count })
    ?? { intervalMs: DEFENSE_CONFIG.spawnIntervalMs };
  return { wave, order, deployment };
}

function runScenario(candidate, route, populationNames, withSupport = false) {
  const { kind, tuning } = candidate;
  const { map, entry, goal, wallSite, towers, path } = prepareField(route, kind, withSupport);
  const economy = new ExpeditionEconomy(map, seed, undefined, "challenge", MIDGAME_EXPERIMENTS.combined.economy);
  const tracked = new Set(towers.map(({ id }) => id));
  const shotHits = new Map();
  const seen = new Map();
  const visitedCells = new Set();
  const cameThrough = new Set();
  const rewardByTower = {};
  const heavyAssists = [];
  const waveHits = new Map();
  const flight = [];
  const lossRecords = [];
  let currentWave = 0;
  let totalEffectiveDamage = 0;
  let wallsLost = 0;
  let wallDamage = 0;
  let towerKills = 0;
  let wallImpacts = 0;
  const simulation = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    const income = economy.handleEvent(event, metadata.waveId);
    if (event.type === "towerShot") {
      totalEffectiveDamage += event.damage;
      if (tracked.has(event.towerId)) {
        const recorded = shotHits.get(event.towerId) ?? [];
        assert.ok(!recorded.some(({ enemyId }) => enemyId === event.enemyId));
        recorded.push(event);
        shotHits.set(event.towerId, recorded);
        waveHits.set(event.enemyId, (waveHits.get(event.enemyId) ?? 0) + event.damage);
      }
    }
    if (event.type === "towerEffect") {
      assert.equal(event.effect.kind, kind);
      const recorded = shotHits.get(event.towerId);
      assert.deepEqual(event.enemyIds, recorded.map(({ enemyId }) => enemyId));
      flight.push({ towerId: event.towerId, wave: metadata.waveId, timeMs: metadata.timeMs,
        ...flightSamples(event, recorded, simulation) });
      shotHits.delete(event.towerId);
    }
    if (event.type === "towerKill") {
      towerKills += 1;
      rewardByTower[event.towerId] = (rewardByTower[event.towerId] ?? 0) + income;
      if (metadata.enemyKind === "armored" && !tracked.has(event.towerId) && waveHits.has(event.enemyId)) {
        heavyAssists.push({ enemyId: event.enemyId, wave: metadata.waveId,
          evolvedDamage: waveHits.get(event.enemyId), finisherId: event.towerId, income });
      }
      assert.equal(economy.handleEvent(event, metadata.waveId), 0, "Duplicate kill credits must be rejected");
    }
    if (event.type === "wallImpact") {
      wallDamage += event.damage;
      wallImpacts += 1;
      if (event.destroyed) {
        wallsLost += 1;
        lossRecords.push({ wave: currentWave, kind: "wall", id: event.wallId, timeMs: metadata.timeMs });
      }
    }
    if (event.type === "buildingHit" && event.destroyed) {
      lossRecords.push({ wave: currentWave, kind: event.buildingKind, id: event.buildingId, timeMs: metadata.timeMs });
    }
    if (event.type === "buildingContact") cameThrough.add(event.enemyId);
  }, false, { towerTuning: tuning, towerDiagnostics: true });

  const waves = [];
  for (const population of populationNames) {
    const { wave, order, deployment } = prepareWave(population);
    currentWave = wave;
    const kickoff = simulation.elapsedMs;
    assert.equal(simulation.requestWave(wave, order, deployment), order.count);
    for (let tick = 0; tick <= 45000 / stepMs; tick += 1) {
      for (const enemy of simulation.enemies) {
        visitedCells.add(key(enemy.cell));
        if (!seen.has(enemy.id)) seen.set(enemy.id, { wave: enemy.waveId, kind: enemy.kind, atMs: enemy.spawnedAtMs });
      }
      const { pending } = simulation.spawnCounts;
      if (!pending && [...simulation.enemies].every((enemy) => cameThrough.has(enemy.id))) break;
      simulation.step(stepMs);
    }
    const details = simulation.getWaveMetrics(wave);
    assert.equal(details.spawned, order.count);
    assert.equal(details.enemyKinds.armored.spawned, deployment.armor?.slots.length ?? 0);
    const arrivals = [...cameThrough].filter((id) => seen.get(id)?.wave === wave).length;
    assert.equal(details.towerKills + details.wallImpacts + arrivals, order.count,
      `${route.id} ${candidate.id} ${population.id} wave ${wave} did not resolve all its attackers`);
    assert.equal(details.wallDamage, details.wallImpacts * order.wallDamage
      - (details.wallsDestroyed && order.wallDamage === 2 ? 1 : 0));
    const roster = [...seen.values()].filter((enemy) => enemy.wave === wave);
    const spawnGaps = roster.slice(1).map((enemy, index) => enemy.atMs - roster[index].atMs);
    assert.equal(roster.length, order.count);
    assert.ok(spawnGaps.every((gap) => gap >= deployment.intervalMs));
    waves.push({ wave, population: population.id, normalHp: order.enemyHp, armored: details.enemyKinds.armored.spawned,
      wallHitDamage: order.wallDamage, plannedIntervalMs: deployment.intervalMs, actualSpawnIntervalMs: mean(spawnGaps),
      spawnMinGapMs: Math.min(...spawnGaps), spawnMaxGapMs: Math.max(...spawnGaps),
      entryBlockedSamples: details.entryOccupancyBlocks, spawned: details.spawned, peakActive: details.peakActive,
      towerKills: details.towerKills, wallImpacts: details.wallImpacts, wallDamage: details.wallDamage, arrivals,
      timeMs: simulation.elapsedMs - kickoff, roster });
  }
  const diagnostics = simulation.towerDiagnostics.filter((stats) => tracked.has(stats.towerId));
  assert.equal(diagnostics.length, towers.length);
  const shots = diagnostics.flatMap(({ shots }) => shots);
  assert.equal(shots.length, flight.length);
  const hits = shots.flatMap(({ targets }) => targets);
  const extra = hits.filter(({ role }) => role === "additional");
  const histogram = {};
  for (const shot of shots) histogram[shot.targets.length] = (histogram[shot.targets.length] ?? 0) + 1;
  const damage = diagnostics.reduce((sum, stats) => sum + stats.effectiveDamage, 0);
  assert.equal(damage, hits.reduce((sum, target) => sum + target.damage, 0));
  const exposed = diagnostics.flatMap(({ exposures }) => exposures);
  const armoredExits = diagnostics.reduce((sum, stats) => sum + stats.armoredExits, 0);
  const armoredExitHpSum = diagnostics.reduce((sum, stats) => sum + stats.armoredExitHpSum, 0);
  const ray = towers.map((tower) => {
    const attributes = evolvedTowerAttributes(tower.evolution, map.getBiome(tower.cell), tuning);
    const coverage = buildEvolvedTowerCoverage(map, tower.cell, attributes);
    return { towerId: tower.id, cell: tower.cell, axis: tower.evolution.axis,
      coveredAuthoredLane: path.filter((point) => evolvedTargetDistanceSquared(map, coverage, center(point)) !== undefined).length,
      rayReachTiles: coverage.kind === "piercing" ? coverage.negativeReach + coverage.positiveReach : null };
  });
  return {
    route: route.id, candidate: candidate.id, tuning, kind, highland: !!route.highland, withSupport, waves, ray,
    measuredVisitedCells: [...visitedCells], elapsedMs: simulation.elapsedMs,
    shots: shots.length, hitCount: hits.length, hist: histogram, averageTargets: shots.length ? hits.length / shots.length : null,
    primaryHits: hits.length - extra.length, additionalHits: extra.length, effectiveDamage: damage,
    totalEffectiveDamage, splashDamage: kind === "burst" ? extra.reduce((sum, hit) => sum + hit.damage, 0) : 0,
    overkillDamage: diagnostics.reduce((sum, stats) => sum + stats.overkillDamage, 0),
    armoredDamage: diagnostics.reduce((sum, stats) => sum + stats.armoredDamage, 0),
    armoredExits, armoredExitHpSum, meanArmoredExitHp: armoredExits ? armoredExitHpSum / armoredExits : null,
    averageExposureMs: mean(exposed.map(({ durationMs }) => durationMs)), armorAssistDetails: heavyAssists,
    evolvedKills: diagnostics.reduce((sum, stats) => sum + stats.kills, 0), towerKills,
    killIncome: economy.totals.killIncome, evolvedIncome: towers.reduce((sum, tower) => sum + (rewardByTower[tower.id] ?? 0), 0),
    wallsLost, wallImpacts, wallDamage, wallHpLeft: map.getBuilding(wallSite)?.hp ?? 0,
    arrived: cameThrough.size, buildingsLost: lossRecords.length, lossRecords, rewardByTower,
    meanNearestAtFire: mean(flight.flatMap(({ nearest }) => nearest === null ? [] : [nearest])),
    meanSecondNearestAtFire: mean(flight.flatMap(({ secondNearest }) => secondNearest === null ? [] : [secondNearest])),
    flight, diagnostics,
  };
}

export function runTowerSpecialization() {
  const routeMatrix = cases.flatMap((candidate) => routes.flatMap((route) =>
    populations.map((population) => runScenario(candidate, route, [population]))));
  const synergy = cases.filter(({ kind }) => kind === "piercing").flatMap((candidate) =>
    routes.filter(({ id }) => id === "long-straight" || id === "highland").map((route) =>
      runScenario(candidate, route, [populations[2]], true)));
  const matureWaves = [6, 7, 8].map((wave) => ({ ...populations[2], wave }));
  const maturePressure = cases.map((candidate) => runScenario(candidate, mature, matureWaves, true));
  return {
    seed, stepMs, build: "Challenge/W25 with real Combined queue and economy, fixed path combat target",
    model: "Authored routes and installed fixtures, no injected enemies or modified enemy parameters; full cardinal movement",
    enemyTravelMsPerTile: DEFENSE_CONFIG.travelMs, enemyTilesPerSecond: 1000 / DEFENSE_CONFIG.travelMs,
    radiusBoundary: "Inclusive squared world-position distance with floating-point tolerance",
    routeMatrix, synergy, maturePressure,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runTowerSpecialization(), null, 2));
}

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const stepMs = 25;
const cell = (col, row) => ({ col, row });
const same = (a, b) => a.col === b.col && a.row === b.row;
const turret = cell(11, 12);
const relative = (col, row) => cell(turret.col + col, turret.row + row);
const coord = ({ col, row }) => col + "," + row;
const invader = { enemyHp: 7, wallDamage: 3, contactDamage: 2 };
const seed = 60;

export async function loadTowerWallEngine(root = new URL("../", import.meta.url)) {
  const names = ["building-balance", "defense-simulation", "expedition-economy", "expedition-round",
    "midgame-experiments", "terrain", "tower-attack", "player"];
  const imports = await Promise.all(names.map((name) => import(new URL("src/" + name + ".ts", root))));
  return Object.assign({}, ...imports);
}

function rectangle(minCol, maxCol, minRow, maxRow) {
  const positions = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) positions.push(relative(col, row));
  }
  return positions;
}

function squarePerimeter(radius) {
  return rectangle(-radius, radius, -radius, radius).filter(({ col, row }) =>
    Math.max(Math.abs(col - turret.col), Math.abs(row - turret.row)) === radius);
}

function towerFootprint(kind) {
  if (kind === "vertical") return [turret, relative(0, 1), relative(0, 2), relative(0, 3)];
  if (kind === "burst") return [turret, relative(-1, 0), relative(-1, 1), relative(-2, 1)];
  if (kind === "standard") return [turret];
  return [turret, relative(-1, 0), relative(-2, 0), relative(-3, 0)];
}

function buildTower(map, kind) {
  const sites = towerFootprint(kind);
  sites.forEach((site) => assert.ok(map.placeBuilding("tower", site)));
  if (sites.length === 1) return map.getBuilding(turret);
  const ready = map.previewReadySynthesis(turret);
  assert.ok(ready);
  const stance = relative(1, 0);
  const merged = map.executeBuildingSynthesis(ready, stance);
  assert.ok(merged.success);
  assert.equal(merged.building.evolution.kind, kind === "burst" ? "burst" : "piercing");
  return merged.building;
}

function contactLane(radius, kind) {
  const vertical = kind === "vertical";
  const gate = vertical ? relative(0, -radius) : relative(radius, 0);
  const entry = vertical ? relative(0, -10) : relative(12, 0);
  const goal = vertical ? relative(-1, 0) : relative(0, 1);
  const lane = vertical ? rectangle(0, 0, -10, -1) : rectangle(1, 12, 0, 0);
  const behindGate = vertical ? relative(0, -radius - 1) : relative(radius + 1, 0);
  return { gate, entry, goal, lane, behindGate };
}

function passingLane(radius, offset) {
  return {
    gate: relative(radius, radius),
    entry: relative(10, offset),
    goal: relative(-8, offset),
    lane: rectangle(-8, 10, offset, offset),
  };
}

function initialLayout({ radius, layers, kind, terrain, offset, turning, highland }) {
  const columns = 24;
  const rows = 32;
  const outside = layers ? radius + layers - 1 : radius;
  let geometry = offset === undefined ? contactLane(outside, kind) : passingLane(outside, offset);
  if (turning) {
    assert.equal(kind, "horizontal");
    geometry = { ...geometry, entry: relative(outside + 2, 7),
      lane: [...rectangle(outside + 2, outside + 2, 1, 7), ...rectangle(outside, outside + 2, 0, 2)] };
    geometry.gate = relative(outside, 1);
  }
  if (terrain) {
    geometry = {
      ...geometry, goal: relative(outside + 2, 7),
      lane: [...geometry.lane, ...rectangle(outside + 2, outside + 2, 0, 7)],
    };
  }
  const openInterior = rectangle(-outside, outside, -outside, outside);
  const visibleSouthernLane = offset === undefined ? [] : rectangle(-8, 10, outside + 1, offset);
  const layout = Array.from({ length: rows }, () => Array(columns).fill("#"));
  // Leave shafts and side apertures between castle and optional parallel traffic.
  for (const position of [...openInterior, ...towerFootprint(kind), ...geometry.lane, ...visibleSouthernLane, relative(1, 0), geometry.goal]) {
    layout[position.row][position.col] = ".";
  }
  if (terrain && terrain !== "structure") layout[geometry.behindGate.row][geometry.behindGate.col] = terrain;
  layout[geometry.entry.row][geometry.entry.col] = "S";
  const biomes = Array.from({ length: rows }, () => Array(columns).fill("ordinary"));
  if (highland) biomes[turret.row][turret.col] = "highland";
  return { biomes, layout: layout.map((row) => row.join("")), ...geometry };
}

function fortify(map, gate, radius, layers, wallState) {
  if (wallState === "none" || layers === 0) return [];
  const positions = Array.from({ length: layers }, (_, layer) => squarePerimeter(radius + layer)).flat();
  if (wallState === "upgraded") {
    const matches = (site) => positions.some((other) => same(site, other));
    const anchors = [gate];
    for (let index = 0; index < anchors.length && anchors.length < 4; index += 1) {
      for (const [col, row] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const site = cell(anchors[index].col + col, anchors[index].row + row);
        if (matches(site) && !anchors.some((anchor) => same(anchor, site))) anchors.push(site);
        if (anchors.length === 4) break;
      }
    }
    anchors.forEach((site) => assert.ok(map.placeBuilding("wall", site)));
    const ready = map.previewReadySynthesis(gate);
    assert.ok(ready);
    const offsetCol = gate.col - turret.col;
    const offsetRow = gate.row - turret.row;
    const inner = cell(gate.col - Math.sign(offsetCol), gate.row - Math.sign(offsetRow));
    const builder = [inner, ...[-1, 0, 1].flatMap((col) => [-1, 0, 1].map((row) => cell(gate.col + col, gate.row + row)))]
      .find((site) => map.isWalkable(site));
    assert.ok(builder, "the upgraded wall needs a legal adjacent builder");
    const upgraded = map.executeBuildingSynthesis(ready, builder);
    assert.ok(upgraded.success);
    assert.equal(upgraded.building.maxHp, 50);
  }
  positions.forEach((site) => {
    if (map.getCell(site).terrain === "empty" && !map.getBuilding(site)) assert.ok(map.placeBuilding("wall", site));
  });
  if (wallState === "partial" || wallState === "broken") {
    const wall = map.getBuilding(gate);
    assert.ok(wall);
    assert.ok(map.impactWall(gate, wall.id, wallState === "partial" ? 12 : wall.hp));
  }
  return positions
    .map((site) => ({ site, building: map.getBuilding(site) }))
    .filter(({ building }) => building)
    .map(({ site, building }) => ({ ...site, hp: building.hp, maxHp: building.maxHp, id: building.id }));
}

function oldestReason(frame, map, check) {
  if (frame.decision === "hit") return "HIT";
  if (frame.decision === "cooldown") return "COOLDOWN";
  const candidate = frame.candidates.find(({ inSearchRange }) => inSearchRange);
  if (!candidate) return frame.candidates.length ? "OUT_OF_RANGE" : "NO_VALID_TARGET";
  if (candidate.rejectedByAxis && !candidate.obstructed) return "WRONG_AXIS";
  if (candidate.obstructed) {
    const selected = { x: candidate.world.x / check.tileSize, y: candidate.world.y / check.tileSize };
    // Diagnose an identical ray while ignoring only friendly walls in the read-only map view.
    const withoutWalls = { isWalkable: (position) => map.isWalkable(position) || map.getBuilding(position)?.kind === "wall" };
    const origin = { x: frame.orig.x / check.tileSize, y: frame.orig.y / check.tileSize };
    return check.lineOfSight(withoutWalls, origin, selected) ? "BLOCKED_BY_FRIENDLY_WALL" : "BLOCKED_BY_SOLID_TERRAIN";
  }
  return "NO_VALID_TARGET";
}

const anchors = (positions) => new Map(positions.map(({ id, hp }) => [id, hp]));

export function runTowerWallFixture(engine, options = {}) {
  const {
    kind = "horizontal", radius = 1, layers = 1, wallState = "intact", terrain, offset, turning = false,
    profile = "mixed", count = 30, durationMs = 12_000, ranged = {}, towerWallSynergy = false,
    diagnostic = true, highland = false, runType = "lane", tickMs = stepMs,
  } = options;
  const { TerrainMap, DefenseSimulation, ExpeditionEconomy, ExpeditionRound, PLAYTEST_TOWER_TUNING,
    MIDGAME_EXPERIMENTS, waveDeployment, evacuationDeployment, hasTowerLineOfSight, TILE_SIZE } = engine;
  const { gate, entry, goal, layout, biomes, behindGate } = initialLayout({ radius, layers, kind, terrain, offset, turning, highland });
  const map = new TerrainMap(layout, { buildingBalance: "w25", towerEvolution: true, autoMerge: false, biomes });
  const tower = buildTower(map, kind);
  if (runType === "mature") {
    for (const site of [relative(-1, -1), relative(1, -1)]) assert.ok(map.placeBuilding("tower", site));
  }
  if (terrain === "structure") assert.ok(map.placeBuilding("economy", behindGate));
  const occupiedMovement = terrain ? map.isWalkable(behindGate) : undefined;
  const initialWalls = fortify(map, gate, radius, layers, wallState);
  const wallHp = anchors(initialWalls);
  const economy = new ExpeditionEconomy(map, seed, undefined, "challenge", MIDGAME_EXPERIMENTS.combined.economy);
  const round = new ExpeditionRound(false, "challenge", runType === "evacuation");
  const reports = [];
  const frames = [];
  const reasons = {};
  const effectKinds = {};
  let firstDiscoveryMs;
  let firstRejection;
  let peakActive = 0;
  let waveDelivered = 0;
  let escapedUnits = 0;
  let playerDamage = 0;
  let firstPlayerHitMs = null;
  const escaped = new Set();
  const simulation = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    const { waveId, evacuationBatch, enemyKind, timeMs } = metadata;
    const credit = economy.handleEvent(event, waveId ?? (evacuationBatch === undefined ? undefined : -evacuationBatch));
    if (event.type === "evacuationHit") {
      const damage = round.hitEvacuation(event.damage);
      simulation.recordEvacuationDamage(evacuationBatch, damage);
    }
    if (event.type === "buildingContact" || event.type === "playerHit") {
      escaped.add(event.enemyId);
      escapedUnits = escaped.size;
    }
    if (event.type === "playerHit") {
      playerDamage += event.damage;
      firstPlayerHitMs ??= timeMs;
    }
    if (event.type === "wallImpact") wallHp.set(event.wallId, event.hp);
    if (["towerShot", "towerKill", "wallImpact", "towerEffect", "evacuationHit", "buildingHit", "buildingContact", "playerHit"].includes(event.type)) {
      reports.push({ ...event, cell: event.cell ?? metadata.cell, timeMs, enemyKind, waveId, evacuationBatch, credit,
        towerHit: metadata.towerHit?.kind });
    }
  }, runType !== "lane", {
    towerTargeting: true, towerWallSynergy,
    towerTuning: { ...PLAYTEST_TOWER_TUNING, piercingFallbackRange: 3, burstRange: 4, ...ranged },
    towerTargetingDiagnostics: diagnostic ? "trace" : undefined,
  });
  const queueEvacuation = ({ batch, order }) => assert.equal(simulation.requestEvacuationBatch(batch, order,
    evacuationDeployment("combined", batch, { seed, stage: round.stage, count: order.count })), order.count);

  if (runType === "lane") {
    const armor = profile === "mixed" ? { hp: 14, slots: Array.from({ length: count }, (_, index) => index).filter((index) => index % 4 === 2) }
      : profile === "armored" ? { hp: 14, slots: Array.from({ length: count }, (_, index) => index) } : undefined;
    assert.equal(simulation.requestWave(1, { count, ...invader }, { intervalMs: 100, armor }), count);
  } else if (runType === "evacuation") {
    queueEvacuation(round.activateEvacuation(2, goal.row));
  }

  for (let ms = tickMs; ms <= durationMs; ms += tickMs) {
    if (runType === "mature" && waveDelivered < 10) {
      const { spawned, removed, pending } = simulation.spawnCounts;
      const active = spawned - removed;
      const order = round.update(tickMs, goal.row, active, pending);
      if (order) {
        waveDelivered += 1;
        assert.equal(simulation.requestWave(round.wave, order, waveDeployment("combined", round.wave,
          { seed, stage: round.stage, count: order.count })), order.count);
      }
    }
    // Player contacts are consumed normally. The mature fixture keeps collecting
    // damage after a real player would have fallen so all candidates face ten identical wave orders.
    simulation.step(tickMs, runType === "mature" ? goal : undefined);
    const { requested, pending, spawned, removed } = simulation.spawnCounts;
    peakActive = Math.max(peakActive, spawned - removed);
    if (diagnostic) {
      const frame = simulation.towerTargetingTrace.at(-1);
      if (frame && frame.timeMs === ms) {
        const reason = typeof frame.reason === "string" ? frame.reason : oldestReason(frame, map, { lineOfSight: hasTowerLineOfSight, tileSize: TILE_SIZE });
        if (reason !== "HIT") reasons[reason] = (reasons[reason] ?? 0) + 1;
        const candidate = frame.candidates.find(({ inSearchRange }) => inSearchRange);
        if (candidate) firstDiscoveryMs ??= ms;
        if (frame.candidates.length && !frame.fired && !firstRejection && candidate) {
          firstRejection = { ms, reason, cooldownMs: frame.cooldownMs, candidate };
        }
        const previous = frames.at(-1);
        if (!previous || previous.reason !== reason || frame.fired || ms - previous.ms >= 1_000) {
          frames.push({ ms, reason, cooldownMs: frame.cooldownMs, candidates: frame.candidates.length,
            candidate: candidate ?? frame.candidates[0], selected: frame.selected, hits: frame.hits,
            wallImpactEnemyIds: frame.wallImpactEnemyIds, wallImpactsBeforeAim: frame.wallImpactsBeforeAim });
        }
      }
    }
    if (runType === "evacuation") {
      const second = round.updateEvacuation(tickMs, simulation.evacuationBatches);
      if (second) queueEvacuation(second);
      if (round.phase === "lost") simulation.clearBattle();
      if (round.phase !== "evacuating") break;
    } else if (runType === "lane" && requested > 0 && pending === 0 && spawned === removed) break;
    else if (runType === "mature" && waveDelivered === 10 && pending === 0 && spawned === removed) break;
  }

  const impacts = reports.filter(({ type }) => type === "wallImpact");
  const hits = reports.filter(({ type }) => type === "towerShot");
  const kills = reports.filter(({ type }) => type === "towerKill");
  const effects = reports.filter(({ type }) => type === "towerEffect");
  const casts = [...effects, ...hits.filter(({ towerHit }) => towerHit === "standard")];
  for (const { effect } of effects) effectKinds[effect.kind] = (effectKinds[effect.kind] ?? 0) + 1;
  const breachMs = impacts.find(({ destroyed }) => destroyed)?.timeMs ?? null;
  const beforeBreach = ({ timeMs }) => breachMs === null || timeMs < breachMs;
  const sumDamage = (events) => events.reduce((total, { damage }) => total + damage, 0);
  return {
    settings: { kind, radius, layers, wallState, terrain, offset, turning, profile, count, highland, runType, towerWallSynergy, ranged },
    points: { entry, gate, goal, tower: tower.cell, obstacle: terrain ? behindGate : undefined },
    obstacleWalkable: occupiedMovement,
    gateInitiallyWalkable: !initialWalls.some((wall) => same(wall, gate)),
    elapsedMs: simulation.elapsedMs, firstDiscoveryMs: firstDiscoveryMs ?? null,
    firstFireMs: hits[0]?.timeMs ?? null, firstImpactMs: impacts[0]?.timeMs ?? null,
    firstRejection, breachMs, reasonCounts: reasons, frames, peakActive, effectKinds,
    attacks: casts.length, hits: hits.length, damage: sumDamage(hits), towerKills: kills.length,
    preBreachAttacks: casts.filter(beforeBreach).length,
    preBreachKills: kills.filter(beforeBreach).length, preBreachDamage: sumDamage(hits.filter(beforeBreach)),
    maxTargets: Math.max(0, ...effects.map(({ enemyIds }) => enemyIds.length)),
    wallImpacts: impacts.length, wallDamage: sumDamage(impacts),
    wallsStart: initialWalls,
    wallsEnd: initialWalls.map(({ id, ...wall }) => ({ ...wall, hp: wallHp.get(id) ?? wall.hp })),
    gateHp: map.getBuilding(gate)?.hp ?? null,
    killIncome: economy.totals.killIncome, ...simulation.spawnCounts, waveDelivered, escapedUnits,
    playerDamage, firstPlayerHitMs, towersStillPlaced: [...map.getBuildings()].filter(({ kind }) => kind === "tower").length,
    endgame: round.evacuation ? { phase: round.phase, loss: round.lossReason, hp: round.evacuation.hp, playerHp: round.playerHp,
      damage: round.evacuation.maxHp - round.evacuation.hp, batches: simulation.evacuationBatches } : undefined,
    reports,
  };
}

export function runTowerWallMatrix(engine, { stage1 = false } = {}) {
  const defenses = [
    { name: "A-touching", radius: 1 },
    { name: "B-one-tile-gap", radius: 2 },
    { name: "C-two-tile-gap", radius: 3 },
    { name: "D-double-wall", radius: 1, layers: 2 },
    { name: "E-vertical", kind: "vertical" },
    { name: "F-turn", turning: true },
    { name: "G-burst-queue", kind: "burst" },
    { name: "H-rock-behind-wall", terrain: "#" },
    { name: "H-undug-soil-behind-wall", terrain: "+" },
    { name: "H-lake-behind-wall", terrain: "~" },
    { name: "H-producer-behind-wall", terrain: "structure" },
    { name: "J-ordinary-level-one", kind: "standard" },
  ];
  const synergySettings = engine.piercingFallbackRange ? [false, true] : [false];
  const diagnosticCases = defenses.flatMap(({ name, ...options }) =>
    synergySettings.map((towerWallSynergy) => ({ name, ...runTowerWallFixture(engine, { ...options, towerWallSynergy }) })));
  const wallStates = ["none", "intact", "partial", "upgraded", "broken"];
  const stageOne = ["horizontal", "burst"].flatMap((kind) => wallStates.flatMap((wallState) =>
    ["normal", "armored"].flatMap((profile) => synergySettings.map((towerWallSynergy) =>
      runTowerWallFixture(engine, { kind, radius: 2, wallState, profile, towerWallSynergy })))));
  if (stage1) return { version: engine.piercingFallbackRange ? "wall-fix-only" : "fd500e0", stepMs, stageOne, diagnosticCases };

  const ranges = ["horizontal", "burst"].flatMap((kind) => {
    const tested = kind === "horizontal" ? [3, 4, 5] : [4, 5, 6];
    return tested.flatMap((range) => tested.flatMap((offset) => ["normal", "armored"].map((profile) => runTowerWallFixture(engine, {
      kind, radius: 1, offset, profile, count: 12, durationMs: 5_500, towerWallSynergy: true,
      ranged: kind === "horizontal" ? { piercingFallbackRange: range } : { burstRange: range },
    }))));
  });
  const candidatePairs = [[3, 4], [4, 5], [5, 6]];
  const endgame = ["horizontal", "burst"].flatMap((kind) => candidatePairs.flatMap(([piercingFallbackRange, burstRange]) =>
    [false, true].map((towerWallSynergy) => runTowerWallFixture(engine, {
      kind, runType: "evacuation", radius: 2, towerWallSynergy, diagnostic: false,
      durationMs: 22_000, ranged: { piercingFallbackRange, burstRange }, turning: kind === "horizontal",
    }))));
  const mature = ["horizontal", "burst"].flatMap((kind) => candidatePairs.map(([piercingFallbackRange, burstRange]) =>
    runTowerWallFixture(engine, {
      kind, runType: "mature", radius: 2, towerWallSynergy: true, diagnostic: false,
      durationMs: 540_000, ranged: { piercingFallbackRange, burstRange }, turning: kind === "horizontal",
    })));
  return { version: "full", stepMs, stageOne, diagnosticCases, ranges, endgame, mature };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = process.argv.find((arg) => arg.startsWith("--root="));
  const root = option ? pathToFileURL(option.slice("--root=".length).replace(/[\\/]$/, "") + "/") : undefined;
  const engine = await loadTowerWallEngine(root);
  const result = runTowerWallMatrix(engine, { stage1: process.argv.includes("--stage1") });
  console.log(JSON.stringify(result));
}

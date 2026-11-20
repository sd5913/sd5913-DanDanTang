import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_CONFIG, DefenseSimulation, enemyPosition } from "../src/defense-simulation.ts";
import { generateExpeditionBiomes } from "../src/expedition-biomes.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { addExpeditionApproach, addExpeditionTiers } from "../src/expedition-terrain.ts";
import { GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionWorld } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const entry = cell(2, 5);
const objective = cell(20, 5);
const order = (count, enemyHp = 2, wallDamage = 2, contactDamage = 1) => ({ count, enemyHp, wallDamage, contactDamage });

function fixture({ gate = false, offLane = [], onEvent, biomes } = {}) {
  const layout = Array.from({ length: 32 }, (_, row) => Array.from({ length: 24 }, (_, col) => {
    if (col === entry.col && row === entry.row) return "S";
    if (gate && col === 3 && row === entry.row) return "+";
    if (row === entry.row && col > entry.col && col <= objective.col + 1) return ".";
    return offLane.some((point) => point.col === col && point.row === row) ? "." : "#";
  }).join(""));
  const map = new TerrainMap(layout, { biomes });
  const events = [];
  const simulation = new DefenseSimulation(map, entry, objective, (event, metadata) => {
    events.push({ event, metadata });
    onEvent?.(event, metadata, simulation);
  }, true);
  return { map, simulation, events };
}

function assertBalanced(simulation) {
  for (const wave of simulation.waveMetrics) {
    assert.equal(wave.planned, wave.spawned + wave.pending + wave.cancelledPending);
    assert.equal(wave.spawned, wave.active + wave.playerContacts + wave.towerKills
      + wave.wallImpacts + wave.cancelledActive);
    assert.equal(wave.active, [...simulation.enemies].filter((enemy) => enemy.waveId === wave.waveId).length);
    assert.ok(wave.threatened <= wave.spawned);
    assert.ok(wave.peakActive >= wave.active);
    assert.ok(wave.towerHitEnemies <= wave.towerExposed && wave.towerExposed <= wave.spawned);
    assert.ok(wave.towerHitsOnKills <= wave.towerHits);
    assert.ok(wave.wallsDestroyed <= wave.wallImpacts && wave.buildingsDestroyed <= wave.buildingContacts);
  }
}

test("two timed-out and overlapping wave cohorts keep their queued units and launch with their original identities", () => {
  const { map, simulation } = fixture({ gate: true });
  simulation.step(1_000);
  const firstOrder = order(3, 6);
  assert.equal(simulation.requestWave(1, firstOrder), 3);
  firstOrder.enemyHp = 12;
  assert.equal(simulation.requestWave(1, order(1)), 0);
  assert.equal(simulation.requestWave(0, order(1)), 0);
  assert.equal(simulation.requestWave(3, order(0)), 0);
  simulation.step(1_000);
  simulation.finishAttackPhase(1);
  assert.equal(simulation.requestWave(2, order(2, 7)), 2);
  simulation.step(500);
  simulation.finishAttackPhase(2);
  assertBalanced(simulation);
  const initial = simulation.waveMetrics;
  assert.deepEqual(initial.map(({ planned, spawned, pending, active, firstSpawnAtMs, settledAtMs }) =>
    [planned, spawned, pending, active, firstSpawnAtMs, settledAtMs]), [[3, 1, 2, 1, 1_000, null], [2, 0, 2, 0, null, null]]);
  assert.deepEqual(initial.map(({ startedAtMs, attackEndedAtMs, attackEndReason }) => [startedAtMs, attackEndedAtMs, attackEndReason]),
    [[1_000, 2_000, "time-limit"], [2_000, 2_500, "time-limit"]]);

  assert.ok(map.applyDigDamage(entry, cell(3, 5), 100).cleared);
  for (let frame = 0; frame < 40; frame += 1) simulation.step(50);
  assertBalanced(simulation);
  assert.deepEqual([...simulation.enemies].map(({ waveId, hp }) => [waveId, hp]), [[1, 6], [1, 6], [1, 6], [2, 7], [2, 7]]);
  const [one, two] = simulation.waveMetrics;
  assert.equal(one.peakActive, 3);
  assert.equal(two.peakActive, 2);
  assert.ok(two.firstSpawnAtMs > two.attackEndedAtMs, "A timed-out cohort may actually spawn later");
  assert.equal(one.pending + two.pending + one.cancelledActive + two.cancelledActive, 0);
  assert.equal(initial[0].pending, 2, "Readback snapshots cannot mutate from later simulation activity");
});

test("actual interpolated movement detects a five-cell defense entry during a long simulation step", () => {
  const anchor = cell(10, 6);
  const { map, simulation } = fixture({ offLane: [anchor] });
  assert.ok(map.placeBuilding("wall", anchor));
  simulation.requestWave(1, order(1));
  simulation.step(460);
  assert.equal(simulation.getWaveMetrics(1).threatened, 0, "Spawn and movement outside the circle do not count");
  simulation.step(2_300);
  const activated = simulation.getWaveMetrics(1);
  const expectedTime = (anchor.col - entry.col - Math.sqrt(5 ** 2 - 1)) * DEFENSE_CONFIG.travelMs;
  assert.ok(Math.abs(activated.firstThreatAtMs - expectedTime) < 1e-8);
  assert.equal(activated.threatened, 1);
  assert.ok(enemyPosition([...simulation.enemies][0]).x > anchor.col + 5, "Both coarse endpoints are outside the threat circle");
  assert.equal(activated.firstPlayerDamageAtMs, null);
  assert.equal(activated.firstBuildingDamageAtMs, null);
  simulation.step(1_000);
  assert.equal(simulation.getWaveMetrics(1).threatened, 1, "The same enemy only enters the count once");
  assertBalanced(simulation);
});

test("wall and non-wall damage are clipped, separated and reported with actual owned cells", () => {
  const { map, simulation, events } = fixture();
  const wall = map.placeBuilding("wall", cell(3, 5), 2);
  const structure = map.placeBuilding("economy", cell(4, 5), 3);
  assert.ok(wall && structure);
  simulation.requestWave(1, order(2, 9, 5, 8));
  simulation.step(1);
  simulation.step(DEFENSE_CONFIG.spawnIntervalMs);
  simulation.step(DEFENSE_CONFIG.travelMs);
  simulation.step(43);
  assert.equal(simulation.getWaveMetrics(1).buildingDamage, 0);
  simulation.step(1);
  const wave = simulation.getWaveMetrics(1);
  const hits = events.filter(({ event }) => event.type === "wallImpact" || event.type === "buildingHit");
  assert.deepEqual(hits.map(({ event, metadata }) => [event.type, event.damage, metadata.waveId, metadata.cell]),
    [["wallImpact", 2, 1, wall.cell], ["buildingHit", 3, 1, structure.cell]]);
  assert.equal(hits[0].metadata.timeMs, 1);
  assert.ok(hits[1].metadata.timeMs > 394 && hits[1].metadata.timeMs <= 395);
  assert.equal(wave.firstBuildingDamageAtMs, 1);
  assert.equal(wave.wallImpacts, 1);
  assert.equal(wave.wallDamage, 2);
  assert.equal(wave.wallsDestroyed, 1);
  assert.equal(wave.buildingContacts, 1);
  assert.equal(wave.buildingDamage, 3);
  assert.equal(wave.buildingsDestroyed, 1);
  assert.equal(wave.towerKills, 0);
  assert.equal(wave.active, 1);
  assert.equal(wave.settledAtMs, null);
  simulation.finishAttackPhase(1);
  assert.equal(simulation.getWaveMetrics(1).attackEndReason, "time-limit");
  assertBalanced(simulation);
  simulation.clearBattle();
  assert.equal(simulation.getWaveMetrics(1).cancelledActive, 1);
  assert.equal(simulation.getWaveMetrics(1).settledAtMs, 395);
  assertBalanced(simulation);
});

test("the first seeded wave destroys the initial facility but does not resolve any attackers", (t) => {
  const world = generateExpeditionWorld(12);
  const landscape = generateExpeditionBiomes(world.layout, world.effectiveSeed);
  const layout = addExpeditionApproach(addExpeditionTiers(landscape.layout, world.effectiveSeed));
  const map = new TerrainMap(layout, { biomes: landscape.biomes });
  const facilitySite = cell(17, 90);
  const economy = new ExpeditionEconomy(map, world.effectiveSeed, facilitySite);
  const facility = map.getBuilding(facilitySite);
  assert.equal(facility?.hp, 1);
  const player = cell(19, 82);
  const gate = cell(19, 83);
  assert.equal(map.applyDigDamage(cell(19, 84), gate, 5).cleared, true);
  assert.equal(map.applyDigDamage(gate, player, 5).cleared, true);
  assert.ok(map.placeBuilding("wall", gate));
  assert.ok(map.isWalkable(player));
  assert.deepEqual(map.getWalkableNeighbors(player), [], "The player is isolated behind a wall");
  const round = new ExpeditionRound(true);
  const events = [];
  const simulation = new DefenseSimulation(map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, (event, metadata) => {
    events.push({ event, metadata });
    economy.handleEvent(event);
    if (event.type === "playerHit") round.hitPlayer(event.damage);
  }, true);

  for (let frame = 0; frame < 300 && round.phase !== "recovering"; frame += 1) {
    const previous = round.phase;
    const { spawned, pending, removed } = simulation.spawnCounts;
    const firstOrder = round.update(25, player.row, spawned - removed, pending);
    if (firstOrder) {
      assert.equal(round.wave, 1);
      assert.equal(simulation.requestWave(round.wave, firstOrder), firstOrder.count);
    }
    if (previous === "attacking" && round.phase === "recovering") simulation.finishAttackPhase(round.wave);
    simulation.step(25, player);
  }

  assert.equal(round.phase, "recovering");
  assert.equal(round.wave, 1);
  assert.equal(map.getBuilding(facilitySite), undefined);
  const hits = events.filter(({ event }) => event.type === "buildingHit");
  assert.deepEqual(hits.map(({ event, metadata }) =>
    [event.buildingId, event.damage, event.destroyed, metadata.waveId]), [[facility.id, 1, true, 1]]);
  assert.ok([...simulation.enemies].some(({ id }) => id === hits[0].event.enemyId));
  const wave = simulation.getWaveMetrics(1);
  const result = {
    planned: wave.planned, spawned: wave.spawned, pending: wave.pending, active: wave.active,
    buildingHits: wave.buildingContacts, buildingsDestroyed: wave.buildingsDestroyed,
    wallImpacts: wave.wallImpacts, playerContacts: wave.playerContacts, towerKills: wave.towerKills,
  };
  assert.deepEqual(result, {
    planned: 3, spawned: 3, pending: 0, active: 3,
    buildingHits: 1, buildingsDestroyed: 1, wallImpacts: 0, playerContacts: 0, towerKills: 0,
  });
  assert.equal(wave.attackEndReason, "time-limit");
  assert.equal(wave.settledAtMs, null);
  assert.equal(simulation.spawnCounts.removed, 0);
  assert.equal(economy.totals.killIncome, 0);
  assertBalanced(simulation);
  t.diagnostic("Seed 12, Baseline fast first wave: " + JSON.stringify(result));
});

test("a lethal player hit records applied HP before terminal cancellation, without attributing pending enemies as kills", () => {
  const round = new ExpeditionRound();
  round.hitPlayer(3);
  const { simulation, events } = fixture({ onEvent(event, metadata, simulation) {
    if (event.type !== "playerHit") return;
    const before = round.playerHp;
    round.hitPlayer(event.damage);
    simulation.recordPlayerDamage(metadata.waveId, before - round.playerHp, metadata.timeMs);
    simulation.clearBattle();
  } });
  simulation.requestWave(1, order(3, 2, 1, 4));
  simulation.requestWave(2, order(2));
  simulation.step(74, cell(3, 5));
  assert.equal(round.playerHp, 1, "An adjacent enemy must cover half a tile before contact");
  simulation.step(1, cell(3, 5));
  simulation.step(500, cell(3, 5));
  assert.equal(round.phase, "lost");
  const [one, two] = simulation.waveMetrics;
  assert.deepEqual([one.playerContacts, one.playerDamage, one.firstPlayerDamageAtMs, one.firstThreatAtMs], [1, 1, 75, 0]);
  assert.deepEqual([one.attackEndReason, one.cancelledActive, one.cancelledPending, one.settledAtMs], ["terminal", 0, 2, 75]);
  assert.deepEqual([two.attackEndReason, two.cancelledActive, two.cancelledPending, two.settledAtMs], ["terminal", 0, 2, 75]);
  assert.equal(events.filter(({ event }) => event.type === "playerHit").length, 1);
  assertBalanced(simulation);
});

test("terminal cleanup classifies truly spawned survivors separately from cancelled queued units and is idempotent", () => {
  const { simulation } = fixture({ gate: true });
  simulation.requestWave(1, order(3));
  simulation.step(30);
  simulation.finishAttackPhase(1);
  simulation.requestWave(2, order(2));
  simulation.step(20);
  simulation.clearBattle();
  const state = simulation.waveMetrics;
  assert.deepEqual(state.map(({ cancelledActive, cancelledPending, attackEndReason, settledAtMs }) =>
    [cancelledActive, cancelledPending, attackEndReason, settledAtMs]), [[1, 2, "time-limit", 50], [0, 2, "terminal", 50]]);
  simulation.clearBattle();
  assert.deepEqual(simulation.waveMetrics, state);
  assert.equal(simulation.spawnCounts.pending, 0);
  assertBalanced(simulation);

  simulation.reset();
  assert.deepEqual(simulation.waveMetrics, []);
  assert.equal(simulation.elapsedMs, 0);
  assert.equal(simulation.requestWave(1, order(1)), 1);
  assert.equal(simulation.getWaveMetrics(1).startedAtMs, 0);
});

test("tower removals count only against their own wave, and direct debug spawns are unowned", () => {
  const towerCell = cell(6, 6);
  const { map, simulation, events } = fixture({ offLane: [towerCell] });
  assert.ok(map.placeBuilding("tower", towerCell));
  simulation.spawn(1, 1);
  simulation.requestWave(1, order(1));
  simulation.step(1);
  assert.equal(simulation.getWaveMetrics(1).towerKills, 0);
  assert.equal(events.find(({ event }) => event.type === "towerKill")?.metadata.waveId, undefined);
  simulation.step(DEFENSE_CONFIG.towerIntervalMs);
  simulation.step(DEFENSE_CONFIG.towerIntervalMs);
  const wave = simulation.getWaveMetrics(1);
  assert.equal(wave.towerKills, 1);
  assert.equal(wave.threatened, 1);
  assert.equal(wave.firstThreatAtMs, wave.firstSpawnAtMs);
  assert.equal(events.filter(({ event }) => event.type === "towerKill").at(-1).metadata.waveId, 1);
  assertBalanced(simulation);
});

test("2, 4 and 7 HP enemies require 1, 2 and 4 real hits and longer exposure to one unchanged tower", () => {
  const tower = cell(2, 7);
  const expectedHits = [[2, 1], [4, 2], [7, 4]];
  for (const [enemyHp, hits] of expectedHits) {
    const { map, simulation, events } = fixture({ gate: true, offLane: [tower] });
    assert.ok(map.placeBuilding("tower", tower));
    simulation.requestWave(1, order(1, enemyHp));
    assert.equal(simulation.getWaveMetrics(1).firstTowerExposureAtMs, 0);
    assert.equal(simulation.getWaveMetrics(1).towerHits, 0);
    assert.equal(simulation.getWaveMetrics(1).averageTowerHitsOnKill, null);
    for (let frame = 0; frame < 24; frame += 1) simulation.step(50);
    const wave = simulation.getWaveMetrics(1);
    const exposure = 50 + (hits - 1) * DEFENSE_CONFIG.towerIntervalMs;
    assert.equal(events.filter(({ event }) => event.type === "towerShot").length, hits);
    assert.equal(events.filter(({ event }) => event.type === "towerKill").length, 1);
    assert.deepEqual([wave.towerHits, wave.towerHitEnemies, wave.towerHitsOnKills, wave.towerExposed,
      wave.towerExposureKills, wave.totalTowerExposureToKillMs, wave.averageTowerHitsOnKill,
      wave.averageTowerExposureToKillMs], [hits, 1, hits, 1, 1, exposure, hits, exposure]);
    assertBalanced(simulation);
  }
});

test("actual highland range is seven tiles and exposure spans the full cooldown before selection", () => {
  const tower = cell(2, 12);
  const biomes = Array.from({ length: 32 }, () => Array(24).fill("ordinary"));
  const ordinary = fixture({ gate: true, offLane: [tower], biomes });
  assert.ok(ordinary.map.placeBuilding("tower", tower));
  ordinary.simulation.requestWave(1, order(1));
  ordinary.simulation.step(700);
  assert.equal(ordinary.simulation.getWaveMetrics(1).towerExposed, 0);
  assert.equal(ordinary.simulation.getWaveMetrics(1).towerHits, 0);

  biomes[tower.row][tower.col] = "highland";
  const { map, simulation } = fixture({ gate: true, offLane: [tower], biomes });
  assert.ok(map.placeBuilding("tower", tower));
  simulation.spawn(1, 1);
  simulation.step(1); // the unowned enemy leaves the offscreen tower on cooldown
  simulation.requestWave(1, order(1));
  simulation.step(DEFENSE_CONFIG.towerIntervalMs - 1);
  assert.equal(simulation.getWaveMetrics(1).towerExposed, 1);
  assert.equal(simulation.getWaveMetrics(1).firstTowerExposureAtMs, 1);
  assert.equal(simulation.getWaveMetrics(1).firstThreatAtMs, null, "The five-cell defense metric is independent of tower range");
  assert.equal(simulation.getWaveMetrics(1).towerHits, 0);

  simulation.step(1);
  const wave = simulation.getWaveMetrics(1);
  assert.equal(wave.towerKills, 1);
  assert.equal(wave.averageTowerExposureToKillMs, DEFENSE_CONFIG.towerIntervalMs);
  assertBalanced(simulation);
});

test("a surviving 7 HP enemy still hits a wall for its configured damage and never credits kill-only samples", () => {
  const tower = cell(3, 7);
  const { map, simulation } = fixture({ offLane: [tower] });
  assert.ok(map.placeBuilding("tower", tower));
  const wall = map.placeBuilding("wall", cell(5, 5), 10);
  assert.ok(wall);
  simulation.requestWave(1, order(1, 7, 4));
  for (let frame = 0; frame < 8; frame += 1) simulation.step(50);
  const wave = simulation.getWaveMetrics(1);
  assert.equal(wave.wallImpacts, 1);
  assert.equal(wave.wallDamage, 4);
  assert.equal(map.getBuilding(wall.cell)?.hp, 6);
  assert.equal(wave.towerHits, 1);
  assert.equal(wave.towerHitsOnKills, 0);
  assert.equal(wave.towerKills, 0);
  assert.equal(wave.towerExposureKills, 0);
  assert.equal(wave.averageTowerExposureToKillMs, null);
  assertBalanced(simulation);
});

test("equal wall damage is independent of each cohort's enemy HP", () => {
  const { map, simulation } = fixture();
  const wall = map.placeBuilding("wall", cell(3, 5), 10);
  assert.ok(wall);
  for (const [index, hp] of [2, 4, 7].entries()) {
    const waveId = index + 1;
    simulation.requestWave(waveId, order(1, hp, 3));
    simulation.step(DEFENSE_CONFIG.spawnIntervalMs);
    simulation.step(1);
    assert.equal(simulation.getWaveMetrics(waveId).wallDamage, 3);
    assert.equal(map.getBuilding(wall.cell)?.hp, 10 - 3 * waveId);
  }
  assertBalanced(simulation);
});

test("two ready towers cannot both hit or kill the same 2 HP enemy after removal", () => {
  const left = cell(2, 7);
  const right = cell(3, 7);
  const { map, simulation, events } = fixture({ gate: true, offLane: [left, right] });
  assert.ok(map.placeBuilding("tower", left));
  assert.ok(map.placeBuilding("tower", right));
  simulation.requestWave(1, order(1));
  simulation.step(50);
  simulation.step(DEFENSE_CONFIG.towerIntervalMs);
  const wave = simulation.getWaveMetrics(1);
  assert.deepEqual([wave.towerExposed, wave.towerHitEnemies, wave.towerHits, wave.towerHitsOnKills, wave.towerKills], [1, 1, 1, 1, 1]);
  assert.equal(events.filter(({ event }) => event.type === "towerKill").length, 1);
  assertBalanced(simulation);
});

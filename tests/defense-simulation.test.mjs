import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { DEFENSE_LAYOUT, DEFENSE_TARGET, ENEMY_ENTRY } from "../src/defense-map.ts";
import { DEFENSE_CONFIG, DefenseSimulation } from "../src/defense-simulation.ts";
import { GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionMap } from "../src/generated-map.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { TerrainMap } from "../src/terrain.ts";

const gate = { col: 11, row: 89 };
const gateApproach = { col: 11, row: 90 };
const wallCell = { col: 11, row: 87 };
const towerCell = { col: 12, row: 94 };

function openGate(map) {
  assert.equal(map.applyDigDamage(gateApproach, gate, MINING_CONFIG.dirtMaxHp).cleared, true);
}

function createSimulation({ gateOpen = true } = {}) {
  const map = new TerrainMap(DEFENSE_LAYOUT);
  if (gateOpen) openGate(map);
  const events = [];
  const simulation = new DefenseSimulation(map, ENEMY_ENTRY, DEFENSE_TARGET, (event) => events.push(event));
  return { map, events, simulation };
}

test("AI-04: three of four enemies hit a 3 HP wall once each, and the fourth passes", () => {
  const { map, events, simulation } = createSimulation();
  const wall = map.placeBuilding("wall", wallCell, 3);
  assert.ok(wall);
  assert.equal(simulation.spawn(4, 1), 4);
  const ids = [...simulation.enemies].map((enemy) => enemy.id);

  simulation.step(DEFENSE_CONFIG.travelMs * 11);
  assert.deepEqual(events.filter((event) => event.type === "wallImpact"), [2, 1, 0].map((hp, index) => ({
    type: "wallImpact", enemyId: ids[index], wallId: wall.id, damage: 1, hp, destroyed: hp === 0,
  })));
  const survivors = [...simulation.enemies];
  assert.deepEqual(survivors.map((enemy) => enemy.id), [ids[3]]);
  assert.ok(survivors[0].cell.row < wallCell.row, "the fourth enemy must walk beyond the destroyed wall");
  assert.equal(map.isWalkable(wallCell), true);
  assert.equal(simulation.counters.wallImpacts, 3);
  assert.equal(simulation.counters.wallsDestroyed, 1);
  assert.equal(simulation.counters.towerKills, 0);
});

test("AI-07: two enemies arriving on one tick at a 1 HP wall produce one hit and one survivor", () => {
  const { map, events, simulation } = createSimulation();
  const wall = map.placeBuilding("wall", wallCell, 1);
  assert.ok(wall);
  simulation.spawn(2, 1);
  const [first, second] = [...simulation.enemies].map((enemy) => enemy.id);
  const timeToWall = (ENEMY_ENTRY.row - wallCell.row - 1) * DEFENSE_CONFIG.travelMs;
  simulation.step(timeToWall - 1);
  assert.equal(simulation.counters.wallImpacts, 0);
  assert.equal(map.getBuilding(wallCell)?.hp, 1);
  assert.equal([...simulation.enemies].every((enemy) => enemy.move?.to.row === wallCell.row + 1), true);

  simulation.step(1);
  assert.deepEqual(events.filter((event) => event.type === "wallImpact"), [{
    type: "wallImpact", enemyId: first, wallId: wall.id, damage: 1, hp: 0, destroyed: true,
  }]);
  assert.deepEqual([...simulation.enemies].map((enemy) => enemy.id), [second]);
  simulation.step(DEFENSE_CONFIG.travelMs * 2);
  assert.ok([...simulation.enemies][0].cell.row < wallCell.row);
  assert.equal(simulation.counters.wallImpacts, 1);
  assert.equal(simulation.counters.wallsDestroyed, 1);
});

test("AI-08: automatic tower shots honor cooldown and report kills separately from wall impacts", () => {
  const { map, events, simulation } = createSimulation();
  const wall = map.placeBuilding("wall", wallCell, 1);
  assert.ok(wall);
  simulation.spawn(1, 1);
  const wallAttackerId = [...simulation.enemies][0].id;
  simulation.step(DEFENSE_CONFIG.travelMs * 8);
  assert.equal(simulation.counters.wallImpacts, 1);
  assert.equal(simulation.counters.towerKills, 0);

  const tower = map.placeBuilding("tower", towerCell);
  assert.ok(tower);
  simulation.spawn(3, 1);
  const towerTargetIds = [...simulation.enemies].map((enemy) => enemy.id);
  simulation.step(1);
  assert.equal(simulation.counters.shots, 1);
  assert.equal(simulation.counters.towerKills, 1);
  simulation.step(DEFENSE_CONFIG.towerIntervalMs - 1);
  assert.equal(simulation.counters.shots, 1);
  assert.equal([...simulation.enemies].length, 2);
  simulation.step(1);
  assert.equal(simulation.counters.shots, 2);
  simulation.step(DEFENSE_CONFIG.towerIntervalMs);
  assert.equal(simulation.counters.shots, 3);
  assert.equal(simulation.counters.towerKills, 3);
  assert.equal(simulation.counters.wallImpacts, 1);
  assert.equal([...simulation.enemies].length, 0);

  assert.deepEqual(events.filter((event) => event.type === "towerShot").map((event) => event.enemyId), towerTargetIds);
  assert.deepEqual(events.filter((event) => event.type === "towerKill"), towerTargetIds.map((enemyId) => ({
    type: "towerKill", enemyId, towerId: tower.id,
  })));
  assert.deepEqual(events.filter((event) => event.type === "wallImpact").map((event) => event.enemyId), [wallAttackerId]);
});

test("AI-09: the world simulation crosses both seams with no viewport and stays at the target approach", () => {
  const { map, simulation } = createSimulation();
  simulation.spawn(1, 1);
  const boundaries = [];
  let previous = ENEMY_ENTRY;
  for (let tick = 0; tick < 100; tick += 1) {
    simulation.step(DEFENSE_CONFIG.travelMs);
    const [enemy] = simulation.enemies;
    assert.ok(enemy);
    assert.ok(map.isWalkable(enemy.cell));
    if (map.worldToChunk(enemy.cell).chunk.chunkRow !== map.worldToChunk(previous).chunk.chunkRow) {
      boundaries.push([previous.row, enemy.cell.row]);
    }
    previous = enemy.cell;
  }
  assert.deepEqual(boundaries, [[64, 63], [32, 31]]);
  assert.deepEqual(previous, { col: DEFENSE_TARGET.col, row: DEFENSE_TARGET.row + 1 });
  assert.equal(simulation.counters.buildingContacts, 1);
  assert.equal(simulation.searchCount, 1);
});

test("FIX02: a southern enemy can navigate from beyond column 24 and cross both seams after the route is dug", () => {
  const map = new TerrainMap(generateExpeditionMap(12));
  const simulation = new DefenseSimulation(map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL);
  assert.equal(simulation.spawn(1, 1), 1);
  simulation.step(DEFENSE_CONFIG.travelMs);
  const [enemy] = simulation.enemies;
  assert.deepEqual(enemy.cell, GENERATED_ENEMY_ENTRY);
  assert.equal(enemy.unreachable, true);

  const route = [{ col: GENERATED_ENEMY_ENTRY.col, row: 93 }, { col: GENERATED_ENEMY_ENTRY.col, row: 92 }];
  for (let col = GENERATED_ENEMY_ENTRY.col - 1; col >= GENERATED_GOAL.col; col -= 1) route.push({ col, row: 92 });
  for (let row = 91; row >= GENERATED_GOAL.row; row -= 1) route.push({ col: GENERATED_GOAL.col, row });

  let previous = GENERATED_ENEMY_ENTRY;
  for (const cell of route) {
    if (!map.isWalkable(cell)) {
      assert.equal(map.applyDigDamage(previous, cell, MINING_CONFIG.dirtMaxHp).cleared, true);
    }
    previous = cell;
  }

  const seams = [];
  previous = enemy.cell;
  for (let tick = 0; tick <= route.length; tick += 1) {
    simulation.step(DEFENSE_CONFIG.travelMs);
    assert.ok(map.isWalkable(enemy.cell));
    if (map.worldToChunk(enemy.cell).chunk.chunkRow !== map.worldToChunk(previous).chunk.chunkRow) {
      seams.push([previous.row, enemy.cell.row]);
    }
    previous = enemy.cell;
  }
  assert.deepEqual(seams, [[64, 63], [32, 31]]);
  assert.equal(enemy.unreachable, false);
  assert.equal(simulation.counters.buildingContacts, 1);
});

test("target and contact events switch to a visible player and emit only once per stable target", () => {
  const { map, events, simulation } = createSimulation({ gateOpen: false });
  const player = { col: 11, row: 88 };
  simulation.spawn(1, 1);
  const enemyId = [...simulation.enemies][0].id;
  const step = DEFENSE_CONFIG.travelMs;
  simulation.step(step, player);
  assert.deepEqual(events, [{
    type: "targetSelected", enemyId, target: { kind: "building", cell: DEFENSE_TARGET },
  }]);

  openGate(map);
  for (let tick = 0; tick < 8; tick += 1) simulation.step(step, player);
  assert.deepEqual(events.slice(1), [
    { type: "targetSelected", enemyId, target: { kind: "player", cell: player } },
    { type: "playerContact", enemyId, target: player },
  ]);
  assert.equal(simulation.counters.playerContacts, 1);
  assert.equal(simulation.counters.buildingContacts, 0);

  for (let tick = 0; tick < 100; tick += 1) simulation.step(step);
  assert.deepEqual(events.slice(3), [
    { type: "targetSelected", enemyId, target: { kind: "building", cell: DEFENSE_TARGET } },
    { type: "buildingContact", enemyId, target: DEFENSE_TARGET },
  ]);
  assert.equal(simulation.counters.playerContacts, 1);
  assert.equal(simulation.counters.buildingContacts, 1);
  assert.equal([...simulation.enemies][0].hp, DEFENSE_CONFIG.enemyHp);
  assert.equal(map.isWalkable(DEFENSE_TARGET), true);
});

for (const count of [50, 100, 250]) {
  test(`AI-11: ${count} active units share one route field across 320 simulation steps`, (context) => {
    const map = new TerrainMap(DEFENSE_LAYOUT);
    openGate(map);
    const simulation = new DefenseSimulation(map, ENEMY_ENTRY, DEFENSE_TARGET);
    assert.equal(simulation.spawn(count, 1), count);
    assert.equal([...simulation.enemies].length, count);
    const samples = [];
    const steps = 320;
    const deltaMs = 1_000 / 60;
    for (let step = 0; step < steps; step += 1) {
      const start = performance.now();
      simulation.step(deltaMs);
      samples.push(performance.now() - start);
    }
    const enemies = [...simulation.enemies];
    assert.equal(enemies.length, count);
    assert.ok(enemies.every((enemy) => enemy.cell.row <= 63 && !enemy.unreachable), "all active units must advance across a seam");
    assert.equal(simulation.searchCount, 1);
    const total = samples.reduce((sum, value) => sum + value, 0);
    const ordered = samples.slice().sort((a, b) => a - b);
    const p95 = ordered[Math.ceil(steps * 0.95) - 1];
    const max = ordered.at(-1);
    context.diagnostic(
      `units=${count} steps=${steps} deltaMs=${deltaMs.toFixed(3)} searchCount=${simulation.searchCount} ` +
      `simulationCPU totalMs=${total.toFixed(3)} meanMs=${(total / steps).toFixed(3)} ` +
      `p95Ms=${p95.toFixed(3)} maxMs=${max.toFixed(3)} (Node timing, no rendering)`,
    );
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_CONFIG, DefenseSimulation, EVACUATION_DEVICE_HALF_SIZE } from "../src/defense-simulation.ts";
import { boxDistance, ENEMY_RADIUS } from "../src/enemy-contact.ts";
import { EVACUATION_CONFIG } from "../src/evacuation.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { evacuationDeployment, waveDeployment } from "../src/midgame-experiments.ts";
import { cellCenter, TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row = 4) => ({ col, row });
const entry = cell(2);
const defaultGoal = cell(20);

function corridor({ goal = defaultGoal, barrier, barrierMarker = "+" } = {}) {
  const layout = Array.from({ length: 32 }, (_, row) => Array.from({ length: 24 }, (_, col) => {
    if (row !== entry.row) return "#";
    if (col === entry.col) return "S";
    if (col === goal.col) return "G";
    if (col === barrier?.col) return barrierMarker;
    return col > entry.col && col < goal.col ? "." : "#";
  }).join(""));
  return new TerrainMap(layout, { buildingBalance: "w25", autoMerge: false });
}

function runEvacuation(map, goal = defaultGoal, options = {}) {
  const round = new ExpeditionRound(false, "challenge", true);
  const events = [];
  const spawns = new Map();
  const simulation = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    events.push({ event, metadata });
    if (event.type === "playerHit") round.hitPlayer(event.damage);
    if (event.type === "evacuationHit") {
      const applied = round.hitEvacuation(event.damage);
      simulation.recordEvacuationDamage(metadata.evacuationBatch, applied);
    }
    if (round.phase === "lost") simulation.clearBattle();
  }, true);

  function enqueue({ batch, order }) {
    const deployment = options.deployment ?? evacuationDeployment("combined", batch, {
      seed: 12, stage: round.stage, count: order.count,
    });
    const deployed = { ...order, ...options.order };
    assert.equal(simulation.requestEvacuationBatch(batch, deployed, deployment), order.count);
    captureSpawns();
  }

  function captureSpawns() {
    for (const enemy of simulation.enemies) {
      if (spawns.has(enemy.id)) continue;
      assert.deepEqual(enemy.point, cellCenter(entry));
      assert.deepEqual(enemy.cell, entry);
      spawns.set(enemy.id, { kind: enemy.kind, batch: enemy.evacuationBatch, waveId: enemy.waveId });
    }
  }

  function advance(ms, player) {
    simulation.step(ms, player);
    captureSpawns();
    const next = round.updateEvacuation(ms, simulation.evacuationBatches);
    if (next) enqueue(next);
  }

  function until(done, player, maxSteps = 1_200) {
    for (let i = 0; i < maxSteps && !done(); i += 1) advance(25, player);
    assert.ok(done(), "Evacuation did not reach the expected phase");
  }

  return { round, simulation, events, spawns, enqueue, advance, until, captureSpawns };
}

test("Playtest goal arrival requires activation, preserves the active difficulty and resets cleanly", () => {
  const round = new ExpeditionRound(false, "challenge", true);
  assert.equal(round.reachGoal(2), false);
  assert.equal(round.activateEvacuation(1, 4), undefined);
  assert.equal(round.phase, "preparing");
  assert.deepEqual(round.activateEvacuation(2, 4), {
    batch: 1, order: { count: 12, enemyHp: 7, wallDamage: 3, contactDamage: 2 },
  });
  assert.deepEqual(round.evacuation, { batch: 1, hp: 6, maxHp: 6, planned: 32 });
  assert.equal(round.activateEvacuation(2, 4), undefined);
  assert.equal(round.update(120_000, 4, 0, 0), undefined);
  assert.equal(round.wave, 0);
  assert.equal(round.phase, "evacuating");
  round.reset();
  assert.equal(round.evacuation, undefined);
  assert.equal(round.lossReason, undefined);
  assert.equal(round.phase, "preparing");

  const legacy = new ExpeditionRound();
  assert.equal(legacy.activateEvacuation(2, 4), undefined);
  assert.equal(legacy.reachGoal(2), true);
});

test("Combined final batches reuse the late cadence with independent deterministic armor slots", () => {
  for (const batch of [1, 2]) {
    const count = EVACUATION_CONFIG.batchCounts[batch - 1];
    const context = { seed: 12, stage: 2, count };
    const deployment = evacuationDeployment("combined", batch, context);
    assert.equal(deployment.intervalMs, waveDeployment("combined", 6, context).intervalMs);
    assert.deepEqual(deployment, evacuationDeployment("combined", batch, context));
    assert.equal(deployment.armor.hp, 14);
    assert.equal(deployment.armor.slots.length, Math.round(count / 4));
    assert.notDeepEqual(deployment.armor.slots, waveDeployment("combined", 5 + batch, context).armor.slots);
  }
});

test("both fully spawned batches remain pending until every final enemy resolves at real walls", () => {
  const map = corridor();
  for (const col of [4, 7, 10, 13]) assert.equal(map.placeBuilding("wall", cell(col)).hp, 25);
  const { round, simulation, events, spawns, enqueue, until } = runEvacuation(map);
  const first = round.activateEvacuation(2, 4);
  assert.equal(simulation.requestEvacuationBatch(2, { ...first.order, count: 20 }), 0);
  enqueue(first);
  assert.equal(simulation.requestEvacuationBatch(1, first.order), 0);
  until(() => simulation.evacuationBatches[1]?.spawned === 20);
  assert.equal(round.phase, "evacuating", "The last spawn does not grant a victory");
  assert.ok(simulation.evacuationBatches[1].active > 0);
  until(() => round.phase === "won");
  assert.equal(round.evacuation.hp, 6);
  assert.equal(round.playerHp, 4);
  assert.equal(simulation.evacuationRouteBlocked, false);
  assert.deepEqual(simulation.evacuationBatches.map(({ spawned, pending, active, resolved, wallImpacts }) =>
    [spawned, pending, active, resolved, wallImpacts]), [[12, 0, 0, 12, 12], [20, 0, 0, 20, 20]]);
  assert.ok(simulation.evacuationPeakActive > 1);
  assert.equal(spawns.size, 32);
  assert.equal([...spawns.values()].filter(({ batch, kind }) => batch === 1 && kind === "armored").length, 3);
  assert.equal([...spawns.values()].filter(({ batch, kind }) => batch === 2 && kind === "armored").length, 5);
  assert.equal(events.filter(({ event }) => event.type === "wallImpact").length, 32);
  assert.equal(events.filter(({ event }) => event.type === "evacuationHit").length, 0);
  assert.deepEqual(simulation.waveMetrics, []);
});

test("a completed batch waits briefly before releasing the next batch", () => {
  const round = new ExpeditionRound(false, "challenge", true);
  round.activateEvacuation(2, 4);
  const partial = { batch: 1, spawned: 11, pending: 1, cancelledPending: 0, cancelledActive: 0 };
  assert.equal(round.updateEvacuation(3_000, [partial]), undefined);
  assert.equal(round.evacuation.batch, 1);
  const first = { ...partial, spawned: 12, pending: 0, active: 11, resolved: 1 };
  assert.equal(round.updateEvacuation(EVACUATION_CONFIG.batchGapMs - 1, [first]), undefined);
  assert.equal(round.updateEvacuation(1, [first]).order.count, 20);
  assert.equal(round.updateEvacuation(9_000, [first, {
    batch: 2, spawned: 20, pending: 0, active: 0, resolved: 20, cancelledPending: 0, cancelledActive: 0,
  }]), undefined);
  assert.equal(round.phase, "evacuating", "The first batch may still be fighting");
});

test("blocked terrain cannot damage the device or grant victory, and excavating it reopens the route", () => {
  const barrier = cell(8);
  const map = corridor({ barrier });
  const { round, simulation, events, enqueue, advance, until } = runEvacuation(map);
  enqueue(round.activateEvacuation(2, 4));
  assert.equal(simulation.evacuationRouteBlocked, true);
  for (let elapsed = 0; elapsed < 12_000; elapsed += 25) advance(25);
  assert.equal(round.phase, "evacuating");
  assert.equal(round.evacuation.hp, 6);
  assert.equal(simulation.evacuationBatches[0].pending, 11);
  assert.equal(events.filter(({ event }) => event.type === "evacuationHit").length, 0);

  assert.equal(map.applyDigDamage(cell(7), barrier, 100, 2).cleared, true);
  assert.equal(simulation.evacuationRouteBlocked, false);
  until(() => round.phase === "lost");
  assert.equal(round.lossReason, "evacuation");
  assert.equal(round.playerHp, 4);
  const hits = events.filter(({ event }) => event.type === "evacuationHit");
  assert.equal(hits.length, 3);
  for (const { event, metadata } of hits) {
    assert.ok(Math.abs(boxDistance(event.enemyWorld, cellCenter(defaultGoal), EVACUATION_DEVICE_HALF_SIZE) - ENEMY_RADIUS) < 1e-9);
    assert.equal(event.damage, 2);
    assert.equal(metadata.waveId, undefined);
    assert.ok(metadata.evacuationBatch);
  }
  const batches = simulation.evacuationBatches;
  assert.equal(batches.reduce((sum, batch) => sum + batch.deviceDamage, 0), 6);
  for (const batch of batches) {
    assert.equal(batch.active + batch.pending, 0);
    assert.equal(batch.spawned, batch.resolved + batch.cancelledActive);
    assert.equal(batch.planned, batch.spawned + batch.cancelledPending);
  }
});

test("enemy contacts the wall or structure along the route before advancing to the device", () => {
  const map = corridor();
  const wall = map.placeBuilding("wall", cell(4), 1);
  const building = map.placeBuilding("economy", cell(7));
  const { round, simulation, events, enqueue, advance, until } = runEvacuation(map);
  enqueue(round.activateEvacuation(2, 4));
  advance(DEFENSE_CONFIG.travelMs);
  assert.equal(events.some(({ event }) => event.type === "wallImpact"), false,
    "Reaching the adjacent cell center does not yet contact the wall");
  until(() => events.some(({ event }) => event.type === "buildingHit"));
  const impact = events.find(({ event }) => event.type === "wallImpact").event;
  assert.equal(impact.wallId, wall.id);
  const hit = events.find(({ event }) => event.type === "buildingHit").event;
  assert.equal(hit.buildingId, building.id);
  assert.equal(hit.destroyed, true);
  assert.equal(map.getBuilding(building.cell), undefined);
  const survivor = [...simulation.enemies].find(({ id }) => id === hit.enemyId);
  assert.ok(survivor);
  assert.equal(boxDistance(survivor.point, cellCenter(building.cell), TILE_SIZE / 2), ENEMY_RADIUS);
  until(() => events.some(({ event }) => event.type === "evacuationHit"));
  assert.equal(events.find(({ event }) => event.type === "evacuationHit").event.enemyId, survivor.id);
});

test("ordinary units retain their own ledger while overkill device damage is capped", () => {
  const goal = cell(4);
  const map = corridor({ goal });
  const { round, simulation, events, enqueue, advance, captureSpawns } = runEvacuation(map, goal, {
    order: { contactDamage: 9 },
    deployment: { intervalMs: 100 },
  });
  assert.equal(simulation.requestWave(1, { count: 2, enemyHp: 4, wallDamage: 1, contactDamage: 1 }), 2);
  captureSpawns();
  enqueue(round.activateEvacuation(2, 4));
  assert.deepEqual([...simulation.enemies].map(({ waveId, evacuationBatch }) => [waveId, evacuationBatch]), [[1, undefined]]);
  advance(1, entry);
  assert.equal(round.playerHp, 3);
  assert.equal(simulation.waveMetrics[0].playerContacts, 1);
  assert.equal(simulation.evacuationBatches[0].playerContacts, 0);
  // The already-requested ordinary reinforcement waits in the queue during final deployment.
  assert.equal(simulation.evacuationBatches[0].pending, 12);
  advance(DEFENSE_CONFIG.spawnIntervalMs);
  assert.equal(simulation.evacuationBatches[0].spawned, 1);
  assert.equal(simulation.waveMetrics[0].pending, 1);
  advance(3 * DEFENSE_CONFIG.travelMs);
  const hit = events.find(({ event }) => event.type === "evacuationHit");
  assert.equal(hit.event.damage, 9);
  assert.equal(round.lossReason, "evacuation");
  assert.equal(simulation.evacuationBatches[0].deviceDamage, 6);
  assert.equal(simulation.evacuationBatches[0].deviceContacts, 1);
  assert.equal(simulation.evacuationBatches[0].cancelledPending, 11);
  assert.equal(simulation.waveMetrics[0].playerContacts, 1);
});

test("a single step settles independent ordinary player contact and final device contact", () => {
  const goal = cell(4);
  const map = corridor({ goal });
  const { round, simulation, events, enqueue, advance, captureSpawns } = runEvacuation(map, goal, {
    deployment: { intervalMs: 1_000 },
  });
  assert.equal(simulation.requestWave(1, { count: 1, enemyHp: 4, wallDamage: 1, contactDamage: 1 }), 1);
  captureSpawns();
  advance(DEFENSE_CONFIG.spawnIntervalMs + 1);
  enqueue(round.activateEvacuation(2, 4));
  const approach = TILE_SIZE - EVACUATION_DEVICE_HALF_SIZE - ENEMY_RADIUS - 0.25;
  advance((1 + approach / TILE_SIZE) * DEFENSE_CONFIG.travelMs);
  assert.ok(!events.some(({ event }) => event.type === "playerHit" || event.type === "evacuationHit"));

  advance(3, cell(3));
  const contacts = events.filter(({ event }) => event.type === "playerHit" || event.type === "evacuationHit");
  assert.deepEqual(contacts.map(({ event, metadata }) => [event.type, metadata.waveId, metadata.evacuationBatch]), [
    ["playerHit", 1, undefined], ["evacuationHit", undefined, 1],
  ]);
  assert.equal(round.playerHp, 3);
  assert.equal(round.evacuation.hp, 4);
  assert.equal(simulation.waveMetrics[0].playerContacts, 1);
  assert.equal(simulation.evacuationBatches[0].playerContacts, 0);
  assert.equal(simulation.evacuationBatches[0].deviceDamage, 2);
});

test("an ordinary lethal contact still loses the round during an active evacuation", () => {
  const map = corridor();
  const { round, simulation, events, enqueue, advance, captureSpawns } = runEvacuation(map);
  assert.equal(simulation.requestWave(1, { count: 1, enemyHp: 4, wallDamage: 1, contactDamage: 4 }), 1);
  captureSpawns();
  enqueue(round.activateEvacuation(2, 4));
  advance(1, entry);
  assert.equal(round.lossReason, "player");
  assert.equal(round.evacuation.hp, 6);
  assert.equal(simulation.evacuationBatches[0].resolved, 0);
  assert.equal(simulation.evacuationBatches[0].cancelledPending, 12);
  assert.equal(events.find(({ event }) => event.type === "playerHit").metadata.waveId, 1);
});

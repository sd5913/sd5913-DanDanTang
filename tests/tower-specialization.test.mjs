import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_TOWER_TUNING } from "../src/building-balance.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { runTowerSpecialization } from "./tower-specialization.mjs";

const cell = (col, row) => ({ col, row });

function stationaryArena(kind, tuning, targets, rock) {
  const layout = Array.from({ length: 32 }, () => Array(24).fill("#"));
  for (let row = 5; row <= 13; row += 1) {
    for (let col = 4; col <= 16; col += 1) layout[row][col] = ".";
  }
  const entry = cell(5, 6);
  const goal = cell(21, 27);
  layout[entry.row][entry.col] = "S";
  layout[goal.row][goal.col] = "G";
  if (rock) layout[rock.row][rock.col] = "#";
  const map = new TerrainMap(layout.map((row) => row.join("")), { towerEvolution: true, buildingBalance: "w25" });
  const shots = [];
  const simulation = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    if (event.type === "towerShot") shots.push({ event, timeMs: metadata.timeMs });
  }, false, { towerTuning: tuning });
  const sites = kind === "burst"
    ? [cell(8, 8), cell(7, 8), cell(7, 7), cell(8, 7)]
    : [cell(8, 8), cell(7, 8), cell(6, 8), cell(5, 8)];
  for (const site of sites) assert.ok(map.placeBuilding("tower", site));
  assert.equal(map.getBuilding(sites[0]).evolution.kind, kind);
  assert.equal(simulation.spawn(targets.length, 1, { hp: 14, contactDamage: 1 }), targets.length);
  for (const [index, enemy] of [...simulation.enemies].entries()) {
    // The disconnected destination keeps these exact coordinates stable for threshold tests.
    const [x, y] = targets[index];
    enemy.cell = cell(Math.floor(x), Math.floor(y));
    enemy.point = { x: x * TILE_SIZE, y: y * TILE_SIZE };
  }
  return { map, simulation, shots };
}

test("FIX01-B: each candidate includes the exact splash radius, excludes just beyond, and damages the primary once", () => {
  for (const radius of [1.25, 1.75, 2]) {
    const { simulation, shots } = stationaryArena("burst", { ...CONTROL_TOWER_TUNING, burstRadius: radius },
      [[10.25, 8.5], [10.25 + radius, 8.5], [10.25 + radius + 0.0001, 8.5], [10.25, 8.5]]);
    simulation.step(1);
    assert.deepEqual(shots.map(({ event }) => [event.enemyId, event.damage]), [[1, 4], [2, 2], [4, 2]]);
    assert.deepEqual([...simulation.enemies].map(({ hp }) => hp), [10, 12, 14, 12]);
  }
});

test("FIX01-B: two true tile spacings remain inclusive despite interpolated world-coordinate rounding", () => {
  // This pair reproduces the floating-point gap observed between live queued enemies.
  const origin = 9.566666666666666;
  const atBoundary = 11.566666666666668;
  assert.ok(atBoundary - origin > 2);
  const { simulation, shots } = stationaryArena("burst", { ...CONTROL_TOWER_TUNING, burstRadius: 2 },
    [[origin, 8.5], [atBoundary, 8.5], [atBoundary + 0.0001, 8.5]]);
  simulation.step(1);
  assert.deepEqual(shots.map(({ event }) => [event.enemyId, event.damage]), [[1, 4], [2, 2]]);
  assert.deepEqual([...simulation.enemies].map(({ hp }) => hp), [10, 12, 14]);
});

test("FIX01-B: the largest radius leaves an occluded armored unit and a friendly wall intact", () => {
  const { map, simulation, shots } = stationaryArena("burst", { ...CONTROL_TOWER_TUNING, burstRadius: 2 },
    [[10.5, 8.5], [11.49, 9.5], [11.75, 8.5], [10.5, 7.5]], cell(11, 8));
  const wall = map.placeBuilding("wall", cell(10, 9));
  assert.equal(wall.hp, 25);
  simulation.step(1);
  assert.deepEqual(shots.map(({ event }) => [event.enemyId, event.damage]), [[1, 4], [4, 2]]);
  assert.deepEqual([...simulation.enemies].map(({ hp }) => hp), [10, 14, 14, 12]);
  assert.equal(map.getBuilding(wall.cell).hp, 25);
});

test("FIX01-C: both cooldowns act exactly at their deadlines on a legal 14 HP target", () => {
  for (const interval of [900, 750]) {
    const { simulation, shots } = stationaryArena("piercing", { ...CONTROL_TOWER_TUNING, piercingIntervalMs: interval },
      [[11.5, 8.5], [11.5, 9.5]]);
    simulation.step(1);
    for (let attack = 2; attack <= 3; attack += 1) {
      simulation.step(interval - 1);
      assert.equal(shots.length, attack - 1);
      simulation.step(1);
      assert.equal(shots.length, attack);
    }
    assert.deepEqual(shots.map(({ event, timeMs }) => [event.enemyId, event.damage, timeMs]),
      [[1, 5, 1], [1, 5, 1 + interval], [1, 4, 1 + interval * 2]]);
    assert.deepEqual([...simulation.enemies].map(({ hp }) => hp), [14]);
  }
});

test("FIX01-B/C: matched routes use live queues and damage accounting across all five candidates", () => {
  const { routeMatrix, synergy, maturePressure } = runTowerSpecialization();
  assert.equal(routeMatrix.length, 120);
  assert.equal(synergy.length, 4);
  assert.equal(maturePressure.length, 5);
  const all = [...routeMatrix, ...synergy, ...maturePressure];
  for (const row of all) {
    assert.equal(row.shots, row.flight.length);
    assert.equal(row.hitCount, row.primaryHits + row.additionalHits);
    assert.equal(row.primaryHits, row.shots);
    assert.ok(row.effectiveDamage <= row.totalEffectiveDamage);
    assert.ok(row.evolvedKills <= row.towerKills);
    assert.ok(row.evolvedIncome <= row.killIncome);
    assert.ok(row.buildingsLost <= 1);
    assert.ok(row.armorAssistDetails.every(({ evolvedDamage, income }) => evolvedDamage > 0 && income > 0));
    assert.ok(row.diagnostics.every(({ decisions, shots }) =>
      decisions.noTarget + decisions.noLegalTarget + decisions.cooldown + decisions.legalReady > 0
      && shots.every(({ targets }) => new Set(targets.map(({ enemyId }) => enemyId)).size === targets.length)));
    for (const wave of row.waves) {
      assert.ok(wave.actualSpawnIntervalMs >= wave.plannedIntervalMs);
      assert.equal(wave.towerKills + wave.wallImpacts + wave.arrivals, wave.spawned);
    }
  }
  for (const variants of Map.groupBy(routeMatrix, (row) => `${row.route}/${row.kind}/${row.waves[0].population}`).values()) {
    const reference = variants[0];
    for (const variant of variants) {
      assert.deepEqual(variant.ray, reference.ray, "Tuning does not edit firing geometry");
      assert.deepEqual(variant.waves[0].roster.map(({ kind }) => kind), reference.waves[0].roster.map(({ kind }) => kind));
    }
  }
  assert.ok(routeMatrix.some((row) => row.kind === "burst" && (row.hist[3] ?? 0) > 0));
  assert.ok(routeMatrix.some((row) => row.kind === "piercing" && row.ray[0].axis === "vertical" && row.hitCount > 0));
  assert.ok(routeMatrix.some((row) => row.kind === "piercing" && row.ray[0].axis === "horizontal" && row.hitCount > 0));
  assert.ok(routeMatrix.some((row) => row.kind === "burst" && row.diagnostics[0].decisions.occludedTargets > 0));
  assert.ok(routeMatrix.some((row) => row.kind === "piercing" && row.diagnostics[0].decisions.offAxisTargets > 0));
  assert.ok(synergy.some(({ diagnostics }) => diagnostics.some(({ assists }) => assists > 0)));
  assert.ok(maturePressure.some(({ kind, armorAssistDetails }) => kind === "piercing" && armorAssistDetails.length > 0));
});

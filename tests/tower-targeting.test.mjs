import assert from "node:assert/strict";
import test from "node:test";
import { PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";
import { DefenseSimulation, enemyPosition } from "../src/defense-simulation.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { TILE_SIZE } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const point = (x, y) => ({ x, y });
const source = cell(8, 8);
const horizontal = [source, cell(7, 8), cell(6, 8), cell(5, 8)];
const vertical = [source, cell(8, 7), cell(8, 6), cell(8, 5)];
const burst = [source, cell(7, 8), cell(7, 7), cell(6, 7)];
const testTick = 0.0001;

function battle({ entry = cell(3, 25), target = entry, markers = [], highland = false,
  towerTargeting = true, isOpen = () => true, onEvent = () => {} } = {}) {
  const layout = Array.from({ length: 32 }, (_, row) => Array.from({ length: 24 }, (_, col) => isOpen(col, row) ? "." : "#"));
  layout[entry.row][entry.col] = "S";
  for (const [position, marker] of markers) layout[position.row][position.col] = marker;
  const biomes = Array.from({ length: 32 }, () => Array(24).fill("ordinary"));
  if (highland) biomes[source.row][source.col] = "highland";
  const map = new TerrainMap(layout.map((row) => row.join("")), { towerEvolution: true, buildingBalance: "w25", biomes });
  const events = [];
  const defense = new DefenseSimulation(map, entry, target, (event, metadata) => {
    events.push({ event, metadata });
    onEvent(event, metadata);
  }, false, { towerTuning: PLAYTEST_TOWER_TUNING, towerTargeting, towerTargetingDiagnostics: "trace" });
  return { map, defense, ofType: (type) => events.filter(({ event }) => event.type === type) };
}

function positionEnemy(enemy, { x, y }) {
  enemy.cell = cell(Math.floor(x), Math.floor(y));
  enemy.point = point(x * TILE_SIZE, y * TILE_SIZE);
  enemy.move = undefined;
}

function placeUnits(defense, positions) {
  assert.equal(defense.spawn(positions.length, 1, { hp: 14, contactDamage: 1 }), positions.length);
  const units = [...defense.enemies];
  units.forEach((unit, index) => positionEnemy(unit, positions[index]));
  return units;
}

function placeTowers(map, sites) {
  for (const site of sites) assert.ok(map.placeBuilding("tower", site));
  return map.getBuilding(source);
}

test("the horizontal beam uses a finite strip, overlaps the enemy body at the range edge, and records actual hits", () => {
  const { map, defense, ofType } = battle();
  placeTowers(map, horizontal);
  const units = placeUnits(defense, [point(13, 8.5), point(13.5, 8.5 + 5.2 / TILE_SIZE),
    point(13.5, 8.5 + 6.2 / TILE_SIZE), point(15.6, 8.5), point(15.8, 8.5)]);
  defense.step(testTick);
  assert.deepEqual(units.map(({ hp }) => hp), [9, 9, 14, 9, 14]);
  assert.equal(ofType("towerEffect")[0].event.effect.kind, "piercing");
  assert.equal(ofType("towerEffect")[0].event.effect.halfWidth, 1 / TILE_SIZE);
  const [trace] = defense.towerTargetingTrace;
  assert.deepEqual(trace.orig, point(8.5 * TILE_SIZE, 8.5 * TILE_SIZE));
  assert.equal(trace.nominalRange, 7);
  assert.equal(trace.decision, "hit");
  assert.deepEqual(trace.selected, [1, 2, 4]);
  assert.deepEqual(trace.hits, trace.selected);
  assert.ok(Math.abs(trace.candidates[1].world.y - (8.5 * TILE_SIZE + 5.2)) < 0.001);
  assert.ok(trace.candidates[2].rejectedByAxis);
  assert.equal(trace.candidates[3].inNominalRange, false);
  assert.equal(trace.candidates[3].bodyInAttackArea, true);
  assert.equal(trace.candidates[4].inSearchRange, false);
});

test("vertical highland beam uses the same width and passes the full 9-tile edge without expanding the axis", () => {
  const { map, defense, ofType } = battle({ highland: true });
  placeTowers(map, vertical);
  const units = placeUnits(defense, [point(8.5 + 5.2 / TILE_SIZE, 14), point(8.5 + 6.2 / TILE_SIZE, 14),
    point(8.5, 17.65), point(8.5, 17.8)]);
  defense.step(testTick);
  assert.deepEqual(units.map(({ hp }) => hp), [9, 14, 9, 14]);
  assert.equal(defense.towerTargetingTrace[0].nominalRange, 9);
  assert.deepEqual(ofType("towerEffect")[0].event.effect.to, point(8.5, 17.5));
});

test("the weak fallback hits only the nearest visible target at two or three tiles and uses the main deadline", () => {
  const { map, defense, ofType } = battle();
  placeTowers(map, horizontal);
  const units = placeUnits(defense, [point(8.5, 10.5), point(8.5, 11.5), point(8.5, 11.8)]);
  defense.step(testTick);
  assert.deepEqual(units.map(({ hp }) => hp), [12, 14, 14]);
  assert.equal(ofType("towerEffect")[0].event.effect.kind, "piercingFallback");
  assert.equal(ofType("towerShot")[0].metadata.towerHit.kind, "piercing");
  defense.step(749.98);
  positionEnemy(units[0], point(14.5, 8.5));
  defense.step(0.01);
  assert.equal(ofType("towerEffect").length, 1);
  assert.equal(defense.towerTargetingTrace.at(-1).decision, "cooldown");
  for (const [index, position] of [point(14.5, 8.5), point(8.5, 11.5), point(8.5, 11.8)].entries()) {
    positionEnemy(units[index], position);
  }
  defense.step(0.02);
  assert.deepEqual(ofType("towerEffect").map(({ event }) => event.effect.kind), ["piercingFallback", "piercing"]);
  assert.equal(ofType("towerShot").at(-1).event.damage, 5);

  const edge = battle();
  placeTowers(edge.map, horizontal);
  const edgeUnits = placeUnits(edge.defense, [point(8.5, 11.5), point(8.5, 11.8)]);
  edge.defense.step(testTick);
  assert.deepEqual(edgeUnits.map(({ hp }) => hp), [12, 14]);
});

test("enhanced pierce follows the selected side and still prioritizes up to four on-axis targets over a closer corner", () => {
  const { map, defense, ofType } = battle();
  placeTowers(map, horizontal);
  const units = placeUnits(defense, [point(9.5, 8.5), point(10.5, 8.5), point(11.5, 8.5),
    point(12.5, 8.5), point(13.5, 8.5), point(8.5, 9.5)]);
  defense.step(testTick);
  assert.deepEqual(ofType("towerEffect")[0].event.enemyIds, [1, 2, 3, 4]);
  assert.deepEqual(units.map(({ hp }) => hp), [9, 9, 9, 9, 14, 14]);
  for (const unit of units) positionEnemy(unit, point(3.5, 8.5));
  defense.step(749.99);
  for (const unit of units) positionEnemy(unit, point(3.5, 8.5));
  defense.step(0.02);
  assert.equal(ofType("towerEffect").length, 2);
  assert.deepEqual(ofType("towerEffect").at(-1).event.effect.to, point(1.5, 8.5));
});

test("the same moving armored unit can be hit on both sides after pathing around the tower", () => {
  const { map, defense, ofType } = battle({ entry: cell(14, 8), target: cell(1, 8),
    isOpen: (col, row) => row === 8 || (row === 9 && col >= 7 && col <= 9) });
  placeTowers(map, horizontal);
  assert.equal(defense.requestWave(1, { count: 1, wallDamage: 1, enemyHp: 4, contactDamage: 1 },
    { intervalMs: 100, armor: { hp: 14, slots: [0] } }), 1);
  for (let tick = 0; tick < 150; tick++) defense.step(16);
  const shots = ofType("towerShot").filter(({ metadata }) => metadata.towerHit.rawDamage === 5);
  assert.ok(shots.length >= 2);
  assert.ok(shots[0].event.to.x > 8.5);
  assert.ok(shots.at(-1).event.to.x < 8.5);
  assert.ok(shots.every(({ event, metadata }) => event.enemyId === 1 && metadata.enemyKind === "armored"));
});

test("solid terrain blocks the finite-width main ray and close fallback, including diagonal corner cuts", () => {
  for (const marker of ["#", "+", "~", "wall"]) {
    const { map, defense, ofType } = battle({
      markers: [[cell(9, 8), marker === "wall" ? "." : marker], [cell(8, 9), "#"]],
    });
    placeTowers(map, horizontal);
    if (marker === "wall") assert.ok(map.placeBuilding("wall", cell(9, 8)));
    const units = placeUnits(defense, [point(10.5, 8.5), point(9.5, 9.5)]);
    defense.step(testTick);
    assert.deepEqual(units.map(({ hp }) => hp), [14, 14]);
    assert.equal(ofType("towerEffect").length, 0);
    const [trace] = defense.towerTargetingTrace;
    assert.equal(trace.decision, "no-legal-shot");
    assert.ok(trace.candidates.every((candidate) => candidate.obstructed && !candidate.fallbackEligible));
  }
});

test("an actual armored enemy turning one lane beside a piercer takes a backup shot, while old tuning never fires", () => {
  const entry = cell(12, 9);
  const target = cell(9, 14);
  const isOpen = (col, row) => (col >= 5 && col <= 9 && row === 8)
    || (col >= 8 && col <= 12 && row === 9) || (col === 9 && row >= 10 && row <= 14);
  for (const towerTargeting of [false, true]) {
    const { map, defense, ofType } = battle({ entry, target, isOpen, towerTargeting });
    assert.equal(defense.requestWave(1, { count: 1, wallDamage: 1, enemyHp: 4, contactDamage: 1 },
      { intervalMs: 100, armor: { hp: 14, slots: [0] } }), 1);
    defense.step(testTick);
    const [unit] = defense.enemies;
    assert.equal(unit.kind, "armored");
    let observedTurn = false;
    for (let i = 0; i < 240; i++) {
      defense.step(16);
      if (unit.move?.to.row === 10 && enemyPosition(unit).y > 9.55) {
        observedTurn = true;
        break;
      }
    }
    assert.ok(observedTurn, "the real path should round the one-tile corner before towers are placed");
    placeTowers(map, horizontal);
    defense.step(16);
    assert.equal(unit.hp, towerTargeting ? 12 : 14);
    assert.deepEqual(ofType("towerEffect").map(({ event }) => event.effect.kind), towerTargeting ? ["piercingFallback"] : []);
  }
});

test("ordinary towers extend only to enemy body contact and preserve their established obstruction behavior", () => {
  const { map, defense, ofType } = battle({ markers: [[cell(9, 8), "#"]] });
  placeTowers(map, [source]);
  const units = placeUnits(defense, [point(13.65, 8.5), point(13.8, 8.5)]);
  defense.step(testTick);
  assert.deepEqual(units.map(({ hp }) => hp), [12, 14]);
  assert.equal(ofType("towerShot")[0].metadata.towerHit.kind, "standard");
  const [trace] = defense.towerTargetingTrace;
  assert.equal(trace.nominalRange, 5);
  assert.equal(trace.candidates[0].obstructed, true);
  assert.equal(trace.candidates[0].mainEligible, true);
  assert.equal(trace.candidates[1].inSearchRange, false);
});

test("burst searches four tiles plus enemy-body contact and applies a separate two-tile splash to moving units", () => {
  const { map, defense, ofType } = battle();
  placeTowers(map, burst);
  const units = placeUnits(defense, [point(12.65, 8.5), point(13.5, 8.5), point(14.65, 8.5), point(14.66, 8.5)]);
  units.forEach((unit) => {
    unit.move = { to: cell(unit.cell.col, 9), end: point(unit.point.x, unit.point.y + TILE_SIZE), durationMs: 1000, elapsedMs: 0 };
  });
  defense.step(testTick);
  assert.deepEqual(units.map(({ hp }) => hp), [10, 12, 12, 14]);
  const [trace] = defense.towerTargetingTrace;
  assert.equal(trace.nominalRange, 4);
  assert.equal(trace.candidates[0].inNominalRange, false);
  assert.equal(trace.candidates[0].mainEligible, true);
  assert.equal(trace.candidates[1].inSearchRange, false);
  assert.equal(ofType("towerEffect")[0].event.effect.radius, 2);
  const [stats] = defense.towerTargetingMetrics;
  assert.deepEqual([stats.searches, stats.candidates, stats.splashSearches, stats.splashCandidates, stats.fires], [1, 4, 1, 4, 1]);
});

test("a fallback kill clips overkill and credits the same spawn wave exactly once", () => {
  const entry = cell(8, 10);
  let economy;
  const { map, defense, ofType } = battle({ entry, target: cell(8, 13),
    onEvent: (event, metadata) => economy.handleEvent(event, metadata.waveId) });
  economy = new ExpeditionEconomy(map, 12, undefined, "challenge", { killDecay: true });
  placeTowers(map, horizontal);
  assert.equal(defense.requestWave(1, { count: 1, wallDamage: 1, enemyHp: 1, contactDamage: 1 }), 1);
  defense.step(testTick);
  defense.step(1_000);
  const [{ event, metadata }] = ofType("towerShot");
  assert.equal(event.damage, 1);
  assert.equal(metadata.towerHit.overkill, 1);
  assert.equal(metadata.waveId, 1);
  assert.equal(ofType("towerShot").length, 1);
  assert.equal(ofType("towerKill").length, 1);
  assert.equal(ofType("towerEffect")[0].event.effect.kind, "piercingFallback");
  assert.equal(economy.balance, ECONOMY_PROTOTYPE.towerKillReward);
  assert.equal(defense.getWaveMetrics(1).towerKills, 1);
});

test("an invalid candidate does not trigger a shot or spend a cooldown", () => {
  const { map, defense, ofType } = battle();
  placeTowers(map, horizontal);
  const [invalid, eligible] = placeUnits(defense, [point(9.5, 8.5), point(20.5, 8.5)]);
  invalid.hp = 0;
  defense.step(testTick);
  const [trace] = defense.towerTargetingTrace;
  assert.equal(trace.decision, "no-target");
  assert.equal(trace.fired, false);
  assert.equal(trace.candidates[0].rejectedAsInvalid, true);
  positionEnemy(eligible, point(10.5, 8.5));
  defense.step(testTick);
  assert.deepEqual(ofType("towerEffect")[0].event.enemyIds, [eligible.id]);
});

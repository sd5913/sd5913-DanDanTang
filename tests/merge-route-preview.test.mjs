import assert from "node:assert/strict";
import test from "node:test";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { EnemyNavigation } from "../src/enemy-navigation.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const key = ({ col, row }) => `${col},${row}`;
const spawn = cell(7, 11);
const entry = cell(8, 17);
const goal = cell(12, 8);
const gate = cell(12, 9);
const mergeSites = [cell(6, 12), cell(7, 12), cell(8, 12), cell(9, 12)];
const known = { revision: 0, allKnown: true, isKnown: () => true, isVisible: () => true };

function segment(rows, from, to) {
  const dc = Math.sign(to.col - from.col);
  const dr = Math.sign(to.row - from.row);
  assert.ok(dc === 0 || dr === 0);
  for (let col = from.col, row = from.row; ; col += dc, row += dr) {
    rows[row][col] = ".";
    if (col === to.col && row === to.row) break;
  }
}

function arena({ barrier = gate, closed = false, battle = false, overwrites = [] } = {}) {
  const rows = Array.from({ length: 32 }, () => Array(28).fill("#"));
  const lane = [cell(5, 17), cell(15, 17), cell(15, 12), cell(12, 12), goal];
  for (const [index, next] of lane.slice(1).entries()) segment(rows, lane[index], next);
  segment(rows, entry, cell(8, 12));
  segment(rows, mergeSites[0], cell(12, 12));
  rows[spawn.row][spawn.col] = "S";
  rows[goal.row][goal.col] = "G";
  rows[16][9] = "+";
  if (closed) rows[14][15] = "#";
  for (const [tile, marker] of overwrites) rows[tile.row][tile.col] = marker;
  const map = new TerrainMap(rows.map((row) => row.join("")), {
    autoMerge: false, buildingBalance: "w25", towerEvolution: true,
  });
  for (const tile of mergeSites) assert.ok(map.placeBuilding("tower", tile));
  const wall = barrier ? map.placeBuilding("wall", barrier) : undefined;
  const ready = map.previewReadySynthesis(mergeSites.at(-1));
  assert.ok(ready);
  const events = [];
  const defense = new DefenseSimulation(map, entry, goal, (event) => events.push(event), battle);
  return { map, ready, defense, wall, events };
}

function realTrace(navigation) {
  let tile = entry;
  for (let steps = 0; steps < 100; steps += 1) {
    const result = navigation.next(tile, goal);
    if (result.kind !== "move") return { ...result, steps };
    tile = result.cell;
  }
  assert.fail("The reference approach must end at a real boundary");
}

function fog(hidden, revision = 1, isVisible = () => false) {
  const unknown = new Set(hidden.map(key));
  return { revision, isKnown: (tile) => !unknown.has(key(tile)), isVisible };
}

test("ROUTE-PREVIEW: historical 17→11→17 approach reaches the identical W25 wall", () => {
  const { map, ready, defense, wall } = arena();
  const live = new EnemyNavigation(map);
  const baseline = realTrace(live);
  assert.deepEqual(baseline, { kind: "wall", cell: gate, wallId: wall.id, steps: 17 });

  const preview = defense.previewMergeRoute(ready.released, spawn, known);
  assert.deepEqual(preview, { kind: "shorter", before: 17, after: 11, representative: "entry", boundary: "wall" });
  assert.equal(defense.searchCount, 0, "Forecasts may only touch their own navigation fields");
  assert.equal(map.executeBuildingSynthesis(ready, spawn).success, true);
  assert.deepEqual(realTrace(live), { ...baseline, steps: preview.after });
  assert.ok(live.searchCount >= 4, "Actual merge invalidates the field before the next actual query");
  for (const tile of ready.released) assert.ok(map.placeBuilding("wall", tile));
  assert.deepEqual(realTrace(live), baseline);
  assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, known),
    { kind: "shorter", before: 17, after: 11, representative: "entry", boundary: "wall" });
});

test("ROUTE-PREVIEW: cache reuses stable source, invalidates topology, and force rereads without replaying combat", () => {
  const { map, ready, defense } = arena();
  const first = defense.previewMergeRoute(ready.released, spawn, known);
  for (let frame = 0; frame < 100; frame += 1) assert.equal(defense.previewMergeRoute(ready.released, spawn, known), first);
  const cached = defense.mergeRouteMetrics;
  assert.equal(cached.computations, 1);
  assert.equal(cached.cacheHits, 100);
  assert.equal(cached.searches, 4);
  assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, known, true), first);
  assert.equal(defense.mergeRouteMetrics.computations, 2);
  assert.equal(defense.mergeRouteMetrics.searches, cached.searches, "Confirmation rechecks the same topology without repeating field searches");

  assert.equal(map.applyDigDamage(entry, cell(9, 17), 5).effective, false, "Already open tiles do not change the topology");
  const revision = map.revision;
  assert.ok(map.applyDigDamage(cell(8, 16), cell(9, 16), 5).effective);
  assert.ok(map.revision > revision);
  assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, known), first);
  assert.equal(defense.mergeRouteMetrics.computations, 3);
  assert.ok(defense.mergeRouteMetrics.searches > cached.searches);
  assert.equal(defense.elapsedMs, 0);
  assert.equal(defense.searchCount, 0);
});

test("ROUTE-PREVIEW: no open approach becomes reachable, and a wall can be bypassed", () => {
  for (const options of [{ barrier: null, closed: true }, { barrier: cell(15, 14) }]) {
    const { map, ready, defense } = arena(options);
    const live = new EnemyNavigation(map);
    assert.ok(["wall", "unreachable"].includes(realTrace(live).kind));
    const risk = defense.previewMergeRoute(ready.released, spawn, known);
    assert.deepEqual(risk, { kind: "opened", after: 12, representative: "entry" });
    assert.equal(map.executeBuildingSynthesis(ready, spawn).success, true);
    assert.deepEqual(realTrace(live), { kind: "arrived", steps: risk.after });
  }
});

test("ROUTE-PREVIEW: a known prospective corridor does not disclose unknown paths or blockers", () => {
  const hiddenLane = cell(15, 14);
  const actualPath = arena();
  const hiddenRock = arena({ overwrites: [[hiddenLane, "#"]] });
  for (const { defense, ready } of [actualPath, hiddenRock]) {
    // The two worlds differ only at an unexplored tile. The view model exposes neither world.
    for (const visibleFog of [fog([hiddenLane]), fog([goal], 2), fog([ready.released[0]], 3)]) {
      assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, visibleFog), { kind: "unknown" });
    }
  }

  const irrelevant = fog([cell(27, 31)], 4);
  assert.deepEqual(actualPath.defense.previewMergeRoute(actualPath.ready.released, spawn, irrelevant),
    { kind: "shorter", before: 17, after: 11, representative: "entry", boundary: "wall" });
});

test("ROUTE-PREVIEW: never subtract target changes or change the live in-flight move, HP, or reward state", () => {
  const { map, ready, defense, events } = arena({ battle: true });
  const economy = new ExpeditionEconomy(map, 515, undefined, "challenge");
  assert.equal(defense.spawn(1, 1, { hp: 14, contactDamage: 1 }), 1);
  defense.step(30, spawn);
  const [enemy] = defense.enemies;
  const originalMove = enemy.move;
  const beforeTarget = events.find(({ type }) => type === "targetSelected").target;
  assert.ok(ready.released.some((tile) => key(tile) === key(beforeTarget.cell)), "The live attacker chose a soon-consumed building");
  assert.ok(originalMove && originalMove.elapsedMs > 0);
  const before = {
    buildings: [...map.getBuildings()], revision: map.revision, enemy: structuredClone(enemy),
    counts: defense.counters, events: events.slice(), elapsed: defense.elapsedMs, searches: defense.searchCount,
    money: economy.balance, cards: economy.cards, totals: economy.totals,
  };

  const random = Math.random;
  Math.random = () => { throw new Error("A forecast consumed random state"); };
  try {
    assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, known, true),
      { kind: "target-changed", representative: "enemy" });
  } finally {
    Math.random = random;
  }
  assert.deepEqual({
    buildings: [...map.getBuildings()], revision: map.revision, enemy, counts: defense.counters, events,
    elapsed: defense.elapsedMs, searches: defense.searchCount, money: economy.balance, cards: economy.cards, totals: economy.totals,
  }, before);
  assert.equal(enemy.move, originalMove);
  for (const [index, building] of [...map.getBuildings()].entries()) assert.equal(building, before.buildings[index]);

  assert.equal(map.executeBuildingSynthesis(ready, spawn).success, true);
  let eventually;
  for (let tick = 0; tick < 15; tick += 1) {
    defense.step(20, spawn);
    eventually = events.filter(({ type }) => type === "targetSelected").at(-1)?.target;
    if (eventually && eventually.buildingId !== beforeTarget.buildingId) break;
  }
  assert.ok(eventually);
  assert.notEqual(eventually.buildingId, beforeTarget.buildingId);
});

test("ROUTE-PREVIEW: a hidden enemy cannot alter the representative entry result", () => {
  const { defense, ready } = arena({ battle: true });
  const information = fog([], 1);
  const first = defense.previewMergeRoute(ready.released, spawn, information);
  assert.equal(first.representative, "entry");
  defense.spawn(1, 1, { hp: 14, contactDamage: 1 });
  defense.step(70, spawn);
  assert.equal(defense.previewMergeRoute(ready.released, spawn, information), first);
});

test("ROUTE-PREVIEW: different first walls have no directly comparable approach length", () => {
  const wayIn = cell(15, 14);
  const { map, ready, defense, wall } = arena({ barrier: wayIn });
  const inner = map.placeBuilding("wall", gate);
  assert.ok(inner);
  const live = new EnemyNavigation(map);
  assert.deepEqual(realTrace(live), { kind: "wall", cell: wayIn, wallId: wall.id, steps: 9 });
  assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, known), { kind: "unknown" });
  assert.equal(map.executeBuildingSynthesis(ready, spawn).success, true);
  assert.deepEqual(realTrace(live), { kind: "wall", cell: gate, wallId: inner.id, steps: 11 });
});

test("ROUTE-PREVIEW: discovery invalidates the fog proof and reuses both actual topology fields", () => {
  const { defense, ready } = arena();
  const before = defense.previewMergeRoute(ready.released, spawn, known);
  const metrics = defense.mergeRouteMetrics;
  const versionOnly = { ...known, revision: 2 };
  assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, versionOnly), before);
  assert.equal(defense.mergeRouteMetrics.computations, metrics.computations + 1);
  assert.equal(defense.mergeRouteMetrics.searches, metrics.searches);
});


test("ROUTE-PREVIEW: a wall approach cannot reveal a hidden path after the first wall", () => {
  const barrier = cell(15, 14);
  const unseenBeyondWall = cell(15, 13);
  for (const [terrain, actual] of [[".", "wall"], ["#", "unreachable"]]) {
    const { map, ready, defense } = arena({ barrier, overwrites: [[unseenBeyondWall, terrain]] });
    assert.equal(realTrace(new EnemyNavigation(map)).kind, actual);
    assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, fog([unseenBeyondWall])),
      { kind: "unknown" });

    assert.equal(defense.spawn(1, 1, { hp: 14, contactDamage: 1 }), 1);
    defense.step(20, spawn);
    const visibleSource = fog([unseenBeyondWall], 2, (tile) => key(tile) !== key(unseenBeyondWall));
    assert.deepEqual(defense.previewMergeRoute(ready.released, spawn, visibleSource), { kind: "unknown" });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";
import { isWithinSynthesisRange } from "../src/buildings.ts";
import { DEFENSE_CONFIG, DefenseSimulation } from "../src/defense-simulation.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const sites = [5, 6, 7, 8].map((col) => cell(col, 7));
const stance = cell(5, 8);

function manualMap(layout = ["S" + ".".repeat(23), ...Array(31).fill(".".repeat(24))]) {
  return new TerrainMap(layout, {
    autoMerge: false, buildingBalance: "w25", towerEvolution: true,
  });
}

function place(map, kind, positions = sites) {
  return positions.map((position) => {
    const building = map.placeBuilding(kind, position);
    assert.ok(building);
    assert.equal(building.level, 1);
    return building;
  });
}

test("manual readiness leaves all four placed towers active and inherits the incumbent shot deadline", () => {
  const map = manualMap();
  const [oldest, ...later] = place(map, "tower");
  const revision = map.revision;
  const ready = map.previewReadySynthesis(sites[3]);
  assert.ok(ready);
  assert.equal(ready.state, "MERGE_READY");
  assert.deepEqual(ready.participants, [oldest, ...later]);
  assert.equal(ready.retained, oldest.cell);
  assert.deepEqual(ready.released, sites.slice(1));
  assert.deepEqual(ready.evolution, { kind: "piercing", axis: "horizontal" });
  assert.equal(ready.upgraded.level, 2);
  assert.equal(map.revision, revision);
  assert.ok(sites.every((site) => !map.isWalkable(site)));
  assert.strictEqual(map.previewReadySynthesis(sites[1]), ready, "repeat hover must use the cached ready plan");

  const entry = cell(10, 7);
  const economy = new ExpeditionEconomy(map, 515, cell(2, 2), "challenge", { killDecay: true });
  const shots = [];
  const kills = [];
  const battle = new DefenseSimulation(map, entry, entry, (event, metadata) => {
    if (event.type === "towerShot") shots.push({ at: metadata.timeMs, damage: event.damage, tower: event.towerId });
    if (event.type === "towerKill") {
      kills.push(event);
      economy.handleEvent(event, metadata.waveId);
    }
  }, false, { towerTuning: PLAYTEST_TOWER_TUNING });
  assert.equal(battle.spawn(1, 1, { hp: 14, contactDamage: 1 }), 1);
  battle.step(1);
  assert.deepEqual(shots, [oldest, ...later].map(({ id }) => ({ at: 1, damage: 2, tower: id })));
  const balance = economy.balance;
  const stock = economy.cards;

  const result = map.executeBuildingSynthesis(ready, stance);
  assert.equal(result.success, true);
  const { building, released } = result;
  assert.equal(building.id, oldest.id);
  assert.equal(building.buildOrder, oldest.buildOrder);
  assert.strictEqual(building.cell, oldest.cell);
  assert.deepEqual([building.level, building.hp, building.maxHp], [2, 1, 1]);
  assert.equal(economy.balance, balance);
  assert.deepEqual(economy.cards, stock);
  assert.deepEqual(released, sites.slice(1));
  assert.ok(released.every((site) => map.isWalkable(site)));
  assert.equal(map.revision, revision + 1);
  assert.equal(map.previewReadySynthesis(oldest.cell), undefined);
  assert.deepEqual(map.executeBuildingSynthesis(ready, stance), { success: false, reason: "invalid" });
  battle.step(349);
  assert.equal(shots.length, 4);
  battle.step(1);
  assert.deepEqual(shots.at(-1), { at: 351, damage: 5, tower: oldest.id });
  battle.step(749);
  assert.equal(shots.length, 5);
  battle.step(1);
  assert.deepEqual(shots.at(-1), { at: 1101, damage: 1, tower: oldest.id });
  assert.equal(kills.length, 1);
  assert.equal(economy.totals.killIncome, 2);
  assert.equal(economy.handleEvent(kills[0]), 0);
});

test("four economy buildings earn independently until merging and the oldest carries its production time", () => {
  const map = manualMap();
  const economy = new ExpeditionEconomy(map, 1091, cell(2, 2), "challenge");
  const [oldest] = place(map, "economy");
  const ready = map.previewReadySynthesis(sites[2]);
  economy.advance(4_000);
  assert.equal(economy.totals.productionIncome, 4);
  assert.equal([...map.getBuildings()].length, 4);
  economy.advance(3_999);
  const result = map.executeBuildingSynthesis(ready, stance);
  assert.equal(result.success, true);
  assert.equal(result.building.id, oldest.id);
  assert.strictEqual(result.building.cell, oldest.cell);
  assert.deepEqual([result.building.level, result.building.hp], [2, 1]);
  assert.equal(economy.totals.productionIncome, 4);
  economy.advance(1);
  assert.equal(economy.totals.productionIncome, 6);
  economy.advance(4_000);
  assert.equal(economy.totals.productionIncome, 8);
});

test("unmerged walls each stop enemies and stale HP snapshots are revalidated against the live incumbent", () => {
  const room = "#".repeat(5) + "...." + "#".repeat(15);
  const layout = ["S" + "#".repeat(23), ...Array(31).fill("#".repeat(24))];
  for (const row of [6, 7, 8]) layout[row] = room;
  const map = manualMap(layout);
  const walls = place(map, "wall");
  const ready = map.previewReadySynthesis(sites[3]);
  const revision = map.revision;
  assert.deepEqual([ready.upgraded.hp, ready.upgraded.maxHp], [50, 50]);
  for (const wall of walls) {
    const approach = cell(wall.cell.col, wall.cell.row + 1);
    const destination = cell(wall.cell.col, wall.cell.row - 1);
    const battle = new DefenseSimulation(map, approach, destination);
    assert.equal(battle.spawn(1, 2), 1);
    battle.step(DEFENSE_CONFIG.travelMs * 2);
    assert.equal(battle.counters.wallImpacts, 1);
    assert.equal(battle.counters.towerKills, 0);
    assert.equal(map.isWalkable(wall.cell), false);
    assert.deepEqual([map.getBuilding(wall.cell)?.level, map.getBuilding(wall.cell)?.hp], [1, 23]);
  }
  assert.equal(map.revision, revision, "partial damage must not invalidate terrain navigation");
  const updated = map.previewReadySynthesis(sites[0]);
  assert.equal(updated.key, ready.key);
  assert.equal(updated.upgraded.hp, 48);
  const result = map.executeBuildingSynthesis(ready, stance);
  assert.equal(result.success, true);
  assert.deepEqual([result.building.id, result.building.hp, result.building.maxHp], [walls[0].id, 48, 50]);
});

test("multiple candidates stay canonical across hover order and only the highlighted participants count for range", () => {
  const map = manualMap();
  const all = [...sites, cell(9, 7)];
  const buildings = place(map, "wall", all);
  const ready = map.previewReadySynthesis(all[4]);
  for (const site of all) assert.strictEqual(map.previewReadySynthesis(site), ready);
  assert.deepEqual(ready.participants.map(({ id }) => id), buildings.slice(0, 4).map(({ id }) => id));
  const far = cell(10, 7);
  assert.equal(isWithinSynthesisRange(ready, far), false);
  const revision = map.revision;
  assert.deepEqual(map.executeBuildingSynthesis(ready, far), { success: false, reason: "out-of-range" });
  assert.equal(map.revision, revision);
  const corner = cell(9, 8);
  assert.equal(isWithinSynthesisRange(ready, corner), true);
  assert.equal(map.executeBuildingSynthesis(ready, corner).success, true);
  assert.deepEqual([...map.getBuildings()].map(({ id, level }) => [id, level]), [[buildings[0].id, 2], [buildings[4].id, 1]]);
  assert.equal(map.previewReadySynthesis(all[4]), undefined);
});

test("a consumed or destroyed participant invalidates a selected plan even after replacement or reset", () => {
  const map = manualMap();
  const buildings = place(map, "tower");
  const ready = map.previewReadySynthesis(sites[3]);
  assert.equal(map.damageBuilding(sites[1], buildings[1].id, 1)?.destroyed, true);
  const revision = map.revision;
  assert.equal(map.previewReadySynthesis(sites[0]), undefined);
  assert.deepEqual(map.executeBuildingSynthesis(ready, stance), { success: false, reason: "invalid" });
  assert.equal(map.revision, revision);
  assert.deepEqual([...map.getBuildings()], [buildings[0], buildings[2], buildings[3]]);
  place(map, "tower", [sites[1]]);
  const replacement = map.previewReadySynthesis(sites[0]);
  assert.notEqual(replacement.key, ready.key);
  assert.deepEqual(map.executeBuildingSynthesis(ready, stance), { success: false, reason: "invalid" });
  map.reset();
  assert.equal(map.previewReadySynthesis(sites[0]), undefined);
  place(map, "tower");
  assert.deepEqual(map.executeBuildingSynthesis(replacement, stance), { success: false, reason: "invalid" });

  const separateRound = manualMap();
  place(separateRound, "tower");
  assert.equal(separateRound.previewReadySynthesis(sites[0]).key, ready.key, "fresh worlds may reuse numeric IDs");
  assert.deepEqual(separateRound.executeBuildingSynthesis(ready, stance), { success: false, reason: "invalid" });
});

test("technology facilities never enter manual synthesis readiness", () => {
  const map = manualMap();
  const buildings = place(map, "technology");
  for (const { cell: position } of buildings) assert.equal(map.previewReadySynthesis(position), undefined);
  assert.equal([...map.getBuildings()].length, 4);
});

test("vertical and non-linear manual tower groups retain the same evolution preview and actual result", () => {
  for (const [positions, evolution] of [
    [[cell(5, 7), cell(5, 6), cell(5, 5), cell(5, 4)], { kind: "piercing", axis: "vertical" }],
    [[cell(5, 7), cell(6, 7), cell(5, 6), cell(6, 6)], { kind: "burst" }],
  ]) {
    const map = manualMap();
    const [oldest] = place(map, "tower", positions);
    const ready = map.previewReadySynthesis(positions[3]);
    assert.deepEqual(ready.evolution, evolution);
    const result = map.executeBuildingSynthesis(ready, stance);
    assert.equal(result.success, true);
    assert.strictEqual(result.building.cell, oldest.cell);
    assert.deepEqual(result.building.evolution, evolution);
    assert.deepEqual(result.released, positions.slice(1));
  }
});

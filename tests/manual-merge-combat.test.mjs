import assert from "node:assert/strict";
import test from "node:test";
import { PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";
import { DEFENSE_CONFIG, DefenseSimulation, enemyWorldPosition } from "../src/defense-simulation.ts";
import { EnemyNavigation } from "../src/enemy-navigation.ts";
import { DIFFICULTY_PROFILES } from "../src/expedition-difficulty.ts";
import { ExpeditionEconomy } from "../src/expedition-economy.ts";
import { MIDGAME_EXPERIMENTS } from "../src/midgame-experiments.ts";
import { cellCenter, Player, TILE_SIZE, worldToCell } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";
import { runMergeTiming } from "./merge-timing.mjs";

const cell = (col, row) => ({ col, row });
const one = DIFFICULTY_PROFILES.challenge.stages[0];
const two = DIFFICULTY_PROFILES.challenge.stages[1];
const defaultSpawn = cell(8, 9);
const horizontal = [cell(8, 8), cell(7, 8), cell(6, 8), cell(5, 8)];
const bent = [cell(8, 8), cell(7, 8), cell(7, 7), cell(6, 7)];

function fixture(rows, spawn = defaultSpawn) {
  const layout = Array.from({ length: 32 }, (_, row) => Array(24).fill(rows ? "#" : "."));
  for (const [row, from, through] of rows ?? []) {
    for (let col = from; col <= through; col += 1) layout[row][col] = ".";
  }
  layout[spawn.row][spawn.col] = "S";
  return new TerrainMap(layout.map((row) => row.join("")), { autoMerge: false, buildingBalance: "w25", towerEvolution: true });
}

function placeReady(map, kind, sites) {
  for (const position of sites) assert.equal(map.placeBuilding(kind, position)?.level, 1);
  const ready = map.previewReadySynthesis(sites[0]);
  assert.equal(ready?.state, "MERGE_READY");
  assert.equal(ready.participants.length, 4);
  return ready;
}

function startBattle(map, from, to, { expedition = true, economy } = {}) {
  const events = [];
  const battle = new DefenseSimulation(map, from, to, (event, metadata) => {
    const reward = economy?.handleEvent(event, metadata.waveId);
    events.push({ ...event, timeMs: metadata.timeMs, wave: metadata.waveId, reward });
  }, expedition, { towerTuning: PLAYTEST_TOWER_TUNING });
  return { battle, events };
}

function advanceUntil(battle, condition, player) {
  for (let elapsed = 0; elapsed <= 3_000; elapsed += 10) {
    if (condition()) return;
    battle.step(10, player);
  }
  assert.fail("the actual battle must reach the observed trigger within three seconds");
}

test("matched legal timing runs distinguish early merge, live approach, delayed preparation, and keeping the four towers", () => {
  const { runs } = runMergeTiming();
  assert.equal(runs.length, 40);
  assert.equal(new Set(runs.map(({ shape, policy, scenario, repair }) => `${shape}/${policy}/${scenario}/${repair}`)).size, runs.length);
  for (const run of runs) {
    assert.equal(run.economy.technologySpend, 10);
    assert.equal(run.economy.cardSpend, 33);
    assert.ok(run.spawned > 0);
    if (run.policy === "hold") {
      assert.equal(run.merge, null);
      assert.equal(run.readyIds.length, 4);
      assert.equal(run.rebuild, null);
    }
    if (run.policy === "control") {
      const early = runs.find((result) => result.shape === run.shape && result.scenario === run.scenario
        && result.repair === run.repair && result.policy === "manual-early");
      assert.equal(early.merge.atMs, run.merge.atMs);
      assert.deepEqual(early.combat, run.combat, "the immediate manual click and historical fourth auto-placement happen at the same simulation time");
      assert.equal(early.playerHp, run.playerHp);
    }
  }
  const movingMerges = runs.filter(({ policy, merge }) => policy === "manual-late" && merge?.status === "merged");
  assert.deepEqual(new Set(movingMerges.map(({ shape }) => shape)), new Set(["piercing", "burst"]));
  for (const { merge } of movingMerges) {
    assert.ok(merge.active.some(({ move }) => move && move.elapsedMs > 0 && move.elapsedMs < move.durationMs));
    assert.ok(merge.combatBefore.fireGroups > 0);
    assert.equal(merge.freeCandidateCells, 3);
  }
  assert.ok(runs.some(({ rebuild }) => rebuild?.placements.length === 3), "the player must be able to spend all three actual reserve cards in a tested battle");
});

test("an in-flight unit finishes its legal segment then switches to the route opened by a manual merge", () => {
  const spawn = cell(7, 11);
  const from = cell(2, 12);
  const goal = cell(12, 12);
  const junction = cell(5, 12);
  const map = fixture([[11, 6, 7], [12, 2, 12], [13, 5, 5], [13, 11, 11], [14, 5, 5], [14, 11, 11], [15, 5, 11]], spawn);
  const ready = placeReady(map, "wall", [cell(6, 11), cell(6, 12), cell(7, 12), cell(8, 12)]);
  assert.deepEqual(new EnemyNavigation(map).next(junction, goal), { kind: "move", cell: cell(5, 13) });
  const { battle } = startBattle(map, from, goal);
  assert.equal(battle.requestWave(1, { ...one, count: 1 }), 1);
  battle.step(385);
  const [enemy] = battle.enemies;
  assert.deepEqual(enemy.cell, cell(4, 12));
  assert.deepEqual(enemy.move.to, junction);
  const oldMove = { ...enemy.move };
  const oldPosition = enemyWorldPosition(enemy);
  const oldSearches = battle.searchCount;
  const merge = map.executeBuildingSynthesis(ready, spawn);
  assert.equal(merge.success, true);
  assert.deepEqual(enemy.move, oldMove);
  assert.deepEqual(enemyWorldPosition(enemy), oldPosition);
  assert.equal(battle.searchCount, oldSearches);
  battle.step(64);
  assert.deepEqual(enemy.move.to, junction);
  assert.equal(battle.searchCount, oldSearches);
  battle.step(2);
  assert.deepEqual(enemy.cell, junction);
  const firstOpened = cell(6, 12);
  assert.deepEqual(enemy.move.to, firstOpened);
  assert.ok(battle.searchCount > oldSearches);
  assert.deepEqual(new EnemyNavigation(map).next(junction, goal), { kind: "move", cell: firstOpened });
  for (let elapsed = 0; elapsed < 800; elapsed += 20) {
    const before = enemyWorldPosition(enemy);
    battle.step(20);
    const after = enemyWorldPosition(enemy);
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) <= 20 * TILE_SIZE / DEFENSE_CONFIG.travelMs + 1e-9);
    assert.ok(map.isWalkable(worldToCell(after.x, after.y)));
  }
  assert.equal(battle.spawnCounts.removed, 0);
});

test("two real gate contacts straddle a manual W25 merge without resetting incumbent damage", () => {
  const spawn = cell(7, 11);
  const from = cell(2, 12);
  const goal = cell(13, 12);
  const map = fixture([[12, 2, 13]], spawn);
  const wallSites = [6, 7, 8, 9].map((col) => cell(col, 12));
  const ready = placeReady(map, "wall", wallSites);
  const oldWall = ready.participants[0];
  const player = new Player(spawn);
  const { battle, events } = startBattle(map, from, goal);
  assert.equal(battle.requestWave(2, { ...two, count: 2 }), 2);
  const impacts = () => events.filter(({ type }) => type === "wallImpact");
  advanceUntil(battle, () => impacts().length === 1 && [...battle.enemies].some(({ move }) => move?.to.col === 5
    && move?.to.row === 12 && move.elapsedMs >= 100), player);
  assert.equal(impacts()[0].hp, 25 - two.wallDamage);
  const before = [...battle.enemies].map(enemyWorldPosition);
  const merge = map.executeBuildingSynthesis(ready, player.cell);
  assert.equal(merge.success, true);
  assert.equal(merge.building.id, oldWall.id);
  assert.equal(merge.building.cell, oldWall.cell);
  assert.equal(merge.building.maxHp, 50);
  assert.equal(merge.building.hp, 50 - two.wallDamage);
  assert.deepEqual([...battle.enemies].map(enemyWorldPosition), before);
  advanceUntil(battle, () => impacts().length === 2, player);
  assert.deepEqual(impacts().map(({ wallId, damage, hp }) => [wallId, damage, hp]), [
    [oldWall.id, two.wallDamage, 25 - two.wallDamage], [oldWall.id, two.wallDamage, 50 - 2 * two.wallDamage],
  ]);
  assert.equal(battle.spawnCounts.removed, 2);
});

test("a ready wall group can be kept and each W25 wall can independently take real hostile damage", () => {
  const wallSites = [6, 7, 8, 9].map((col) => cell(col, 12));
  const lanes = [[9, 6, 9], [10, 6, 9], [11, 6, 9], [12, 6, 9], [13, 6, 9], [14, 6, 9], [15, 6, 9]];
  const map = fixture(lanes, cell(5, 12));
  const ready = placeReady(map, "wall", wallSites);
  for (const wall of ready.participants) {
    const { battle, events } = startBattle(map, cell(wall.cell.col, 10), cell(wall.cell.col, 15));
    assert.equal(battle.requestWave(1, { ...one, count: 1 }), 1);
    advanceUntil(battle, () => events.some(({ type }) => type === "wallImpact"));
    assert.equal(events.find(({ type }) => type === "wallImpact").wallId, wall.id);
    assert.equal(map.getBuilding(wall.cell).hp, 24);
  }
  const stillReady = map.previewReadySynthesis(wallSites[0]);
  assert.equal(stillReady.key, ready.key);
  assert.ok(stillReady.participants.every(({ level, hp }) => level === 1 && hp === 24));
});

test("four ready producers each pay until a manual merge and the Lv.2 incumbent retains its unspent timer", () => {
  const map = fixture();
  const economy = new ExpeditionEconomy(map, 12, cell(2, 2), "challenge", MIDGAME_EXPERIMENTS.combined.economy);
  const ready = placeReady(map, "economy", horizontal);
  const oldProducer = ready.participants[0];
  economy.advance(4_000);
  assert.equal(economy.totals.productionIncome, 4);
  economy.advance(3_999);
  assert.equal(economy.totals.productionIncome, 4);
  const merge = map.executeBuildingSynthesis(ready, defaultSpawn);
  assert.equal(merge.success, true);
  assert.equal(merge.building.cell, oldProducer.cell);
  assert.equal(merge.building.level, 2);
  assert.equal(merge.building.hp, 1);
  assert.equal(economy.totals.productionIncome, 4);
  economy.advance(1);
  assert.equal(economy.totals.productionIncome, 6);
  economy.advance(4_000);
  assert.equal(economy.totals.productionIncome, 8);
});

test("all four ready Lv.1 towers fire, manual upgrade retains the oldest tower's live cooldown, and coins remain unique", () => {
  const from = cell(10, 8);
  const map = fixture();
  const economy = new ExpeditionEconomy(map, 12, cell(2, 2), "challenge", MIDGAME_EXPERIMENTS.combined.economy);
  const ready = placeReady(map, "tower", horizontal);
  const { battle, events } = startBattle(map, from, from, { expedition: false, economy });
  assert.equal(battle.requestWave(1, { ...two, count: 2 }, { intervalMs: 200, armor: { hp: 14, slots: [0] } }), 2);
  battle.step(1);
  const shots = () => events.filter(({ type }) => type === "towerShot");
  assert.equal(new Set(shots().map(({ towerId }) => towerId)).size, 4);
  assert.ok(ready.participants.every(({ level }) => level === 1));
  const oldTower = ready.participants[0];
  const merge = map.executeBuildingSynthesis(ready, defaultSpawn);
  assert.equal(merge.success, true);
  assert.equal(merge.building.id, oldTower.id);
  assert.equal(merge.building.cell, oldTower.cell);
  assert.equal(merge.building.hp, 1);
  assert.deepEqual(merge.building.evolution, { kind: "piercing", axis: "horizontal" });
  battle.step(349);
  assert.equal(shots().length, 4, "the merge must not skip the unexpired Lv.1 shot cooldown");
  battle.step(1);
  assert.equal(shots().at(-1).timeMs, 351);
  assert.equal(shots().at(-1).damage, 5);
  battle.step(749);
  assert.equal(events.filter(({ type }) => type === "towerKill").length, 0);
  battle.step(1);
  const kills = events.filter(({ type }) => type === "towerKill");
  assert.equal(kills.length, 1);
  assert.equal(kills[0].towerId, oldTower.id);
  assert.equal(kills[0].reward, 2);
  assert.equal(economy.handleEvent(kills[0], kills[0].wave), 0);
  assert.equal(economy.totals.killIncome, 2);
});

test("enemies can destroy one-HP manual piercing and burst upgrades and continue instead of being consumed", () => {
  for (const sites of [horizontal, bent]) {
    const map = fixture();
    const ready = placeReady(map, "tower", sites);
    const { battle, events } = startBattle(map, cell(9, 8), cell(9, 5));
    assert.equal(battle.requestWave(2, { ...two, count: 1 }, { intervalMs: 200, armor: { hp: 14, slots: [0] } }), 1);
    const merge = map.executeBuildingSynthesis(ready, defaultSpawn);
    assert.equal(merge.success, true);
    assert.equal(merge.building.hp, merge.building.maxHp);
    assert.equal(merge.building.hp, 1);
    advanceUntil(battle, () => events.some(({ type }) => type === "buildingHit"));
    const hit = events.find(({ type }) => type === "buildingHit");
    assert.equal(hit.buildingId, merge.building.id);
    assert.equal(hit.destroyed, true);
    assert.equal(map.getBuilding(horizontal[0]), undefined);
    assert.equal(map.isWalkable(horizontal[0]), true);
    assert.equal(battle.spawnCounts.removed, 0);
    advanceUntil(battle, () => [...battle.enemies][0].cell.row < 8);
    assert.equal(events.filter(({ type }) => type === "wallImpact").length, 0);
  }
});

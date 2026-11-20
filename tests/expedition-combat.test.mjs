import assert from "node:assert/strict";
import test from "node:test";
import { DEFENSE_CONFIG, DefenseSimulation } from "../src/defense-simulation.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy, TECHNOLOGY_PROTOTYPE } from "../src/expedition-economy.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const entry = cell(5, 5);
const fallback = cell(20, 20);

function makeMap({ rocks = [], corridor, spawn = entry } = {}) {
  const layout = Array.from({ length: 32 }, (_, row) => Array.from({ length: 24 }, (_, col) => {
    if (col === spawn.col && row === spawn.row) return "S";
    if (col === 0 || col === 23 || row === 0 || row === 31) return "#";
    if (rocks.some((point) => point.col === col && point.row === row)) return "#";
    if (corridor && !corridor.some((point) => point.col === col && point.row === row)) return "#";
    return ".";
  }).join(""));
  return new TerrainMap(layout);
}

function runCombat(map, onEvent, target = fallback, expedition = true) {
  const events = [];
  const simulation = new DefenseSimulation(map, map.spawn, target, (event) => {
    events.push(event);
    onEvent?.(event, simulation);
  }, expedition);
  return { simulation, events };
}

test("player sight and an open approach give priority to a diagonal player over an adjacent structure", () => {
  const map = makeMap();
  const structure = map.placeBuilding("economy", cell(4, 5), 6);
  assert.ok(structure);
  const { simulation, events } = runCombat(map);
  assert.equal(simulation.spawn(1, 1, { hp: 4, contactDamage: 3 }), 1);
  const player = cell(7, 7);
  simulation.step(6 * DEFENSE_CONFIG.travelMs, player);
  assert.deepEqual(events, [
    { type: "targetSelected", enemyId: 1, target: { kind: "player", cell: player } },
    { type: "playerHit", enemyId: 1, damage: 3 },
  ]);
  assert.equal(map.getBuilding(structure.cell), structure);
  assert.deepEqual([...simulation.enemies], []);
  assert.equal(simulation.counters.towerKills, 0);
  simulation.step(2_000, player);
  assert.equal(events.filter((event) => event.type === "playerHit").length, 1);
});

test("a corner wall blocks player sight even when an open approach is available", () => {
  const map = makeMap({ rocks: [cell(6, 5)] });
  const structure = map.placeBuilding("economy", cell(4, 5), 6);
  assert.ok(structure && map.isWalkable(cell(5, 6)) && map.isWalkable(cell(6, 6)));
  const { simulation, events } = runCombat(map);
  simulation.spawn(1, 1, { hp: 4, contactDamage: 2 });
  const player = cell(6, 6);
  simulation.step(43, player);
  assert.equal(map.getBuilding(structure.cell), structure, "Adjacent centers are too far apart for contact");
  simulation.step(1, player);
  assert.deepEqual(events, [
    { type: "targetSelected", enemyId: 1, target: { kind: "building", cell: structure.cell, buildingId: structure.id } },
    { type: "buildingHit", enemyId: 1, buildingId: structure.id, buildingKind: "economy",
      cell: structure.cell, damage: 2, hp: 4, destroyed: false },
  ]);
  assert.equal(map.getBuilding(structure.cell).hp, 4);
  simulation.step(2_000, player);
  assert.equal(map.getBuilding(structure.cell).hp, 4, "A continuous engagement applies only one hit");
  assert.equal(events.filter(({ type }) => type === "buildingHit").length, 1);
  assert.deepEqual([...simulation.enemies].map(({ id, hp }) => [id, hp]), [[1, 4]]);
  assert.equal(simulation.counters.towerKills, 0);
});

test("the nearest reachable building wins and an enclosed candidate never attracts enemies", () => {
  const buried = cell(8, 5);
  const map = makeMap({ rocks: [cell(7, 5), cell(9, 5), cell(8, 4), cell(8, 6)] });
  assert.ok(map.placeBuilding("economy", buried, 5));
  const distant = map.placeBuilding("economy", cell(5, 13), 5);
  const nearest = map.placeBuilding("economy", cell(5, 10), 5);
  assert.ok(distant && nearest);
  const { simulation, events } = runCombat(map);
  simulation.spawn(1, 1, { hp: 2, contactDamage: 5 });
  simulation.step(6 * DEFENSE_CONFIG.travelMs);
  const hit = events.find((event) => event.type === "buildingHit");
  assert.equal(hit?.buildingId, nearest.id);
  assert.equal(hit?.destroyed, true);
  assert.equal(map.getBuilding(buried).hp, 5);
  assert.equal(map.getBuilding(distant.cell), distant);
});

test("equally short building routes choose the earlier placed structure deterministically", () => {
  const map = makeMap();
  const first = map.placeBuilding("economy", cell(5, 7), 5);
  assert.ok(first && map.placeBuilding("economy", cell(7, 5), 5));
  const { simulation, events } = runCombat(map);
  simulation.spawn(1, 1);
  simulation.step(2 * DEFENSE_CONFIG.travelMs);
  assert.equal(events.find((event) => event.type === "buildingHit")?.buildingId, first.id);
});

test("a proven breach damages a wall once, then a survivor can attack the building behind it", () => {
  const map = makeMap({ corridor: Array.from({ length: 9 }, (_, index) => cell(5 + index, 5)) });
  const wall = map.placeBuilding("wall", cell(8, 5), 2);
  const protectedBuilding = map.placeBuilding("economy", cell(12, 5), 8);
  assert.ok(wall && protectedBuilding);
  const { simulation, events } = runCombat(map);
  simulation.spawn(2, 2, { hp: 4, contactDamage: 3 });
  simulation.step(9 * DEFENSE_CONFIG.travelMs);
  assert.deepEqual(events.filter((event) => event.type === "wallImpact"), [{
    type: "wallImpact", enemyId: 1, wallId: wall.id, damage: 2, hp: 0, destroyed: true,
  }]);
  assert.deepEqual(events.filter((event) => event.type === "buildingHit"), [{
    type: "buildingHit", enemyId: 2, buildingId: protectedBuilding.id, buildingKind: "economy",
    cell: protectedBuilding.cell, damage: 3, hp: 5, destroyed: false,
  }]);
  assert.deepEqual([...simulation.enemies].map(({ id }) => id), [2]);
  assert.equal(simulation.spawnCounts.removed, 1);
  assert.equal(simulation.counters.towerKills, 0);
});

test("normal card placement and map defaults give non-wall structures one HP", () => {
  const map = makeMap();
  const technology = cell(6, 5);
  const economy = new ExpeditionEconomy(map, 1, technology);
  const buildings = [
    map.getBuilding(technology),
    economy.placeCard("tower", cell(5, 7)),
    economy.placeCard("economy", cell(7, 5)),
    economy.placeCard("wall", cell(7, 7)),
  ];
  assert.deepEqual(buildings.map(({ kind, hp, maxHp }) => [kind, hp, maxHp]), [
    ["technology", 1, 1], ["tower", 1, 1], ["economy", 1, 1], ["wall", 50, 50],
  ]);

  const [oldest, ...mergeTiles] = [8, 9, 10, 11].map((col) => cell(col, 10));
  const first = map.placeBuilding("tower", oldest);
  for (const position of mergeTiles) map.placeBuilding("tower", position);
  const merged = map.getBuilding(oldest);
  assert.deepEqual([merged.id, merged.level, merged.hp, merged.maxHp], [first.id, 2, 1, 1]);
});

test("direct non-wall damage rejects stale IDs, preserves topology on partial hits and caps overkill", () => {
  const map = makeMap();
  const tower = map.placeBuilding("tower", cell(7, 5), 4);
  const wall = map.placeBuilding("wall", cell(8, 6), 2);
  assert.ok(tower && wall);
  const baseline = map.revision;
  assert.equal(map.damageBuilding(tower.cell, "stale", 1), undefined);
  assert.equal(map.damageBuilding(tower.cell, tower.id, 0), undefined);
  assert.equal(map.damageBuilding(wall.cell, wall.id, 1), undefined);
  assert.deepEqual(map.damageBuilding(tower.cell, tower.id, 1), { building: tower, damage: 1, hp: 3, destroyed: false });
  const damaged = map.getBuilding(tower.cell);
  assert.equal(damaged.cell, tower.cell, "Existing per-building timers keep their coordinate identity");
  assert.equal(map.revision, baseline);
  assert.deepEqual(map.damageBuilding(tower.cell, tower.id, 100), { building: damaged, damage: 3, hp: 0, destroyed: true });
  assert.equal(map.revision, baseline + 1);
  assert.equal(map.isWalkable(tower.cell), true);
  assert.equal(map.damageBuilding(tower.cell, tower.id, 1), undefined);
  assert.equal(map.revision, baseline + 1);
});

test("real enemy hits destroy the technology facility while same-round research survives a free rebuild", () => {
  const map = makeMap();
  const technology = cell(6, 5);
  const economy = new ExpeditionEconomy(map, 1, technology);
  economy.handleEvent({ type: "towerKill", enemyId: 41, towerId: "setup-tower" });
  assert.equal(economy.balance, TECHNOLOGY_PROTOTYPE.researchCost);
  assert.equal(economy.researchTool(), true);
  const original = map.getBuilding(technology);
  assert.equal(original.hp, ECONOMY_PROTOTYPE.buildingHp.technology);
  assert.equal(original.hp, 1);
  const revision = map.revision;
  const { simulation, events } = runCombat(map, (event) => economy.handleEvent(event));
  simulation.spawn(3, 1, { hp: 4, contactDamage: 8 });
  simulation.step(44);
  const impacts = events.filter((event) => event.type === "buildingHit");
  assert.deepEqual(impacts.map(({ enemyId, buildingId, hp, damage }) => [enemyId, buildingId, hp, damage]), [
    [1, original.id, 0, 1],
  ]);
  assert.deepEqual([...simulation.enemies].map((enemy) => enemy.id), [1, 2, 3]);
  assert.equal(simulation.spawnCounts.removed, 0);
  assert.equal(map.revision, revision + 1);
  assert.equal(economy.balance, 0, "Contacts do not award kills");
  assert.equal(economy.hasTechnology, false);
  assert.equal(economy.toolLevel, 2);
  assert.equal(economy.drawCard(), undefined);
  const rebuilt = economy.rebuildTechnology();
  assert.ok(rebuilt);
  assert.notEqual(rebuilt.id, original.id);
  assert.equal(rebuilt.hp, 1);
  assert.equal(economy.toolLevel, 2);
  assert.equal(economy.hasTechnology, true);
});

test("profiles captured in a pending wave retain distinct HP, wall damage and contact damage", () => {
  const { simulation } = runCombat(makeMap());
  const first = { hp: 5, contactDamage: 4 };
  assert.equal(simulation.requestSpawn(2, 2, first), 2);
  first.hp = 1;
  first.contactDamage = 99;
  assert.equal(simulation.requestSpawn(1, 6, { hp: 9, contactDamage: 2 }), 1);
  assert.equal(simulation.requestSpawn(1, 1, { hp: 0, contactDamage: 1 }), 0);
  assert.equal(simulation.spawn(1, 1, { hp: 3, contactDamage: 0 }), 0);
  simulation.step(DEFENSE_CONFIG.spawnIntervalMs);
  simulation.step(DEFENSE_CONFIG.spawnIntervalMs);
  assert.deepEqual([...simulation.enemies].map(({ hp, contactDamage, wallDamage }) => [hp, contactDamage, wallDamage]), [
    [5, 4, 2], [5, 4, 2], [9, 2, 6],
  ]);
});

test("terminal cleanup within the first hit cancels the live queue and all subsequent hits", () => {
  const { simulation, events } = runCombat(makeMap(), (event, simulation) => {
    if (event.type === "playerHit") simulation.clearBattle();
  });
  simulation.requestSpawn(4, 1);
  simulation.spawn(2, 1);
  assert.deepEqual(simulation.spawnCounts, { requested: 6, spawned: 3, pending: 3, removed: 0 });
  const player = cell(6, 5);
  simulation.step(1, player);
  simulation.step(8_000, player);
  assert.equal(events.filter((event) => event.type === "playerHit").length, 1);
  assert.deepEqual([...simulation.enemies], []);
  assert.deepEqual(simulation.spawnCounts, { requested: 6, spawned: 3, pending: 0, removed: 3 });
  simulation.reset();
  assert.deepEqual(simulation.spawnCounts, { requested: 0, spawned: 0, pending: 0, removed: 0 });
});

test("legacy defense still emits observation-only contact and applies no damage", () => {
  const map = makeMap();
  const site = cell(6, 5);
  const facility = map.placeBuilding("technology", site, 10);
  assert.ok(facility);
  const { simulation, events } = runCombat(map, undefined, site, false);
  assert.equal(simulation.spawn(1, 1), 1);
  simulation.step(1);
  assert.deepEqual(events, [
    { type: "targetSelected", enemyId: 1, target: { kind: "building", cell: site } },
    { type: "buildingContact", enemyId: 1, target: site },
  ]);
  assert.equal(map.getBuilding(site), facility);
  assert.equal([...simulation.enemies].length, 1);
});

test("an enemy at an unowned fallback resumes pursuit when a building becomes reachable", () => {
  const map = makeMap();
  const site = cell(6, 5);
  const { simulation, events } = runCombat(map, undefined, site);
  simulation.spawn(1, 1);
  simulation.step(DEFENSE_CONFIG.travelMs + 1);
  assert.ok(!events.some(({ type }) => type === "buildingContact" || type === "buildingHit"));
  assert.equal([...simulation.enemies].length, 1);
  assert.equal(simulation.counters.buildingContacts, 0);

  const [enemy] = simulation.enemies;
  const structure = map.placeBuilding("economy", cell(enemy.cell.col, enemy.cell.row + 1), 2);
  assert.ok(structure);
  simulation.step(DEFENSE_CONFIG.travelMs);
  assert.equal(events.find((event) => event.type === "buildingHit")?.buildingId, structure.id);
  assert.equal(map.getBuilding(structure.cell)?.hp, 1);
  assert.deepEqual([...simulation.enemies].map(({ id }) => id), [enemy.id]);
});

test("an enemy reselects the obscured player after destroying the last reachable building", () => {
  const player = cell(7, 5);
  const rock = cell(6, 5);
  const site = cell(4, 5);
  const secondSite = cell(5, 4);
  const detour = [cell(5, 6), cell(6, 6), cell(7, 6)];
  const map = makeMap({ corridor: [entry, player, site, secondSite, ...detour] });
  const first = map.placeBuilding("technology", site);
  const second = map.placeBuilding("economy", secondSite);
  const { simulation, events } = runCombat(map);
  simulation.spawn(1, 1);

  simulation.step(150, player);
  simulation.step(150, player);
  assert.deepEqual(events.filter(({ type }) => type === "buildingHit").map(({ buildingId }) => buildingId),
    [first.id, second.id], "Reachable buildings keep priority while the player is obscured");
  const [survivor] = simulation.enemies;
  assert.equal(simulation.spawnCounts.removed, 0);

  simulation.step(200, player);
  assert.deepEqual(survivor.cell, detour[0], "The survivor follows the open detour without seeing the player");
  assert.equal(simulation.counters.playerContacts, 0);
  simulation.step(600, player);
  assert.deepEqual(events.filter(({ type }) => type === "playerHit").map(({ enemyId }) => enemyId), [survivor.id]);
  assert.equal(map.getCell(rock).terrain, "rock");
});

test("an enemy cannot pursue a player who is genuinely cut off after a building is destroyed", () => {
  const player = cell(7, 5);
  const site = cell(4, 5);
  const map = makeMap({ corridor: [entry, player, site] });
  assert.ok(map.placeBuilding("technology", site));
  const { simulation, events } = runCombat(map);
  simulation.spawn(1, 1);
  simulation.step(150, player);
  simulation.step(1_000, player);

  assert.equal(events.filter(({ type }) => type === "buildingHit").length, 1);
  const [survivor] = simulation.enemies;
  assert.deepEqual(survivor.cell, entry);
  assert.equal(survivor.unreachable, true);
  assert.equal(simulation.counters.playerContacts, 0);
});

test("enemies with no building objective still need to spot an obscured player", () => {
  const player = cell(7, 5);
  const detour = [cell(5, 6), cell(6, 6), cell(7, 6)];
  const map = makeMap({ corridor: [entry, player, ...detour] });
  const { simulation, events } = runCombat(map);
  simulation.spawn(1, 1);
  simulation.step(1_000, player);

  const [enemy] = simulation.enemies;
  assert.deepEqual(enemy.cell, entry);
  assert.ok(!events.some(({ target }) => target?.kind === "player"));
  simulation.step(150, detour[0]);
  assert.equal(simulation.counters.playerContacts, 1, "The unit still attacks on real contact once the player is exposed");
});

test("250 active play enemies reuse one measured route field for multiple owned structures", () => {
  const map = makeMap();
  for (const target of [cell(15, 6), cell(18, 7), cell(16, 17), cell(9, 24), cell(18, 26), cell(21, 27)]) {
    assert.ok(map.placeBuilding("economy", target, 6));
  }
  const { simulation } = runCombat(map);
  simulation.spawn(250, 1);
  assert.equal(simulation.searchTimeMs, 0);
  simulation.step(1);
  assert.equal(simulation.searchCount, 1);
  assert.ok(simulation.searchTimeMs > 0);
  const searchTimeMs = simulation.searchTimeMs;
  simulation.step(3 * DEFENSE_CONFIG.travelMs);
  assert.equal(simulation.searchCount, 1);
  assert.equal(simulation.searchTimeMs, searchTimeMs);
  assert.equal([...simulation.enemies].length, 250);
});

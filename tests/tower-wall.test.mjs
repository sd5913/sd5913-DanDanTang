import assert from "node:assert/strict";
import test from "node:test";
import { loadTowerWallEngine, runTowerWallFixture } from "./tower-wall-matrix.mjs";

const engine = await loadTowerWallEngine();
const execute = (options) => runTowerWallFixture(engine, options);
const fixed = (options) => execute({ towerWallSynergy: true, ...options });
const legacy = (options) => execute({ towerWallSynergy: false, ...options });

test("both evolved towers fire outside a complete friendly ring at the old range, for each wall integrity", () => {
  const gateStates = { none: undefined, intact: 25, partial: 13, upgraded: 50, broken: undefined };
  for (const kind of ["horizontal", "burst"]) {
    for (const [wallState, hp] of Object.entries(gateStates)) {
      const options = { kind, wallState, profile: "armored", count: 12, durationMs: 4_000, radius: 1 };
      const before = legacy(options);
      const after = fixed(options);
      const gate = after.wallsStart.find(({ col, row }) => col === after.points.gate.col && row === after.points.gate.row);
      assert.equal(gate?.hp, hp);
      assert.equal(after.wallsStart.length, wallState === "none" ? 0 : wallState === "broken" ? 7 : 8);
      assert.ok(after.firstFireMs !== null && after.preBreachDamage > 0, kind + " " + wallState);
      if (gate) {
        assert.equal(after.gateInitiallyWalkable, false);
        assert.ok(after.firstFireMs < after.firstImpactMs, kind + " should damage the moving exterior enemy first");
        assert.equal(before.preBreachDamage, 0);
        assert.equal(before.firstRejection.reason, "BLOCKED_BY_FRIENDLY_WALL");
        const hits = after.reports.filter(({ type, wallId }) => type === "wallImpact" && wallId === gate.id);
        assert.ok(hits.length > 0 && hits.reduce((total, hit) => total + hit.damage, 0) <= hp);
        assert.ok(hits.some(({ hp }) => hp > 0));
      } else {
        assert.equal(before.firstFireMs, after.firstFireMs);
        if (wallState === "none") assert.equal(before.damage, after.damage);
        assert.equal(before.reports.find(({ type }) => type === "towerShot").damage,
          after.reports.find(({ type }) => type === "towerShot").damage);
      }
    }
  }
});

test("two layers, vertical main fire, and an actual off-axis turn all work through friendly walls", () => {
  const doubleWall = fixed({ layers: 2, durationMs: 4_000 });
  assert.equal(doubleWall.wallsStart.length, 24);
  assert.ok(doubleWall.preBreachDamage > 0 && doubleWall.firstFireMs < doubleWall.firstImpactMs);
  assert.ok(doubleWall.maxTargets > 1);
  const vertical = fixed({ kind: "vertical", highland: true, durationMs: 4_000 });
  assert.ok(vertical.firstFireMs < vertical.firstImpactMs);
  assert.ok(vertical.effectKinds.piercing > 0);
  const turn = fixed({ turning: true, durationMs: 3_000 });
  assert.ok(turn.firstFireMs < turn.firstImpactMs);
  assert.deepEqual(Object.keys(turn.effectKinds), ["piercingFallback"]);
  assert.ok(turn.reasonCounts.WRONG_AXIS > 0);
});

test("walls and open water pass shots, while dirt, rock and occupied nonwalls still stop an evolved ray", () => {
  const water = fixed({ terrain: "~", count: 8, durationMs: 3_200 });
  assert.equal(water.obstacleWalkable, false);
  assert.equal(water.wallImpacts, 0);
  assert.ok(water.damage > 0);
  for (const [terrain, reason] of [["#", "BLOCKED_BY_SOLID_TERRAIN"], ["+", "BLOCKED_BY_SOLID_TERRAIN"], ["structure", "BLOCKED_BY_STRUCTURE"]]) {
    for (const kind of ["horizontal", "burst"]) {
      const result = fixed({ kind, terrain, count: 8, durationMs: 3_200 });
      assert.equal(result.obstacleWalkable, false);
      assert.equal(result.damage, 0);
      assert.ok(result.reasonCounts[reason] > 0);
    }
  }
});

test("diagnostics separate out-of-range, cooldown and a wall impact that consumed the target before the cast", () => {
  const run = fixed({ profile: "armored", count: 1, durationMs: 2_000 });
  for (const type of ["OUT_OF_RANGE", "COOLDOWN"]) assert.ok(run.reasonCounts[type] > 0, type);
  const beforeAim = fixed({ profile: "armored", count: 1, durationMs: 2_000, tickMs: 2_000 });
  assert.equal(beforeAim.reasonCounts.WALL_IMPACT_BEFORE_AIM, 1);
  assert.deepEqual(beforeAim.frames[0].wallImpactEnemyIds, [beforeAim.reports.find(({ type }) => type === "wallImpact").enemyId]);
  assert.equal(beforeAim.attacks, 0);
  assert.equal(run.wallImpacts, 1);
  assert.equal(run.wallDamage, 3);
  assert.equal(run.towerKills, 0);
  assert.equal(run.killIncome, 0);
  assert.equal(run.spawned, run.removed);
});

test("off-axis and splash acquisition candidates are distinct from the seven-tile beam or two-tile blast", () => {
  const options = { count: 4, diagnostic: false, durationMs: 3_500, profile: "armored" };
  for (const [kind, ranges, key] of [
    ["horizontal", [3, 4, 5], "piercingFallbackRange"],
    ["burst", [4, 5, 6], "burstRange"],
  ]) {
    for (const candidate of ranges) {
      for (const offset of ranges) {
        const result = fixed({ ...options, kind, offset, ranged: { [key]: candidate } });
        assert.equal(result.attacks > 0, offset <= candidate, kind + " range " + candidate + " lane " + offset);
        assert.ok(result.gateHp === 25);
        for (const { effect } of result.reports.filter(({ type }) => type === "towerEffect")) {
          assert.equal(effect.kind, kind === "burst" ? "burst" : "piercingFallback");
          if (effect.kind === "burst") assert.equal(effect.radius, 2);
        }
      }
    }
  }
});

test("ordinary level-one targeting, contact, damage and rewards stay identical under the wall policy", () => {
  const options = { kind: "standard", durationMs: 4_000 };
  const before = legacy(options);
  const after = fixed(options);
  assert.deepEqual(after.reports, before.reports);
  assert.equal(after.killIncome, before.killIncome);
  assert.ok(after.wallDamage > 0 && after.preBreachDamage > 0);
});

function movingBoundaries({ kind, coordinates, obstacle, towerWallSynergy = true, highland = false }) {
  const { TerrainMap, DefenseSimulation, PLAYTEST_TOWER_TUNING, TILE_SIZE } = engine;
  const source = { col: 11, row: 12 };
  const entry = { col: 23, row: 28 };
  const goal = { col: 0, row: 28 };
  const rows = Array.from({ length: 32 }, () => Array(24).fill("."));
  const biomes = Array.from({ length: 32 }, () => Array(24).fill("ordinary"));
  rows[entry.row][entry.col] = "S";
  if (highland) biomes[source.row][source.col] = "highland";
  const wall = { col: 13, row: 12 };
  if (obstacle && obstacle !== "wall") rows[wall.row][wall.col] = obstacle;
  const map = new TerrainMap(rows.map((row) => row.join("")), { towerEvolution: true, autoMerge: false, buildingBalance: "w25", biomes });
  const footprint = kind === "burst" ? [[11, 12], [10, 12], [10, 13], [9, 13]] : [[11, 12], [10, 12], [9, 12], [8, 12]];
  footprint.forEach(([col, row]) => assert.ok(map.placeBuilding("tower", { col, row })));
  assert.ok(map.executeBuildingSynthesis(map.previewReadySynthesis(source), { col: 12, row: 13 }).success);
  if (obstacle === "wall") assert.ok(map.placeBuilding("wall", wall));
  const events = [];
  const simulation = new DefenseSimulation(map, entry, goal, (event) => events.push(event), false, {
    towerTargeting: true, towerWallSynergy, towerTuning: { ...PLAYTEST_TOWER_TUNING, piercingFallbackRange: 4, burstRange: 5 },
  });
  assert.equal(simulation.spawn(coordinates.length, 3, { hp: 14, contactDamage: 2 }), coordinates.length);
  const units = [...simulation.enemies];
  units.forEach((unit, index) => {
    const [x, y] = coordinates[index];
    unit.point = { x: x * TILE_SIZE, y: y * TILE_SIZE };
    unit.cell = { col: Math.floor(x), row: Math.floor(y) };
    assert.ok(map.isWalkable(unit.cell));
    unit.move = { to: { col: unit.cell.col, row: unit.cell.row + 1 }, end: { x: x * TILE_SIZE, y: (y + 1) * TILE_SIZE },
      durationMs: 1000, elapsedMs: 0 };
  });
  simulation.step(0.0001);
  return { hp: units.map(({ hp }) => hp), events, wall: map.getBuilding(wall) };
}

test("burst splashes across only the friendly wall and preserves a separate two-tile impact threshold", () => {
  const coordinates = [[12.49, 12.5], [14.48, 12.5], [14.52, 12.5]];
  assert.deepEqual(movingBoundaries({ kind: "burst", coordinates, obstacle: "wall", towerWallSynergy: false }).hp, [10, 14, 14]);
  const fixed = movingBoundaries({ kind: "burst", coordinates, obstacle: "wall" });
  assert.deepEqual(fixed.hp, [10, 12, 14]);
  assert.equal(fixed.wall.hp, 25);
  assert.deepEqual(fixed.events.find(({ type }) => type === "towerEffect").enemyIds, [1, 2]);
  for (const obstacle of ["#", "+"]) {
    assert.deepEqual(movingBoundaries({ kind: "burst", coordinates, obstacle }).hp, [10, 14, 14]);
  }
});

test("active candidate range uses body contact, with highland bonus restricted to main acquisition", () => {
  for (const [kind, range, damage] of [["horizontal", 4, 2], ["burst", 5, 4]]) {
    for (const highland of [false, true]) {
      const nominal = highland && kind === "burst" ? range + 2 : range;
      const hit = movingBoundaries({ kind, highland, coordinates: [[11.5, 12.5 + nominal + 0.15]] });
      assert.equal(hit.hp[0], 14 - damage);
      const miss = movingBoundaries({ kind, highland, coordinates: [[11.5, 12.5 + nominal + 0.26]] });
      assert.equal(miss.hp[0], 14);
    }
  }
});

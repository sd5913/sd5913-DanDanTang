import assert from "node:assert/strict";
import test from "node:test";
import { generateExpeditionBiomes } from "../src/expedition-biomes.ts";
import { ExpeditionRound, PROTOTYPE_ONLY } from "../src/expedition-round.ts";
import { addExpeditionApproach, addExpeditionTiers, EXPEDITION_STRATA, PLAY_GENERATOR_VERSION } from "../src/expedition-terrain.ts";
import { DEFAULT_MAP_SEED, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionWorld } from "../src/generated-map.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { TerrainMap } from "../src/terrain.ts";

const cell = (col, row) => ({ col, row });
const {
  bodyNorthRow, bodySouthRow, transitionNorthRow, transitionSouthRow, referenceGate,
} = EXPEDITION_STRATA;

function compose(world) {
  const landscape = generateExpeditionBiomes(world.layout, world.effectiveSeed);
  return {
    original: addExpeditionApproach(landscape.layout),
    layout: addExpeditionApproach(addExpeditionTiers(landscape.layout, world.effectiveSeed)),
    biomes: landscape.biomes,
  };
}

function reachable(map, source, toolLevel) {
  const positions = [source];
  const key = ({ col, row }) => row * map.columns + col;
  const cameFrom = new Map([[key(source), undefined]]);
  for (const from of positions) {
    for (const next of [cell(from.col, from.row - 1), cell(from.col + 1, from.row), cell(from.col, from.row + 1), cell(from.col - 1, from.row)]) {
      const state = map.getCell(next);
      if (!state || cameFrom.has(key(next))) continue;
      if (!map.isWalkable(next) && (state.terrain !== "dirt" || state.terrainLevel > toolLevel)) continue;
      cameFrom.set(key(next), from);
      positions.push(next);
    }
  }
  return { positions, cameFrom, key };
}

function countDirt(layout, firstRow, lastRow) {
  const cells = layout.slice(firstRow, lastRow + 1).join("");
  return {
    soft: (cells.match(/\+/g) ?? []).length,
    hard: (cells.match(/2/g) ?? []).length,
  };
}

test("101 seeds keep mixed five-row transitions, independently gated goals, and 70–85% Lv2 in the diggable body", (context) => {
  const seeds = [...Array.from({ length: 99 }, (_, seed) => seed), DEFAULT_MAP_SEED, 0xffff_ffff];
  const ratios = [];
  const halves = [[], []];
  const totals = { bodySoft: 0, bodyHard: 0, transitionSoft: 0, transitionHard: 0 };
  const baseFallbacks = [];
  let goalReaches = 0;
  for (const seed of seeds) {
    const world = generateExpeditionWorld(seed);
    if (world.usedFallback) baseFallbacks.push({ requested: seed, effective: world.effectiveSeed });
    const { original, layout, biomes } = compose(world);
    const map = new TerrainMap(layout, { biomes });
    assert.equal(PLAY_GENERATOR_VERSION, 4);
    assert.equal(transitionSouthRow - transitionNorthRow + 1, 5);
    assert.deepEqual(layout.slice(transitionSouthRow + 1), original.slice(transitionSouthRow + 1));
    assert.equal(map.getCell(referenceGate).terrainLevel, 2);
    assert.equal(map.getCell(cell(referenceGate.col, referenceGate.row + 1)).terrainLevel, 1);

    for (let row = 0; row < layout.length; row += 1) {
      for (let col = 0; col < map.columns; col += 1) {
        if (original[row][col] !== "+") assert.equal(layout[row][col], original[row][col]);
      }
    }
    const body = countDirt(layout, bodyNorthRow, bodySouthRow);
    const ratio = body.hard / (body.soft + body.hard);
    assert.ok(ratio >= 0.70 && ratio <= 0.85, `seed ${seed} body level 2 ratio ${ratio}`);
    ratios.push(ratio);
    totals.bodySoft += body.soft;
    totals.bodyHard += body.hard;
    for (const [half, first, last] of [[0, bodyNorthRow, 31], [1, 32, bodySouthRow]]) {
      const dirt = countDirt(layout, first, last);
      const continuity = dirt.hard / (dirt.soft + dirt.hard);
      assert.ok(continuity > 0.5, `seed ${seed} advanced body must continue on both sides of seam 31/32`);
      halves[half].push(continuity);
    }

    const transition = countDirt(layout, transitionNorthRow, transitionSouthRow);
    assert.ok(transition.soft > 0 && transition.hard > 0);
    const transitionRows = layout.slice(transitionNorthRow, transitionSouthRow + 1);
    assert.ok(transitionRows.filter((line) => line.includes("2")).length >= 2, "the cut must span multiple depths");
    assert.ok(transitionRows.every((line) => !line.includes("2") || line.includes("+")), "no solid straight tier row");
    totals.transitionSoft += transition.soft;
    totals.transitionHard += transition.hard;

    const goals = (layout.join("").match(/G/g) ?? []).length;
    for (const origin of [map.spawn, GENERATED_ENEMY_ENTRY]) {
      assert.equal(reachable(map, origin, 1).positions.filter((position) => map.isGoal(position)).length, 0,
        `seed ${seed} has an Lv1 bypass`);
      assert.equal(reachable(map, origin, 2).positions.filter((position) => map.isGoal(position)).length, goals,
        `seed ${seed} must reach every goal with Lv2`);
      goalReaches += goals;
    }
  }

  const percent = (value) => `${(100 * value).toFixed(3)}%`;
  const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  context.diagnostic(`Strata ${seeds.length} seeds: ${JSON.stringify(totals)}; body Lv2 min/mean/max `
    + `${percent(Math.min(...ratios))}/${percent(mean)}/${percent(Math.max(...ratios))}; `
    + `min Lv2 on the two sides of seam 31/32 ${halves.map((part) => percent(Math.min(...part))).join("/")}; `
    + `Lv1 0 and Lv2 ${goalReaches} reachable origin/goal pairs; base fallback ${JSON.stringify(baseFallbacks)}`);
  assert.deepEqual(baseFallbacks, []);
});

test("seeded strata are reproducible in any chunk read order and preserve the original effective fallback seed", () => {
  const world = generateExpeditionWorld(12);
  const first = compose(world);
  assert.deepEqual(compose(generateExpeditionWorld(12)), first);
  assert.notDeepEqual(addExpeditionTiers(first.original, 13), addExpeditionTiers(first.original, 12));
  const map = new TerrainMap(first.layout, { biomes: first.biomes });
  const fresh = new TerrainMap(compose(world).layout, { biomes: first.biomes });
  for (const chunkRow of [2, 0, 1]) {
    for (const localRow of [31, 0, 13]) {
      const position = map.chunkToWorld({ chunkCol: 0, chunkRow }, cell(19, localRow));
      assert.deepEqual(map.getCell(position), fresh.getCell(position));
      assert.equal(map.getBiome(position), fresh.getBiome(position));
    }
  }
  const fallback = generateExpeditionWorld(12, (seed) => seed === 12 ? undefined : generateExpeditionWorld(seed).layout);
  assert.equal(fallback.requestedSeed, 12);
  assert.equal(fallback.effectiveSeed, DEFAULT_MAP_SEED);
  assert.equal(fallback.usedFallback, true);
  assert.deepEqual(compose(fallback), compose(generateExpeditionWorld(DEFAULT_MAP_SEED)));
});

test("legal Lv2 excavation reaches the northern goal and retains partial hard soil and biome across reads and reset", () => {
  const { layout, biomes } = compose(generateExpeditionWorld(12));
  const map = new TerrainMap(layout, { biomes });
  const round = new ExpeditionRound(true);
  const firstOrder = round.update(PROTOTYPE_ONLY.fast.preparingMs, map.spawn.row, 0, 0);
  const route = reachable(map, map.spawn, 2);
  const path = [GENERATED_GOAL];
  for (let previous = route.cameFrom.get(route.key(path[0])); previous; previous = route.cameFrom.get(route.key(previous))) {
    path.push(previous);
  }
  path.reverse();
  assert.deepEqual(path[0], map.spawn);
  let inspected;
  const crossed = [];
  for (const [i, target] of path.entries()) {
    if (i === 0) continue;
    const from = path[i - 1];
    if (!map.isWalkable(target)) {
      if (map.getCell(target).terrainLevel === 2 && !inspected && target.row <= bodySouthRow) {
        const biome = map.getBiome(target);
        const revision = map.revision;
        assert.equal(map.applyDigDamage(from, target, MINING_CONFIG.damage, 1).reason, "tool-level");
        assert.equal(map.getCell(target).hp, 8);
        assert.equal(map.applyDigDamage(from, target, 3, 2).hp, 5);
        for (const row of [92, 4, 64, 31]) map.getCell(cell(19, row));
        assert.equal(map.getCell(target).hp, 5);
        assert.equal(map.getBiome(target), biome);
        assert.equal(map.revision, revision);
        inspected = { target, biome };
      }
      const hits = Math.ceil(map.getCell(target).hp / MINING_CONFIG.damage);
      for (let hit = 0; hit < hits; hit += 1) {
        assert.equal(map.applyDigDamage(from, target, MINING_CONFIG.damage, 2).effective, true);
      }
      assert.equal(map.isWalkable(target), true);
    }
    round.update(1, target.row, 1, 0);
    if (map.worldToChunk(target).chunk.chunkRow !== map.worldToChunk(from).chunk.chunkRow) crossed.push(round.stage);
  }
  assert.ok(inspected, "must actually excavate Lv2 terrain inside the body");
  assert.ok(map.isWalkable(GENERATED_GOAL));
  assert.ok(map.isGoal(GENERATED_GOAL));
  assert.ok(crossed.includes(1) && crossed.includes(2));
  assert.equal(firstOrder.enemyHp, PROTOTYPE_ONLY.profiles[0].enemyHp);
  assert.equal(round.stage, 2);
  assert.equal(round.reachGoal(2), true);
  assert.equal(round.phase, "won");
  assert.equal(map.getCell(inspected.target).terrain, "empty");
  assert.equal(map.getBiome(inspected.target), inspected.biome);
  map.reset();
  assert.equal(map.getCell(inspected.target).hp, 8);
  assert.equal(map.getCell(inspected.target).terrainLevel, 2);
  assert.equal(map.getBiome(inspected.target), inspected.biome);
});

test("invalid seed or unusable geometry is reported without silently discarding the advanced strata", () => {
  const { original } = compose(generateExpeditionWorld(12));
  assert.throws(() => addExpeditionTiers(original, -1), /effective unsigned 32-bit seed/);
  const sealed = [...original];
  sealed[66] = "#".repeat(40);
  assert.throws(() => addExpeditionTiers(sealed, 12), /level 1 and level 2 goal reachability/);
  const missingGate = [...original];
  const row = missingGate[referenceGate.row];
  missingGate[referenceGate.row] = row.slice(0, referenceGate.col) + "." + row.slice(referenceGate.col + 1);
  assert.throws(() => addExpeditionTiers(missingGate, 12), /staggered tool gate/);
});

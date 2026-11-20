import assert from "node:assert/strict";
import test from "node:test";
import { BIOME_GENERATOR_VERSION, generateExpeditionBiomes } from "../src/expedition-biomes.ts";
import { addExpeditionTiers } from "../src/expedition-terrain.ts";
import {
  DEFAULT_MAP_SEED, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, GENERATED_SPAWN, generateExpeditionMap,
} from "../src/generated-map.ts";

const COLUMNS = 40;
const ROWS = 96;
const regionKinds = ["plain", "highland", "lake"];

function key({ col, row }) {
  return row * COLUMNS + col;
}

function reachable(start, canEnter) {
  const visited = new Set([key(start)]);
  const queue = [start];
  for (const { col, row } of queue) {
    const neighbors = [{ col: col + 1, row }, { col: col - 1, row }, { col, row: row + 1 }, { col, row: row - 1 }];
    for (const next of neighbors) {
      if (next.col < 0 || next.col >= COLUMNS || next.row < 0 || next.row >= ROWS) continue;
      const id = key(next);
      if (visited.has(id) || !canEnter(next)) continue;
      visited.add(id);
      queue.push(next);
    }
  }
  return visited;
}

function isOpen(marker) {
  return marker === "." || marker === "S" || marker === "G";
}

function gatherRegions(biomes) {
  const regions = Object.fromEntries(regionKinds.map((kind) => [kind, []]));
  assert.equal(biomes.length, ROWS);
  for (let row = 0; row < ROWS; row += 1) {
    assert.equal(biomes[row].length, COLUMNS);
    for (let col = 0; col < COLUMNS; col += 1) {
      const kind = biomes[row][col];
      if (kind === "ordinary") continue;
      assert.ok(Object.hasOwn(regions, kind), `unknown biome ${kind}`);
      regions[kind].push({ col, row });
    }
  }
  return regions;
}

test("version 2 overlays are stable for the same seed and actually vary the layout and regions", () => {
  const base = generateExpeditionMap(12);
  const before = [...base];
  const first = generateExpeditionBiomes(base, 12);
  assert.equal(BIOME_GENERATOR_VERSION, 2);
  assert.deepEqual(generateExpeditionBiomes(base, 12), first);
  assert.deepEqual(base, before);
  const other = generateExpeditionBiomes(base, 13);
  assert.notDeepEqual(other.layout, first.layout);
  assert.notDeepEqual(other.biomes, first.biomes);
  assert.equal(first.biomes[73][19], "plain");
  assert.equal(first.layout[50][19], ".");
  assert.equal(first.layout[50][20], "~");
});

test("99 seed fixtures vary depth order and keep continuous regions, dry shores, and carveable progression", () => {
  const seeds = [...Array.from({ length: 96 }, (_, seed) => seed), 555, DEFAULT_MAP_SEED, 0xffff_ffff];
  const orders = new Set();
  let acrossSeam = 0;
  let forcedDetours = 0;
  for (const seed of seeds) {
    const base = generateExpeditionMap(seed);
    const { layout, biomes } = generateExpeditionBiomes(base, seed);
    const regions = gatherRegions(biomes);
    const byDepth = regionKinds.map((kind) => {
      const cells = regions[kind];
      assert.ok(cells.length > 0, `${kind} missing in seed ${seed}`);
      assert.equal(reachable(cells[0], ({ col, row }) => biomes[row][col] === kind).size, cells.length);
      assert.ok(cells.every(({ col, row }) => col > 0 && col < 39 && row >= 12 && row < 83), `${kind} overruns a protected area`);
      return { kind, first: cells[0].row, last: cells.at(-1).row };
    }).sort((a, b) => a.first - b.first);
    for (let i = 1; i < byDepth.length; i += 1) assert.ok(byDepth[i - 1].last < byDepth[i].first, "regions overlap");
    orders.add(byDepth.map(({ kind }) => kind).join("/"));
    if (byDepth.some(({ first, last }) => Math.floor(first / 32) !== Math.floor(last / 32))) acrossSeam += 1;
    if (layout.some((line, row) => row > 4 && row < 63 && "#~".includes(line[19]))) forcedDetours += 1;

    const plainRock = regions.plain.filter(({ col, row }) => layout[row][col] === "#").length;
    const plainDirt = regions.plain.filter(({ col, row }) => layout[row][col] === "+").length;
    const highlandRock = regions.highland.filter(({ col, row }) => layout[row][col] === "#").length;
    assert.ok(plainDirt / regions.plain.length >= 0.6, `plain lacks workable dirt in seed ${seed}`);
    assert.ok(highlandRock / regions.highland.length - plainRock / regions.plain.length >= 0.15, `highland lacks relief in seed ${seed}`);

    const shore = regions.lake.filter(({ col, row }) => layout[row][col] === ".");
    const water = regions.lake.filter(({ col, row }) => layout[row][col] === "~");
    assert.ok(shore.length >= 30 && water.length >= 35, `lake too small in seed ${seed}`);
    assert.equal(reachable(water[0], ({ col, row }) => layout[row][col] === "~").size, water.length);
    assert.equal(layout.reduce((count, line) => count + [...line].filter((marker) => marker === "~").length, 0), water.length);

    const playable = addExpeditionTiers(layout);
    for (const { col, row } of shore) assert.equal(playable[row][col], ".", "the tier gates must leave the shore intact");
    const shoreNetwork = reachable(shore[0], ({ col, row }) => playable[row][col] === ".");
    assert.equal(shoreNetwork.size, shore.length, "the dry shore must be a connected, distinct ring");
    for (const { col, row } of water) {
      const sides = [{ col, row: row - 1 }, { col, row: row + 1 }, { col: col - 1, row }, { col: col + 1, row }];
      for (const side of sides) {
        if (playable[side.row][side.col] === "~") continue;
        assert.ok(shoreNetwork.has(key(side)), "every exposed water edge needs a reachable bank");
      }
    }

    assert.deepEqual(layout.slice(83), base.slice(83), "starting terrain and the enemy pocket must stay intact");
    for (let row = 63; row < ROWS; row += 1) assert.equal(layout[row][19], base[row][19]);
    assert.equal(playable[63][19], "2", "the first Tier 2 test gate must survive the overlay");
    for (const source of [GENERATED_SPAWN, GENERATED_ENEMY_ENTRY]) {
      const route = reachable(source, ({ col, row }) => !["#", "~"].includes(playable[row][col]));
      assert.ok(route.has(key(GENERATED_GOAL)), `sealed route from ${source.col},${source.row}, seed ${seed}`);
      assert.ok(shore.every((cell) => route.has(key(cell))), `shore inaccessible in seed ${seed}`);
    }
    const home = reachable(GENERATED_SPAWN, ({ col, row }) => isOpen(playable[row][col]));
    assert.equal(home.has(key(GENERATED_GOAL)), false);
    assert.equal(home.has(key(GENERATED_ENEMY_ENTRY)), false);
    for (let row = 0; row <= ROWS - 5; row += 1) {
      for (let col = 0; col <= COLUMNS - 5; col += 1) {
        if (!isOpen(playable[row][col]) || home.has(key({ col, row }))) continue;
        assert.ok(playable.slice(row, row + 5).some((line) => /[+2#~]/.test(line.slice(col, col + 5))),
          `oversized opening at ${col},${row}, seed ${seed}`);
      }
    }
  }
  assert.equal(orders.size, 6);
  assert.ok(acrossSeam > 0, "biomes must be able to cross a chunk seam");
  assert.ok(forcedDetours > 0, "a straight walk up the center is not always a legal route");
});

test("an invalid extent or a sealed protected belt cannot silently generate a level", () => {
  assert.throws(() => generateExpeditionBiomes(["S"], 12), /requires the 40×96 expedition layout/);
  const sealed = [...generateExpeditionMap(12)];
  sealed[83] = "#".repeat(COLUMNS);
  assert.throws(() => generateExpeditionBiomes(sealed, 12), /could not produce a traversable expedition/);
});

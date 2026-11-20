import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAP_SEED, generateExpeditionMap, generateExpeditionWorld,
} from "../src/generated-map.ts";
import { newWorldSeed, selectWorldSeed, worldSeedLabel } from "../src/world-seed.ts";

test("a round without a seed can use the full unsigned 32-bit range", () => {
  const draws = [0, 0x8000_0000, 0xffff_ffff];
  assert.deepEqual(draws.map((value) => selectWorldSeed(null, () => value)), draws);
  const actual = selectWorldSeed(null);
  assert.ok(Number.isInteger(actual) && actual >= 0 && actual <= 0xffff_ffff);
});

test("a shared seed is parsed deterministically without drawing a new seed", () => {
  const unexpectedDraw = () => assert.fail("An explicit URL parameter should not draw a seed");
  for (const seed of [0, 12, 0xffff_ffff]) {
    assert.equal(selectWorldSeed(String(seed), unexpectedDraw), seed);
  }
  for (const invalid of ["", "-1", "1.5", "1e3", "4294967296", "forest"]) {
    assert.equal(selectWorldSeed(invalid, unexpectedDraw), DEFAULT_MAP_SEED);
  }
});

test("new rounds draw a fresh seed different from both the requested and fallback seeds", () => {
  const current = { requestedSeed: 12, effectiveSeed: DEFAULT_MAP_SEED };
  const draws = [12, 144];
  assert.equal(newWorldSeed(current, () => draws.shift()), 144);
  assert.deepEqual(draws, []);

  const boundary = { requestedSeed: 0xffff_ffff, effectiveSeed: 0 };
  assert.equal(newWorldSeed(boundary, () => 0xffff_ffff), 1);
});

test("the world label includes the generator version and actual seed after fallback", () => {
  const ordinary = generateExpeditionWorld(12);
  assert.equal(worldSeedLabel(ordinary), "种子 12 · 生成器 v1 · 备用布局 未启用");

  const defaultLayout = generateExpeditionMap(DEFAULT_MAP_SEED);
  const fallback = generateExpeditionWorld(12, (seed) => seed === DEFAULT_MAP_SEED ? defaultLayout : undefined);
  assert.equal(worldSeedLabel(fallback), "种子 20261120 · 生成器 v1 · 备用布局 已启用（请求种子 12）");
  assert.deepEqual(fallback.layout, defaultLayout);
});

import assert from "node:assert/strict";
import test from "node:test";
import { MiningSession } from "../src/mining.ts";
import { TerrainMap } from "../src/terrain.ts";

const north = { col: 11, row: 27 };
const northeast = { col: 12, row: 27 };
const east = { col: 12, row: 28 };

test("mining strikes immediately, then once per elapsed interval, and stops after clearing", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const hovered = { ...north };
  const initial = mining.begin(map.spawn, hovered, 1_000);
  assert.deepEqual(initial, {
    target: north, result: { effective: true, damage: 1, hp: 4, cleared: false },
  });

  hovered.col = northeast.col;
  assert.equal(mining.update(map.spawn, 1_249), undefined);
  for (const [time, hp] of [[1_250, 3], [1_500, 2], [1_750, 1], [2_000, 0]]) {
    assert.deepEqual(mining.update(map.spawn, time), {
      target: north, result: { effective: true, damage: 1, hp, cleared: hp === 0 },
    });
    assert.equal(mining.update(map.spawn, time), undefined);
  }
  assert.equal(mining.update(north, 2_250), undefined);
  assert.equal(map.getCell(northeast).hp, 5);
});

test("stopping a hold preserves damage until an explicit new press", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  mining.update(map.spawn, 250);
  mining.stop();
  assert.equal(mining.update(east, 500), undefined);
  assert.equal(mining.update(map.spawn, 750), undefined);
  assert.equal(map.getCell(north).hp, 3);
  assert.equal(mining.begin(map.spawn, north, 1_200).result.hp, 2);
  assert.equal(mining.update(map.spawn, 1_449), undefined);
  assert.equal(mining.update(map.spawn, 1_450).result.hp, 1);
});

test("leaving range between attack deadlines ends the hold even if the player returns", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  assert.equal(mining.update(east, 100), undefined);
  assert.equal(mining.update(map.spawn, 250), undefined);
  assert.equal(mining.update(map.spawn, 500), undefined);
  assert.equal(map.getCell(north).hp, 4);

  assert.equal(mining.begin(east, north, 600).result.reason, "out-of-reach");
  assert.equal(mining.update(map.spawn, 850), undefined);
  assert.equal(map.getCell(north).hp, 4);
});

test("30, 60, and 144 FPS each produce five attacks by one second", () => {
  for (const fps of [30, 60, 144]) {
    const map = new TerrainMap();
    const mining = new MiningSession(map);
    let attacks = Number(mining.begin(map.spawn, north, 0).result.effective);
    for (let frame = 1; frame < fps; frame += 1) {
      attacks += Number(mining.update(map.spawn, frame * 1_000 / fps)?.result.effective ?? false);
    }
    assert.equal(attacks, 4, `before one second at ${fps} FPS`);
    assert.equal(map.getCell(north).hp, 1);
    assert.equal(mining.update(map.spawn, 1_000).result.cleared, true, `fifth attack at ${fps} FPS`);
  }
});

test("short frame stalls retain due attacks and the original cadence", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  assert.equal(mining.update(map.spawn, 200), undefined);
  assert.equal(mining.update(map.spawn, 525).result.hp, 2);
  assert.equal(mining.update(map.spawn, 749), undefined);
  assert.equal(mining.update(map.spawn, 750).result.hp, 1);
  assert.equal(mining.update(map.spawn, 1_000).result.cleared, true);
});

test("a long pause stops the session without a backlog of attacks", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  assert.equal(mining.update(map.spawn, 8_000), undefined);
  assert.equal(mining.update(map.spawn, 8_250), undefined);
  assert.equal(map.getCell(north).hp, 4);
});

test("tool options can provide other damage and attack intervals", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map, { damage: 2, attackIntervalMs: 100 });
  assert.equal(mining.begin(map.spawn, north, 0).result.hp, 3);
  assert.equal(mining.update(map.spawn, 99), undefined);
  assert.equal(mining.update(map.spawn, 100).result.hp, 1);
  assert.equal(mining.update(map.spawn, 200).result.cleared, true);
});

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

test("release and re-press keep the original deadline while locking the new hold", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  assert.equal(mining.begin(map.spawn, north, 0).result.hp, 4);
  assert.equal(mining.update(map.spawn, 50), undefined);
  mining.stop();
  assert.equal(mining.begin(map.spawn, north, 70), undefined);
  assert.equal(map.getCell(north).hp, 4);
  assert.equal(mining.update(map.spawn, 249), undefined);
  assert.deepEqual(mining.update(map.spawn, 250), {
    target: north, result: { effective: true, damage: 1, hp: 3, cleared: false },
  });
  assert.equal(mining.update(map.spawn, 250), undefined);
});

test("rapid independent presses cannot outpace a held attack", () => {
  const heldMap = new TerrainMap();
  const held = new MiningSession(heldMap);
  let heldHits = Number(held.begin(heldMap.spawn, north, 0).result.effective);
  for (let now = 250; now <= 1_000; now += 250) {
    heldHits += Number(held.update(heldMap.spawn, now)?.result.effective ?? false);
  }
  assert.equal(heldHits, 5);

  for (const pressInterval of [30, 50, 80]) {
    const map = new TerrainMap();
    const mining = new MiningSession(map);
    const origin = { col: 13, row: 27 };
    const targets = [northeast, { col: 13, row: 26 }];
    const effectiveTimes = [];
    for (let press = 0; press * pressInterval <= 1_000; press += 1) {
      const now = press * pressInterval;
      if (mining.begin(origin, targets[press % targets.length], now)?.result.effective) effectiveTimes.push(now);
      mining.stop();
    }
    assert.ok(effectiveTimes.length <= heldHits, `${pressInterval} ms presses must not outpace a hold`);
    for (let index = 1; index < effectiveTimes.length; index += 1) {
      assert.ok(effectiveTimes[index] - effectiveTimes[index - 1] >= 250,
        `effective strikes from ${pressInterval} ms presses must be at least 250 ms apart`);
    }
    assert.equal(targets.reduce((hp, target) => hp + map.getCell(target).hp, 0), 10 - effectiveTimes.length);
    if (pressInterval === 50) assert.deepEqual(effectiveTimes, [0, 250, 500, 750, 1_000]);
  }
});

test("the tool deadline applies across two simultaneously eligible targets", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const origin = { col: 13, row: 27 };
  const target = { col: 13, row: 26 };
  assert.equal(mining.begin(origin, northeast, 0).result.hp, 4);
  mining.stop();
  const hovered = { ...target };
  assert.equal(mining.begin(origin, hovered, 100), undefined);
  hovered.col = northeast.col;
  hovered.row = northeast.row;
  assert.equal(map.getCell(target).hp, 5);
  assert.equal(mining.update(origin, 249), undefined);
  assert.deepEqual(mining.update(origin, 250), {
    target, result: { effective: true, damage: 1, hp: 4, cleared: false },
  });
  assert.equal(map.getCell(northeast).hp, 4);
  assert.equal(map.getCell(target).hp, 4);
});

test("a clearing strike still imposes cooldown and a press after expiry strikes immediately", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const origin = { col: 13, row: 27 };
  const target = { col: 13, row: 26 };
  assert.equal(mining.begin(origin, northeast, 0).result.hp, 4);
  for (const now of [250, 500, 750]) mining.update(origin, now);
  assert.equal(mining.update(origin, 1_000).result.cleared, true);
  assert.equal(map.revision, 1);

  assert.equal(mining.begin(origin, target, 1_001), undefined);
  assert.equal(mining.update(origin, 1_249), undefined);
  assert.equal(map.getCell(target).hp, 5);
  mining.stop();
  assert.equal(mining.update(origin, 1_250), undefined);
  assert.equal(mining.begin(origin, target, 1_300).result.hp, 4);
  assert.equal(map.revision, 1);
});

test("invalid attempts preserve their reasons and do not refresh the tool deadline", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const west = { col: 10, row: 28 };
  const outside = { col: 24, row: 28 };
  assert.equal(mining.begin(map.spawn, north, 0).result.hp, 4);
  mining.stop();
  assert.deepEqual(mining.begin(map.spawn, west, 100), {
    target: west,
    result: { effective: false, damage: 0, hp: null, cleared: false, reason: "rock" },
  });
  assert.equal(mining.begin(map.spawn, east, 150).result.reason, "empty");
  assert.equal(mining.begin(map.spawn, northeast, 200).result.reason, "out-of-reach");
  assert.equal(mining.begin(map.spawn, north, 250).result.hp, 3);
  mining.stop();
  assert.equal(mining.begin(map.spawn, outside, 550).result.reason, "out-of-bounds");
  assert.equal(mining.begin(map.spawn, north, 550).result.hp, 2);
});

test("re-pressing during cooldown keeps equal held attack counts at 30, 60, and 144 FPS", () => {
  for (const fps of [30, 60, 144]) {
    const map = new TerrainMap();
    const mining = new MiningSession(map);
    let hits = Number(mining.begin(map.spawn, north, 0).result.effective);
    mining.stop();
    assert.equal(mining.begin(map.spawn, north, 70), undefined);
    for (let frame = Math.ceil(fps * 0.07); frame < fps; frame += 1) {
      hits += Number(mining.update(map.spawn, frame * 1_000 / fps)?.result.effective ?? false);
    }
    assert.equal(hits, 4, `before one second at ${fps} FPS`);
    assert.equal(map.getCell(north).hp, 1);
    assert.equal(mining.update(map.spawn, 1_000).result.cleared, true);
  }
});

test("reset clears the active hold and the tool cooldown for the next round", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  assert.equal(mining.begin(map.spawn, north, 0).result.hp, 4);
  assert.equal(mining.begin(map.spawn, north, 30), undefined);
  map.reset();
  mining.reset();
  assert.equal(mining.update(map.spawn, 40), undefined);
  assert.equal(mining.begin(map.spawn, north, 40).result.hp, 4);
  assert.equal(mining.update(map.spawn, 289), undefined);
  assert.equal(mining.update(map.spawn, 290).result.hp, 3);
});

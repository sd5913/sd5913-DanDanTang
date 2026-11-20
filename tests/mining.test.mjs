import assert from "node:assert/strict";
import test from "node:test";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { MiningSession } from "../src/mining.ts";
import { TerrainMap } from "../src/terrain.ts";
import { TEST_MAP_LAYOUT } from "../src/test-map.ts";

const north = { col: 11, row: 27 };
const northeast = { col: 12, row: 27 };
const east = { col: 12, row: 28 };
const { attackIntervalMs } = MINING_CONFIG;
const clearAt = 4 * attackIntervalMs;

test("target preview preserves the active lock and does not retarget or end a hold by itself", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const origin = { col: 4, row: 25 };
  const locked = { col: 5, row: 25 };
  const aimed = { col: 4, row: 24 };
  const shifted = { col: 3, row: 25 };
  const shiftedAim = { col: 3, row: 26 };
  assert.equal(mining.begin(origin, locked, 0).result.hp, 4);
  assert.deepEqual(mining.getTarget(origin), locked);
  assert.deepEqual(mining.getTarget(origin, aimed), locked);
  assert.equal(mining.getTarget(shifted, shiftedAim), null, "an out-of-range lock must not preview a replacement");
  assert.deepEqual(mining.getTarget(origin, aimed), locked, "previewing out of range must not cancel the hold");
  assert.equal(map.getCell(locked).hp, 4);
  assert.equal(map.getCell(aimed).hp, 5);
  assert.equal(map.revision, 0);

  const beforeStrike = mining.getTarget(origin, aimed);
  assert.equal(mining.update(origin, attackIntervalMs - 1, aimed), undefined);
  assert.deepEqual(mining.update(origin, attackIntervalMs, aimed).target, beforeStrike);
  assert.equal(map.getCell(locked).hp, 3);
  assert.equal(map.getCell(aimed).hp, 5);
  assert.equal(mining.update(shifted, attackIntervalMs + 1, shiftedAim), undefined);
  assert.equal(mining.getTarget(origin, aimed), null, "the real out-of-range update cancels the hold");
});

test("pending preview follows eligible neighbors before the shared cooldown allows an actual strike", () => {
  const origin = { col: 4, row: 25 };
  const first = { col: 5, row: 25 };
  const hard = { col: 4, row: 24 };
  const soft = { col: 4, row: 26 };
  const layout = [...TEST_MAP_LAYOUT];
  layout[hard.row] = layout[hard.row].slice(0, hard.col) + "2" + layout[hard.row].slice(hard.col + 1);
  const map = new TerrainMap(layout);
  let toolLevel = 1;
  const mining = new MiningSession(map, { damage: 5, attackIntervalMs }, () => toolLevel);
  assert.equal(attackIntervalMs, 125);
  assert.equal(mining.begin(origin, first, 0).result.cleared, true);

  for (const invalid of [first, origin, hard, { col: 5, row: 26 }, { col: 3, row: 25 }, { col: -1, row: 25 }]) {
    assert.equal(mining.getTarget(origin, invalid), null);
  }
  assert.equal(mining.getTarget({ col: 3, row: 25 }, soft), null);
  assert.deepEqual(mining.getTarget(origin, soft), soft);
  toolLevel = 2;
  assert.deepEqual(mining.getTarget(origin, hard), hard);
  assert.equal(mining.update(origin, attackIntervalMs - 1, hard), undefined);
  assert.equal(map.getCell(hard).hp, 8);
  assert.equal(map.getCell(soft).hp, 5);
  assert.equal(map.revision, 1);

  const softPreview = mining.getTarget(origin, soft);
  assert.deepEqual(mining.update(origin, attackIntervalMs, soft), {
    target: softPreview, result: { effective: true, damage: 5, hp: 0, cleared: true },
  });
  const hardPreview = mining.getTarget(origin, hard);
  assert.deepEqual(hardPreview, hard);
  assert.equal(mining.update(origin, 2 * attackIntervalMs - 1, hard), undefined);
  assert.deepEqual(mining.update(origin, 2 * attackIntervalMs, hard), {
    target: hardPreview, result: { effective: true, damage: 5, hp: 3, cleared: false },
  });
  assert.deepEqual(mining.getTarget(origin, soft), hard, "the next damaged tile becomes the new lock");
});

test("target preview is absent while inactive, after an undiggable adjacent press, and after release or reset", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const west = { col: 10, row: 28 };
  assert.equal(mining.getTarget(map.spawn, north), null);
  assert.equal(mining.begin(map.spawn, west, 0).result.reason, "rock");
  assert.equal(mining.getTarget(map.spawn, north), null);
  assert.equal(mining.update(map.spawn, attackIntervalMs, north), undefined);
  assert.equal(map.getCell(north).hp, 5);

  assert.equal(mining.begin(map.spawn, north, 2 * attackIntervalMs).result.hp, 4);
  mining.stop();
  assert.equal(mining.getTarget(map.spawn, north), null);
  assert.equal(mining.update(map.spawn, 3 * attackIntervalMs, north), undefined);
  assert.equal(map.getCell(north).hp, 4);

  assert.equal(mining.begin(map.spawn, north, 4 * attackIntervalMs).result.hp, 3);
  mining.reset();
  assert.equal(mining.getTarget(map.spawn, north), null);
  assert.equal(mining.update(map.spawn, 5 * attackIntervalMs, north), undefined);
  assert.equal(map.getCell(north).hp, 3);
});

test("a distant first press holds its original coordinates through approach, then continues only after clearing", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const far = { col: 3, row: 25 };
  const near = { col: 4, row: 25 };
  const clicked = { col: 5, row: 25 };
  const farAlternative = { col: 3, row: 26 };
  const nearAlternative = { col: 4, row: 24 };
  const mutablePointer = { ...clicked };
  assert.equal(mining.begin(far, mutablePointer, 0).result.reason, "out-of-reach");
  Object.assign(mutablePointer, farAlternative);

  for (let time = 100; time <= 2_500; time += 100) {
    assert.equal(mining.getTarget(far, farAlternative), null);
    assert.equal(mining.update(far, time, farAlternative), undefined);
  }
  assert.equal(map.getCell(clicked).hp, 5);
  assert.equal(map.getCell(farAlternative).hp, 5);
  assert.equal(map.revision, 0);

  const arrival = 2_501;
  assert.deepEqual(mining.getTarget(near, nearAlternative), clicked);
  assert.deepEqual(mining.update(near, arrival, nearAlternative), {
    target: clicked, result: { effective: true, damage: 1, hp: 4, cleared: false },
  });
  assert.equal(mining.update(near, arrival, nearAlternative), undefined);
  assert.equal(mining.update(near, arrival + attackIntervalMs - 1, nearAlternative), undefined);
  for (let hit = 1; hit <= 4; hit += 1) {
    const strike = mining.update(near, arrival + hit * attackIntervalMs, nearAlternative);
    assert.deepEqual(strike.target, clicked);
    assert.equal(strike.result.hp, 4 - hit);
  }
  const nextDeadline = arrival + 5 * attackIntervalMs;
  assert.equal(map.getCell(nearAlternative).hp, 5);
  assert.deepEqual(mining.getTarget(near, nearAlternative), nearAlternative);
  assert.equal(mining.update(near, nextDeadline - 1, nearAlternative), undefined);
  assert.deepEqual(mining.update(near, nextDeadline, nearAlternative), {
    target: nearAlternative, result: { effective: true, damage: 1, hp: 4, cleared: false },
  });
});

test("arriving early at a queued first target still obeys the previous strike's 125 ms deadline", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const far = { col: 3, row: 25 };
  const near = { col: 4, row: 25 };
  const queued = { col: 5, row: 25 };
  const previous = { col: 4, row: 24 };
  assert.equal(attackIntervalMs, 125);
  assert.equal(mining.begin(near, previous, 0).result.hp, 4);
  mining.stop();
  assert.equal(mining.begin(far, queued, 25).result.reason, "out-of-reach");
  assert.equal(mining.update(far, 90, { col: 3, row: 26 }), undefined);
  assert.deepEqual(mining.getTarget(near, previous), queued);
  assert.equal(mining.update(near, 124, previous), undefined);
  assert.equal(map.getCell(queued).hp, 5);
  assert.equal(mining.update(near, 125, previous).result.hp, 4);
  assert.equal(mining.update(near, 249, previous), undefined);
  assert.equal(mining.update(near, 250, previous).result.hp, 3);
  assert.equal(map.getCell(previous).hp, 4);
});

test("release, reset and a long interruption each discard a queued first target", () => {
  const far = { col: 3, row: 25 };
  const near = { col: 4, row: 25 };
  const queued = { col: 5, row: 25 };
  const other = { col: 4, row: 24 };
  for (const cancel of [
    (mining) => mining.stop(),
    (mining) => mining.reset(),
    (mining) => assert.equal(mining.update(far, 600), undefined),
  ]) {
    const map = new TerrainMap();
    const mining = new MiningSession(map);
    assert.equal(mining.begin(far, queued, 0).result.reason, "out-of-reach");
    cancel(mining);
    assert.equal(mining.getTarget(near, other), null);
    assert.equal(mining.update(near, 620, other), undefined);
    assert.equal(map.getCell(queued).hp, 5);
    assert.equal(map.getCell(other).hp, 5);
    assert.equal(mining.begin(near, queued, 621).result.hp, 4);
  }
});

test("a queued tile that needs a better tool reports that reason on arrival and cancels", () => {
  const far = { col: 3, row: 25 };
  const near = { col: 4, row: 25 };
  const hard = { col: 5, row: 25 };
  const alternate = { col: 4, row: 24 };
  const layout = [...TEST_MAP_LAYOUT];
  const row = layout[hard.row];
  layout[hard.row] = row.slice(0, hard.col) + "2" + row.slice(hard.col + 1);
  const map = new TerrainMap(layout);
  let tool = 1;
  const mining = new MiningSession(map, MINING_CONFIG, () => tool);
  assert.equal(mining.begin(far, hard, 0).result.reason, "out-of-reach");
  assert.equal(mining.getTarget(near, alternate), null);
  assert.deepEqual(mining.update(near, 100, alternate), {
    target: hard, result: { effective: false, damage: 0, hp: 8, cleared: false, reason: "tool-level" },
  });
  tool = 2;
  assert.equal(mining.getTarget(near, alternate), null);
  assert.equal(mining.update(near, 110, alternate), undefined);
  assert.equal(map.getCell(hard).hp, 8);
  assert.equal(map.getCell(alternate).hp, 5);
  assert.equal(mining.begin(near, alternate, 110).result.hp, 4, "Rejected approach must not spend a cooldown");
});

test("a queued tile cleared by another action rejects the first approach without mining a substitute", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const far = { col: 3, row: 25 };
  const near = { col: 4, row: 25 };
  const queued = { col: 5, row: 25 };
  const alternate = { col: 4, row: 24 };
  assert.equal(mining.begin(far, queued, 0).result.reason, "out-of-reach");
  assert.equal(map.applyDigDamage(near, queued, 5).cleared, true);
  assert.equal(mining.getTarget(near, alternate), null);
  assert.equal(mining.update(near, 125, alternate).result.reason, "empty");
  assert.equal(mining.update(near, 250, alternate), undefined);
  assert.equal(map.getCell(alternate).hp, 5);
});

test("mining strikes immediately, then once per elapsed interval until the locked tile clears", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const hovered = { ...north };
  const start = 1_000;
  const initial = mining.begin(map.spawn, hovered, start);
  assert.deepEqual(initial, {
    target: north, result: { effective: true, damage: 1, hp: 4, cleared: false },
  });

  hovered.col = northeast.col;
  assert.equal(mining.update(map.spawn, start + attackIntervalMs - 1), undefined);
  for (const hp of [3, 2, 1, 0]) {
    const time = start + (4 - hp) * attackIntervalMs;
    assert.deepEqual(mining.update(map.spawn, time), {
      target: north, result: { effective: true, damage: 1, hp, cleared: hp === 0 },
    });
    assert.equal(mining.update(map.spawn, time), undefined);
  }
  assert.equal(mining.update(north, start + 5 * attackIntervalMs), undefined);
  assert.equal(map.getCell(northeast).hp, 5);
});

test("one hold can mine the aimed neighbor after clearing, with a shared cooldown", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const origin = { col: 13, row: 27 };
  const next = { col: 13, row: 26 };
  mining.begin(origin, northeast, 0);
  for (let time = attackIntervalMs; time <= clearAt; time += attackIntervalMs) {
    assert.deepEqual(mining.update(origin, time, next).target, northeast);
  }
  assert.equal(map.isWalkable(northeast), true);
  assert.equal(mining.update(origin, clearAt + attackIntervalMs - 1, next), undefined);
  assert.equal(map.getCell(next).hp, 5);

  const nextStrikeAt = clearAt + attackIntervalMs;
  assert.deepEqual(mining.update(origin, nextStrikeAt, next), {
    target: next, result: { effective: true, damage: 1, hp: 4, cleared: false },
  });
  assert.deepEqual(mining.update(origin, nextStrikeAt + attackIntervalMs, northeast).target, next);
  assert.equal(map.getCell(next).hp, 3);
});

test("after a clear, a hold can wait for a new aimed tile to come into reach", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  for (let time = attackIntervalMs; time <= clearAt; time += attackIntervalMs) {
    mining.update(map.spawn, time, north);
  }
  const ready = clearAt + attackIntervalMs;
  assert.equal(mining.update(map.spawn, ready, north), undefined);
  assert.equal(mining.update(map.spawn, ready + 1, northeast), undefined);
  assert.equal(map.getCell(northeast).hp, 5);
  assert.equal(mining.update(north, ready + 2, northeast).result.hp, 4);
});

test("a one-hit clear permits chaining, and releasing cancels further retargeting", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map, { damage: 5, attackIntervalMs });
  assert.equal(mining.begin(map.spawn, north, 0).result.cleared, true);
  assert.equal(mining.update(north, attackIntervalMs, northeast).result.cleared, true);
  mining.stop();

  const following = { col: 13, row: 26 };
  assert.equal(mining.update({ col: 13, row: 27 }, 2 * attackIntervalMs, following), undefined);
  assert.equal(map.getCell(following).hp, 5);
});

test("stopping a hold preserves damage until an explicit new press", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  mining.update(map.spawn, attackIntervalMs);
  mining.stop();
  assert.equal(mining.update(east, 2 * attackIntervalMs), undefined);
  assert.equal(mining.update(map.spawn, 3 * attackIntervalMs), undefined);
  assert.equal(map.getCell(north).hp, 3);
  const resumedAt = 4 * attackIntervalMs;
  assert.equal(mining.begin(map.spawn, north, resumedAt).result.hp, 2);
  assert.equal(mining.update(map.spawn, resumedAt + attackIntervalMs - 1), undefined);
  assert.equal(mining.update(map.spawn, resumedAt + attackIntervalMs).result.hp, 1);
});

test("leaving range between attack deadlines ends the hold even if the player returns", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  assert.equal(mining.update(east, attackIntervalMs / 2, northeast), undefined);
  assert.equal(mining.update(map.spawn, attackIntervalMs, north), undefined);
  assert.equal(mining.update(map.spawn, 2 * attackIntervalMs), undefined);
  assert.equal(map.getCell(north).hp, 4);
  assert.equal(map.getCell(northeast).hp, 5);

  assert.equal(mining.begin(east, north, 3 * attackIntervalMs).result.reason, "out-of-reach");
  assert.equal(mining.getTarget(east, northeast), null);
  assert.deepEqual(mining.getTarget(map.spawn, east), north);
  assert.equal(mining.update(map.spawn, 4 * attackIntervalMs).result.hp, 3);
});

test("30, 60, and 144 FPS each clear dirt at the fifth scheduled attack", () => {
  for (const fps of [30, 60, 144]) {
    const map = new TerrainMap();
    const mining = new MiningSession(map);
    let attacks = Number(mining.begin(map.spawn, north, 0).result.effective);
    for (let frame = 1; frame * 1_000 / fps < clearAt; frame += 1) {
      attacks += Number(mining.update(map.spawn, frame * 1_000 / fps)?.result.effective ?? false);
    }
    assert.equal(attacks, 4, `before the clearing deadline at ${fps} FPS`);
    assert.equal(map.getCell(north).hp, 1);
    assert.equal(mining.update(map.spawn, clearAt).result.cleared, true, `fifth attack at ${fps} FPS`);
  }
});

test("short frame stalls retain due attacks and the original cadence", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  assert.equal(mining.update(map.spawn, 0.8 * attackIntervalMs), undefined);
  assert.equal(mining.update(map.spawn, 2.1 * attackIntervalMs).result.hp, 2);
  assert.equal(mining.update(map.spawn, 3 * attackIntervalMs - 1), undefined);
  assert.equal(mining.update(map.spawn, 3 * attackIntervalMs).result.hp, 1);
  assert.equal(mining.update(map.spawn, clearAt).result.cleared, true);
});

test("a long pause stops the session without a backlog of attacks", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  mining.begin(map.spawn, north, 0);
  assert.equal(mining.update(map.spawn, 8_000), undefined);
  assert.equal(mining.update(map.spawn, 8_000 + attackIntervalMs), undefined);
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
  assert.equal(mining.update(map.spawn, attackIntervalMs / 5), undefined);
  mining.stop();
  assert.equal(mining.begin(map.spawn, north, attackIntervalMs / 3), undefined);
  assert.equal(map.getCell(north).hp, 4);
  assert.equal(mining.update(map.spawn, attackIntervalMs - 1), undefined);
  assert.deepEqual(mining.update(map.spawn, attackIntervalMs), {
    target: north, result: { effective: true, damage: 1, hp: 3, cleared: false },
  });
  assert.equal(mining.update(map.spawn, attackIntervalMs), undefined);
});

test("rapid independent presses cannot outpace a held attack", () => {
  const heldMap = new TerrainMap();
  const held = new MiningSession(heldMap);
  let heldHits = Number(held.begin(heldMap.spawn, north, 0).result.effective);
  for (let now = attackIntervalMs; now <= clearAt; now += attackIntervalMs) {
    heldHits += Number(held.update(heldMap.spawn, now)?.result.effective ?? false);
  }
  assert.equal(heldHits, 5);

  const alignedPressInterval = attackIntervalMs / 5;
  for (const pressInterval of [0.12 * attackIntervalMs, alignedPressInterval, 0.32 * attackIntervalMs]) {
    const map = new TerrainMap();
    const mining = new MiningSession(map);
    const origin = { col: 13, row: 27 };
    const targets = [northeast, { col: 13, row: 26 }];
    const effectiveTimes = [];
    for (let press = 0; press * pressInterval <= clearAt; press += 1) {
      const now = press * pressInterval;
      if (mining.begin(origin, targets[press % targets.length], now)?.result.effective) effectiveTimes.push(now);
      mining.stop();
    }
    assert.ok(effectiveTimes.length <= heldHits, `${pressInterval} ms presses must not outpace a hold`);
    for (let index = 1; index < effectiveTimes.length; index += 1) {
      assert.ok(effectiveTimes[index] - effectiveTimes[index - 1] >= attackIntervalMs,
        `effective strikes from ${pressInterval} ms presses must be at least ${attackIntervalMs} ms apart`);
    }
    assert.equal(targets.reduce((hp, target) => hp + map.getCell(target).hp, 0), 10 - effectiveTimes.length);
    if (pressInterval === alignedPressInterval) {
      assert.deepEqual(effectiveTimes, Array.from({ length: heldHits }, (_, hit) => hit * attackIntervalMs));
    }
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
  assert.equal(mining.begin(origin, hovered, attackIntervalMs / 2), undefined);
  hovered.col = northeast.col;
  hovered.row = northeast.row;
  assert.equal(map.getCell(target).hp, 5);
  assert.equal(mining.update(origin, attackIntervalMs - 1), undefined);
  assert.deepEqual(mining.update(origin, attackIntervalMs), {
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
  for (let time = attackIntervalMs; time < clearAt; time += attackIntervalMs) mining.update(origin, time);
  assert.equal(mining.update(origin, clearAt).result.cleared, true);
  assert.equal(map.revision, 1);

  assert.equal(mining.begin(origin, target, clearAt + 1), undefined);
  assert.equal(mining.update(origin, clearAt + attackIntervalMs - 1), undefined);
  assert.equal(map.getCell(target).hp, 5);
  mining.stop();
  assert.equal(mining.update(origin, clearAt + attackIntervalMs), undefined);
  assert.equal(mining.begin(origin, target, clearAt + 2 * attackIntervalMs).result.hp, 4);
  assert.equal(map.revision, 1);
});

test("invalid attempts preserve their reasons and do not refresh the tool deadline", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  const west = { col: 10, row: 28 };
  const outside = { col: 24, row: 28 };
  assert.equal(mining.begin(map.spawn, north, 0).result.hp, 4);
  mining.stop();
  assert.deepEqual(mining.begin(map.spawn, west, 0.4 * attackIntervalMs), {
    target: west,
    result: { effective: false, damage: 0, hp: null, cleared: false, reason: "rock" },
  });
  assert.equal(mining.begin(map.spawn, east, 0.6 * attackIntervalMs).result.reason, "empty");
  assert.equal(mining.begin(map.spawn, northeast, 0.8 * attackIntervalMs).result.reason, "out-of-reach");
  assert.equal(mining.begin(map.spawn, north, attackIntervalMs).result.hp, 3);
  mining.stop();
  const afterCooldown = 2 * attackIntervalMs;
  assert.equal(mining.begin(map.spawn, outside, afterCooldown).result.reason, "out-of-bounds");
  assert.equal(mining.begin(map.spawn, north, afterCooldown).result.hp, 2);
});

test("re-pressing during cooldown keeps equal held attack counts at 30, 60, and 144 FPS", () => {
  for (const fps of [30, 60, 144]) {
    const map = new TerrainMap();
    const mining = new MiningSession(map);
    let hits = Number(mining.begin(map.spawn, north, 0).result.effective);
    mining.stop();
    const repressedAt = attackIntervalMs / 3;
    assert.equal(mining.begin(map.spawn, north, repressedAt), undefined);
    for (let frame = Math.ceil(repressedAt * fps / 1_000); frame * 1_000 / fps < clearAt; frame += 1) {
      hits += Number(mining.update(map.spawn, frame * 1_000 / fps)?.result.effective ?? false);
    }
    assert.equal(hits, 4, `before the clearing deadline at ${fps} FPS`);
    assert.equal(map.getCell(north).hp, 1);
    assert.equal(mining.update(map.spawn, clearAt).result.cleared, true);
  }
});

test("reset clears the active hold and the tool cooldown for the next round", () => {
  const map = new TerrainMap();
  const mining = new MiningSession(map);
  assert.equal(mining.begin(map.spawn, north, 0).result.hp, 4);
  const resetAt = attackIntervalMs / 5;
  assert.equal(mining.begin(map.spawn, north, resetAt - 1), undefined);
  map.reset();
  mining.reset();
  assert.equal(mining.update(map.spawn, resetAt), undefined);
  assert.equal(mining.begin(map.spawn, north, resetAt).result.hp, 4);
  assert.equal(mining.update(map.spawn, resetAt + attackIntervalMs - 1), undefined);
  assert.equal(mining.update(map.spawn, resetAt + attackIntervalMs).result.hp, 3);
});

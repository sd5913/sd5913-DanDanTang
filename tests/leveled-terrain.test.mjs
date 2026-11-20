import assert from "node:assert/strict";
import test from "node:test";
import { MINING_CONFIG, TERRAIN_HP_BY_LEVEL } from "../src/mining-config.ts";
import { MiningSession } from "../src/mining.ts";
import { Player } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const spawn = { col: 11, row: 64 };
const advanced = { col: 11, row: 63 };
const laterAdvanced = { col: 11, row: 31 };
const ordinary = { col: 12, row: 64 };
const rock = { col: 10, row: 64 };
const interval = MINING_CONFIG.attackIntervalMs;

function leveledMap() {
  const layout = Array.from({ length: 96 }, (_, row) => Array.from({ length: 24 }, (_, col) => {
    if (col === 0 || col === 23 || row === 0 || row === 95) return "#";
    if (col === 11 && row === 64) return "S";
    if (col === 11 && (row === 63 || row === 31)) return "2";
    if (col === 12 && row === 64) return "+";
    if (col === 10 && row === 64) return "#";
    return ".";
  }).join(""));
  return new TerrainMap(layout);
}

function walkTo(player, map, target) {
  const horizontal = Math.sign(target.col - player.cell.col);
  const vertical = Math.sign(target.row - player.cell.row);
  const distance = Math.abs(target.col - player.cell.col) + Math.abs(target.row - player.cell.row);
  for (let step = 0; step < distance * 8; step += 1) {
    if (player.cell.col === target.col && player.cell.row === target.row) break;
    player.move(horizontal, vertical, 50, map);
  }
  assert.deepEqual(player.cell, target);
}

test("dirt level controls tool access and HP while permanent rock ignores upgrades", () => {
  const map = leveledMap();
  assert.deepEqual(TERRAIN_HP_BY_LEVEL, { 1: 5, 2: 8 });
  assert.equal(map.getCell(ordinary).terrainLevel, 1);
  assert.equal(map.getCell(ordinary).maxHp, 5);
  const original = map.getCell(advanced);
  assert.deepEqual(original, { terrain: "dirt", terrainLevel: 2, hp: 8, maxHp: 8, buildingId: null });
  for (const level of [undefined, 0, 1, 1.5, NaN, Infinity]) {
    assert.equal(map.getDigFailure(spawn, advanced, level), "tool-level");
    assert.deepEqual(map.applyDigDamage(spawn, advanced, 5, level), {
      effective: false, reason: "tool-level", damage: 0, hp: 8, cleared: false,
    });
  }
  assert.equal(map.getCell(advanced), original);
  assert.equal(map.revision, 0);
  assert.equal(map.getDigFailure(spawn, rock, 2), "rock");
  assert.deepEqual(map.applyDigDamage(spawn, rock, 100, 99), {
    effective: false, reason: "rock", damage: 0, hp: null, cleared: false,
  });
  assert.equal(map.getCell(rock).terrainLevel, 1);
  assert.equal(map.getDigFailure(spawn, ordinary), undefined);
  assert.equal(map.getDigFailure(spawn, advanced, 2), undefined);

  for (let hp = 7; hp > 0; hp -= 1) {
    assert.deepEqual(map.applyDigDamage(spawn, advanced, 1, 2), { effective: true, damage: 1, hp, cleared: false });
    assert.equal(map.getCell(advanced).maxHp, 8);
    assert.equal(map.isWalkable(advanced), false);
    assert.equal(map.revision, 0);
  }
  assert.deepEqual(map.applyDigDamage(spawn, advanced, 5, 2), { effective: true, damage: 1, hp: 0, cleared: true });
  assert.equal(map.getCell(advanced).terrainLevel, 0);
  assert.equal(map.isWalkable(advanced), true);
  assert.equal(map.revision, 1);
});

test("partial level-2 durability survives player traversal across both seams and resets with the map", () => {
  const map = leveledMap();
  const player = new Player(map.spawn);
  assert.equal(map.applyDigDamage(player.cell, advanced, 3, 2).hp, 5);
  assert.equal(map.revision, 0);
  assert.equal(map.applyDigDamage(player.cell, ordinary, 5).cleared, true);
  // Move far enough east that the collision box no longer overlaps column 11.
  const bypass = { col: 13, row: 64 };
  walkTo(player, map, bypass);
  walkTo(player, map, { col: bypass.col, row: 30 });
  assert.equal(map.worldToChunk(player.cell).chunk.chunkRow, 0);
  walkTo(player, map, bypass);
  assert.equal(map.worldToChunk(player.cell).chunk.chunkRow, 2);
  assert.deepEqual(map.getCell(advanced), { terrain: "dirt", terrainLevel: 2, hp: 5, maxHp: 8, buildingId: null });
  assert.equal(map.getCell(laterAdvanced).hp, 8);
  assert.equal(map.isWalkable(advanced), false);
  assert.equal(map.isWalkable(ordinary), true);

  map.reset();
  assert.equal(map.getCell(advanced).hp, 8);
  assert.equal(map.getCell(laterAdvanced).terrainLevel, 2);
  assert.equal(map.getCell(ordinary).hp, 5);
  assert.equal(map.getCell(rock).terrain, "rock");
  assert.equal(map.revision, 2);
});

test("pressing a higher-level tile before upgrade spends no cooldown and a ready upgrade retains the old deadline", () => {
  const map = leveledMap();
  let level = 1;
  const mining = new MiningSession(map, MINING_CONFIG, () => level);
  assert.equal(mining.begin(spawn, ordinary, 0).result.hp, 4);
  assert.equal(mining.begin(spawn, advanced, interval / 4).result.reason, "tool-level");
  assert.equal(map.getCell(advanced).hp, 8);
  level = 2;
  assert.equal(mining.begin(spawn, advanced, interval / 2), undefined);
  assert.equal(mining.update(spawn, interval - 1), undefined);
  assert.equal(mining.update(spawn, interval).result.hp, 7);
  assert.equal(mining.update(spawn, interval * 2).result.hp, 6);
  level = 1;
  assert.equal(mining.update(spawn, interval * 3), undefined);
  assert.equal(map.getCell(advanced).hp, 6);
  level = 2;
  assert.equal(mining.begin(spawn, advanced, interval * 3).result.hp, 5);
});

test("a chained hold waits for the current tool upgrade and continues with one shared cadence", () => {
  const map = leveledMap();
  let level = 1;
  const mining = new MiningSession(map, MINING_CONFIG, () => level);
  assert.equal(mining.begin(spawn, ordinary, 0).result.hp, 4);
  for (let hit = 1; hit <= 4; hit += 1) {
    const strike = mining.update(spawn, interval * hit, advanced);
    assert.deepEqual(strike.target, ordinary);
    assert.equal(strike.result.hp, 4 - hit);
  }
  assert.equal(mining.update(spawn, interval * 5 - 1, advanced), undefined);
  assert.equal(mining.update(spawn, interval * 5, advanced), undefined);
  assert.equal(map.getCell(advanced).hp, 8);
  level = 2;
  const upgradedAt = interval * 5 + 1;
  assert.equal(mining.update(spawn, upgradedAt, advanced).result.hp, 7);
  assert.equal(mining.update(spawn, upgradedAt + interval - 1, advanced), undefined);
  assert.equal(mining.update(spawn, upgradedAt + interval, advanced).result.hp, 6);
});

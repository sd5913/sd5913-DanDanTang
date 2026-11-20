import assert from "node:assert/strict";
import test from "node:test";
import { DIFFICULTY_PROFILES, readDifficulty, wavePopulation } from "../src/expedition-difficulty.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { generateExpeditionMap } from "../src/generated-map.ts";
import { TerrainMap } from "../src/terrain.ts";

test("Challenge starts and resets with zero resources, one technology facility and a level-one tool", () => {
  assert.equal(readDifficulty("challenge"), "challenge");
  const map = new TerrainMap(generateExpeditionMap(12));
  const economy = new ExpeditionEconomy(map, 12, undefined, "challenge");

  function assertStartingResources() {
    assert.equal(economy.balance, 0);
    assert.deepEqual(economy.cards, { wall: 0, tower: 0, economy: 0 });
    assert.equal(economy.toolLevel, 1);
    assert.equal(economy.hasTechnology, true);
    assert.deepEqual([...map.getBuildings()].map((item) => item.kind), ["technology"]);
    assert.equal(map.getBuilding(ECONOMY_PROTOTYPE.technologyCell).hp, 10);
    assert.equal(economy.drawFailure, "insufficient-funds");
  }

  assertStartingResources();
  economy.handleEvent({ type: "towerKill", enemyId: 1, towerId: "tower" });
  assert.equal(economy.balance, 2);
  map.reset();
  economy.reset();
  assertStartingResources();
});

test("Baseline, A and B keep the original starting funds, cards, tool and technology", () => {
  for (const profile of ["baseline", "a", "b"]) {
    const map = new TerrainMap(generateExpeditionMap(12));
    const economy = new ExpeditionEconomy(map, 12, undefined, profile);
    assert.equal(economy.balance, 8);
    assert.deepEqual(economy.cards, { wall: 4, tower: 2, economy: 1 });
    assert.equal(economy.toolLevel, 1);
    assert.deepEqual([...map.getBuildings()].map((item) => item.kind), ["technology"]);
  }
});

test("the Challenge first wave releases eight at 60 seconds, recovers for 20 and inherits B thereafter", () => {
  const round = new ExpeditionRound(false, "challenge");
  const strength = { enemyHp: 4, wallDamage: 1, contactDamage: 1 };
  assert.equal(round.remainingMs, 60_000);
  assert.deepEqual(round.upcoming, { count: 8, ...strength });
  assert.equal(round.update(59_999, 92, 0, 0), undefined);
  assert.deepEqual(round.update(1, 92, 0, 0), { count: 8, ...strength });
  assert.equal(round.remainingMs, DIFFICULTY_PROFILES.b.normal.attackTimeoutMs);
  round.update(1, 92, 0, 0);
  assert.equal(round.phase, "recovering");
  assert.equal(round.remainingMs, 20_000);
  assert.equal(round.update(19_999, 92, 0, 0), undefined);
  assert.deepEqual(round.update(1, 92, 0, 0), { count: 16, ...strength });
  assert.deepEqual(DIFFICULTY_PROFILES.challenge.stages, DIFFICULTY_PROFILES.b.stages);
  for (let wave = 2; wave <= 20; wave += 1) {
    assert.equal(wavePopulation("challenge", wave, 0), wavePopulation("b", wave, 0));
  }
  round.reset();
  assert.equal(round.difficulty, "challenge");
  assert.equal(round.remainingMs, 60_000);
  assert.equal(round.upcoming.count, 8);
});

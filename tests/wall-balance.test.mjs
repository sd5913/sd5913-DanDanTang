import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CHALLENGE_BUILDING_BALANCE, readBuildingBalance } from '../src/building-balance.ts';
import { runWallBalanceExperiment } from './wall-balance.mjs';

const expectedHp = { control: 50, w35: 35, w25: 25, w15: 15 };
const results = runWallBalanceExperiment();
const pick = (profile, strategy) => results.find((run) => run.buildingBalance === profile && run.strategy === strategy);

test('Challenge defaults to W25 and four paired conditions use real paid placement with identical inputs', () => {
  assert.equal(DEFAULT_CHALLENGE_BUILDING_BALANCE, 'w25');
  assert.equal(readBuildingBalance(null), 'w25');
  assert.equal(readBuildingBalance('bad-value'), 'w25');
  assert.equal(results.length, 20);
  const costs = { 'wall-only': 3, 'wall-and-tower': 6, 'wall-and-producer': 9, 'long-wall': 3, 'long-bypass': 3 };
  for (const run of results) {
    assert.equal(readBuildingBalance(run.buildingBalance.toUpperCase()), run.buildingBalance);
    assert.equal(run.initialWallHp, expectedHp[run.buildingBalance]);
    assert.equal(run.inputHash, pick('control', run.strategy).inputHash);
    assert.ok(run.setupFinishedAtMs < 60_000);
    assert.equal(run.opening.economy.technologySpend, 10);
    assert.equal(run.opening.economy.cardSpend, costs[run.strategy]);
    assert.equal(run.opening.economy.miningIncome, 10 + costs[run.strategy]);
    assert.equal(run.opening.economy.killIncome, 0);
    assert.equal(run.waves[0].opening.atMs, 60_000);
    assert.deepEqual(run.waves[0].order, { count: 8, enemyHp: 4, wallDamage: 1, contactDamage: 1 });
  }
});

test('actual wall impacts consume each enemy once and damage and destruction are reconciled by wave', () => {
  for (const run of results) {
    assert.equal(new Set(run.impacts.map(({ enemyId }) => enemyId)).size, run.impacts.length);
    assert.equal(run.initialWallHp - run.final.wallHp, run.impacts.reduce((total, impact) => total + impact.damage, 0));
    assert.equal(run.losses.filter(({ kind }) => kind === 'wall').length, Number(run.firstBreach !== null));
    for (const wave of run.waves) {
      const impacts = run.impacts.filter(({ waveId }) => waveId === wave.waveId);
      assert.equal(wave.combat.wallImpacts, impacts.length);
      assert.equal(wave.combat.wallDamage, impacts.reduce((total, impact) => total + impact.damage, 0));
      assert.equal(wave.combat.planned, wave.combat.pending + wave.combat.spawned + wave.combat.cancelledPending);
      assert.equal(wave.combat.spawned, wave.combat.active + wave.combat.playerContacts + wave.combat.wallImpacts
        + wave.combat.towerKills + wave.combat.cancelledActive);
      assert.equal(wave.economy.cohortKillIncome, wave.combat.towerKills * 2);
      assert.ok(wave.attackEnd);
    }
  }
});

test('lower wall durability gives earlier measured breaches while every profile survives wave one', () => {
  const runs = Object.keys(expectedHp).map((profile) => pick(profile, 'wall-only'));
  assert.deepEqual(runs.map((run) => run.waves[0].attackEnd.wallHp), [42, 27, 17, 7]);
  assert.deepEqual(runs.map((run) => run.firstBreach?.waveId ?? null), [null, 3, 3, 2]);
  assert.equal(runs[0].final.wallHp, 2);
  assert.ok(runs[2].firstBreach.atMs < runs[1].firstBreach.atMs);
  assert.equal(runs[2].firstBreach.hp, 0);
});

test('long arrival and a routed bypass are measured from actual live enemy movement', () => {
  for (const profile of Object.keys(expectedHp)) {
    const direct = pick(profile, 'wall-only');
    const long = pick(profile, 'long-wall');
    const bypass = pick(profile, 'long-bypass');
    assert.ok(long.firstContactAtMs > direct.firstContactAtMs);
    assert.equal(long.bypasses.length, 0);
    assert.ok(bypass.bypasses.length > 0);
    assert.equal(new Set(bypass.bypasses.map(({ enemyId }) => enemyId)).size, bypass.bypasses.length);
    assert.ok(bypass.bypasses.every(({ enemyId, waveId }) =>
      waveId > 0 && !bypass.impacts.some((impact) => impact.enemyId === enemyId)));
    assert.equal(bypass.waves[0].attackEnd.wallHp, expectedHp[profile]);
  }
});

test('the fixed tower and paid producer provide independently recorded income', () => {
  for (const profile of Object.keys(expectedHp)) {
    const tower = pick(profile, 'wall-and-tower');
    const producer = pick(profile, 'wall-and-producer');
    assert.ok(tower.final.economy.killIncome > 0);
    assert.ok(producer.final.economy.productionIncome > 0);
    assert.equal(producer.final.economy.killIncome, 0);
    assert.equal(producer.opening.cards.tower, 1);
  }
});

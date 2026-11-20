import assert from 'node:assert/strict';
import test from 'node:test';
import { ExpeditionEconomy } from '../src/expedition-economy.ts';
import { CHUNK_ROWS, TerrainMap } from '../src/terrain.ts';
import { WaveEconomyHistory } from '../src/wave-economy-history.ts';

const width = 24;
const dirtPerRow = width - 2;
const technology = { col: 18, row: 25 };
const relocation = { col: 20, row: 25 };
const damagePerTile = 5;
const towerKill = (enemyId) => ({ type: 'towerKill', enemyId, towerId: 'test-tower' });

function fixture(experiment = {}, difficulty = 'challenge', seed = 1091) {
  const layout = Array.from({ length: CHUNK_ROWS }, (_, row) => {
    if (row === 1) return '..S' + '.'.repeat(width - 3);
    if (row >= 2 && row <= 22 && row % 2 === 0) return '.' + '+'.repeat(dirtPerRow) + '.';
    return '.'.repeat(width);
  });
  const map = new TerrainMap(layout);
  const economy = new ExpeditionEconomy(map, seed, technology, difficulty, experiment);
  let minedHp = 0;

  function mine(coins) {
    let remainingHp = Math.round(coins * 10);
    while (remainingHp > 0) {
      const tile = Math.floor(minedHp / damagePerTile);
      const col = 1 + tile % dirtPerRow;
      const row = 2 + 2 * Math.floor(tile / dirtPerRow);
      const damage = Math.min(remainingHp, damagePerTile - minedHp % damagePerTile);
      const strike = map.applyDigDamage({ col, row: row - 1 }, { col, row }, damage);
      assert.equal(strike.damage, damage);
      assert.equal(economy.creditMiningDamage(strike.damage), damage / 10);
      remainingHp -= damage;
      minedHp += damage;
    }
  }

  function buyTechnology(site = technology) {
    mine(10);
    assert.ok(economy.buildTechnology(site));
  }

  function purchase() {
    mine(economy.drawCost);
    const card = economy.drawCard();
    assert.ok(card);
    return card;
  }

  function reset() {
    map.reset();
    economy.reset();
    minedHp = 0;
  }

  return { map, economy, mine, buyTechnology, purchase, reset };
}

function manufactureState(economy) {
  return { totals: economy.totals, cards: economy.cards, nextCost: economy.drawCost };
}

test('tiered manufacture pays exactly 3, 6, then 9 and preserves the seeded card stream', () => {
  const tiered = fixture({ tieredCraft: true });
  const control = fixture();
  tiered.buyTechnology();
  control.buyTechnology();

  const draws = [];
  let totalCost = 0;
  for (const [index, cost] of [3, 3, 3, 6, 6, 6, 6, 6, 9, 9].entries()) {
    assert.equal(tiered.economy.drawCost, cost);
    tiered.mine(cost - 0.1);
    const beforeFailure = manufactureState(tiered.economy);
    assert.equal(tiered.economy.drawFailure, 'insufficient-funds');
    assert.equal(tiered.economy.drawCard(), undefined);
    assert.deepEqual(manufactureState(tiered.economy), beforeFailure);
    tiered.mine(0.1);
    assert.equal(tiered.economy.balance, cost);
    assert.equal(tiered.economy.drawFailure, undefined);
    const card = tiered.economy.drawCard();
    assert.equal(card, control.purchase());
    draws.push(card);
    totalCost += cost;
    assert.equal(tiered.economy.balance, 0);
    assert.equal(tiered.economy.totals.cardsMade, index + 1);
    assert.equal(tiered.economy.totals.cardSpend, totalCost);
    assert.equal(Object.values(tiered.economy.cards).reduce((sum, count) => sum + count, 0), index + 1);
  }
  assert.deepEqual(draws.slice(0, 3), ['economy', 'economy', 'tower']);
  assert.equal(tiered.economy.totals.cardSpend, 57);
  assert.equal(control.economy.totals.cardSpend, 30);
});

test('facility loss and paid relocation preserve pity, price progress, and research until reset', () => {
  const run = fixture({ tieredCraft: true });
  const { map, economy } = run;
  assert.equal(economy.drawCost, 3);
  assert.equal(economy.drawFailure, 'technology-missing');
  assert.equal(economy.drawCard(), undefined);
  run.buyTechnology();
  run.mine(20);
  assert.ok(economy.researchTool());
  assert.deepEqual([run.purchase(), run.purchase()], ['economy', 'economy']);

  run.mine(3);
  assert.ok(map.removeBuilding(technology));
  const beforeFailure = manufactureState(economy);
  assert.equal(economy.drawFailure, 'technology-destroyed');
  assert.equal(economy.drawCard(), undefined);
  assert.deepEqual(manufactureState(economy), beforeFailure);
  run.buyTechnology(relocation);
  assert.equal(economy.totals.technologySpend, 20);
  assert.equal(economy.toolLevel, 2);
  assert.equal(economy.drawCard(), 'tower');
  assert.equal(economy.drawCost, 6);

  for (let index = 0; index < 5; index += 1) run.purchase();
  assert.equal(economy.drawCost, 9);
  assert.ok(map.removeBuilding(relocation));
  run.buyTechnology(technology);
  assert.equal(economy.totals.cardsMade, 8);
  assert.equal(economy.drawCost, 9);
  run.purchase();
  assert.equal(economy.totals.cardSpend, 48);

  run.reset();
  assert.deepEqual(economy.cards, { wall: 0, tower: 0, economy: 0 });
  assert.equal(economy.totals.cardsMade + economy.totals.cardSpend + economy.balance, 0);
  assert.equal(economy.drawCost, 3);
  assert.equal(economy.toolLevel, 1);
  assert.equal(economy.hasTechnology, false);
  run.buyTechnology();
  assert.deepEqual([run.purchase(), run.purchase(), run.purchase()], ['economy', 'economy', 'tower']);
  const nextRound = fixture({ tieredCraft: true }, 'challenge', 12);
  assert.equal(nextRound.economy.drawCost, 3);
  assert.equal(nextRound.economy.totals.cardsMade, 0);
});

test('kill decay follows the spawn wave across rollover and records actual income once', () => {
  const run = fixture({ killDecay: true });
  const { economy } = run;
  const history = new WaveEconomyHistory(economy.totals);
  function kill(enemyId, waveId) {
    const credit = economy.handleEvent(towerKill(enemyId), waveId);
    history.creditKill(waveId, credit);
    return credit;
  }

  history.startWave(1, economy.totals);
  for (let enemyId = 1; enemyId <= 8; enemyId += 1) assert.equal(kill(enemyId, 1), 2);
  assert.equal(kill(9), 2, 'Debug spawns use the flat reward and do not consume a wave allowance');
  history.startWave(2, economy.totals);
  assert.equal(kill(10, 1), 1, 'A late death uses the spawn wave’s exhausted allowance');
  assert.equal(kill(11, 2), 2, 'New waves have a fresh allowance');
  assert.equal(kill(10, 2), 0, 'Changing a duplicate notification’s cohort cannot pay twice');
  assert.equal(economy.handleEvent({ type: 'wallImpact', enemyId: 20, wallId: 'wall', damage: 2,
    hp: 23, destroyed: false }, 2), 0);
  for (let enemyId = 12; enemyId <= 18; enemyId += 1) assert.equal(kill(enemyId, 2), 2);
  assert.equal(kill(19, 2), 1);
  assert.equal(kill(21), 2);
  assert.equal(economy.balance, 38);
  assert.equal(economy.totals.killIncome, 38);
  assert.deepEqual(history.snapshot(economy.totals).slice(1).map((wave) => ({
    period: wave.waveId, open: wave.openingBalance, balance: wave.balance,
    cashKills: wave.killIncome, creditedForCohort: wave.cohortKillIncome,
  })), [
    { period: 1, open: 0, balance: 18, cashKills: 18, creditedForCohort: 17 },
    { period: 2, open: 18, balance: 38, cashKills: 20, creditedForCohort: 17 },
  ]);

  run.reset();
  history.reset(economy.totals);
  history.startWave(1, economy.totals);
  assert.equal(kill(1, 1), 2, 'Reset clears both old enemy IDs and old wave allowances');
  assert.equal(history.snapshot(economy.totals)[1].cohortKillIncome, 2);
});

test('economy experiments can be enabled independently and only affect Challenge', () => {
  const tiered = fixture({ tieredCraft: true });
  const decay = fixture({ killDecay: true });
  for (let enemyId = 1; enemyId <= 9; enemyId += 1) {
    assert.equal(tiered.economy.handleEvent(towerKill(enemyId), 1), 2);
    assert.equal(decay.economy.handleEvent(towerKill(enemyId), 1), enemyId === 9 ? 1 : 2);
  }
  for (const run of [tiered, decay]) {
    assert.ok(run.economy.buildTechnology(technology));
    for (let draw = 0; draw < 3; draw += 1) {
      if (run.economy.balance < 3) run.mine(3 - run.economy.balance);
      assert.ok(run.economy.drawCard());
    }
  }
  assert.equal(tiered.economy.drawCost, 6);
  assert.equal(decay.economy.drawCost, 3);

  for (const difficulty of ['baseline', 'a', 'b']) {
    const { economy } = fixture({ tieredCraft: true, killDecay: true }, difficulty);
    for (let enemyId = 1; enemyId <= 10; enemyId += 1) assert.equal(economy.handleEvent(towerKill(enemyId), 1), 2);
    for (let draw = 0; draw < 9; draw += 1) {
      assert.equal(economy.drawCost, 3);
      assert.ok(economy.drawCard());
    }
    assert.equal(economy.totals.cardSpend, 27);
    assert.equal(economy.totals.killIncome, 20);
  }
});

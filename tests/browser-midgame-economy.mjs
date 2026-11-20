import assert from 'node:assert/strict';
import { advanceUntil, openChallenge, readRound, startFirstWave } from './browser-challenge.mjs';
import { OpeningRun } from './challenge-opening.mjs';
import { GENERATED_SPAWN } from '../src/generated-map.ts';

const cell = (col, row) => ({ col, row });

async function assertPrice(run, cost) {
  assert.equal(await run.maker.textContent(), `制造卡牌（${cost} 经济）`);
}

export async function runMidgameTierSmoke(page, baseUrl) {
  const seed = 1091;
  const run = await openChallenge(page, baseUrl, seed, 'w25', 'tier');
  const feedback = page.locator('#expedition-feedback');
  const reason = page.locator('#card-draw-reason');
  await assertPrice(run, 3);
  await run.mineOpening();
  const first = await run.draw('economy');
  await run.mineTo(6);
  const second = await run.draw('economy');
  await assertPrice(run, 3);
  const third = await run.draw('tower');
  assert.equal(await run.cash(), '0.0');
  await assertPrice(run, 6);
  assert.equal(await feedback.textContent(), '下次制造费用升至 6 经济');
  assert.equal(await reason.textContent(), '经济不足，需要 6 经济');
  await run.attemptUnaffordableDraw();

  await run.mineTo(6);
  const fourth = await run.draw('economy');
  assert.equal(await run.cash(), '0.0');
  await page.clock.runFor(216);
  const round = await readRound(page);
  const ledger = round.economy.find(({ waveId }) => waveId === 0);
  assert.deepEqual([ledger.cardsMade, ledger.cardSpend, ledger.technologySpend, ledger.miningIncome], [4, 15, 10, 25]);

  await run.reset();
  await assertPrice(run, 3);
  await page.clock.resume();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get('seed') !== String(seed)),
    page.locator('#new-round').click(),
  ]);
  await page.waitForFunction(() => document.getElementById('round-state').dataset.phase === 'preparing');
  assert.equal(await page.locator('#midgame-experiment').inputValue(), 'tier');
  await assertPrice(run, 3);
  assert.equal(await run.cash(), '0.0');
  assert.ok(await run.maker.isDisabled());
  return { seed, cards: [first, second, third, fourth], paid: [3, 3, 3, 6], cardSpend: ledger.cardSpend,
    failedPurchaseUndebited: true, resetPrice: 3, newRoundPrice: 3 };
}

export async function preparePaidTowers(page, baseUrl, experiment, columns, merge = false) {
  const seed = 515;
  const run = await openChallenge(page, baseUrl, seed, 'w25', experiment);
  const route = new OpeningRun(seed, 'challenge', 'w25');
  let appliedMining = 0;
  async function followMiningPlan() {
    for (const step of route.miningActions.slice(appliedMining)) {
      await run.returnTo(step.from);
      await run.mine(step.target);
    }
    appliedMining = route.miningActions.length;
  }

  // Replay the opening's terrain actions as actual clicks and movements in Edge.
  let preparationSpendTenths = route.fundFacility();
  await followMiningPlan();
  await run.returnTo(route.facility.from);
  await run.buildTechnology(route.facility.target);
  const prices = experiment === 'tier' ? [3, 3, 3, 6] : [3, 3, 3, 3];
  for (const price of prices) {
    preparationSpendTenths += price * 10;
    assert.ok(route.mineToIncome(preparationSpendTenths));
    await followMiningPlan();
    await assertPrice(run, price);
    await run.draw('tower');
  }
  assert.equal(await run.cash(), '0.0');
  for (const [index, col] of columns.entries()) {
    await run.returnTo(cell(col, 92));
    await run.place('tower', cell(col, 91), { merge: merge && index === columns.length - 1 });
  }
  return run;
}

async function placePaidMergedTower(page, baseUrl, experiment) {
  const run = await preparePaidTowers(page, baseUrl, experiment, [25, 26, 27, 28], true);
  await run.returnTo(cell(25, 92));
  await run.game.inspect(cell(25, 91), '空地');
  await page.clock.runFor(32);
  assert.match(await run.building.textContent(), /防御塔 \(25, 91\).*1 HP · Lv\.2/);
  await run.returnTo(GENERATED_SPAWN);
  return run;
}

export async function runMidgameTierLateSmoke(page, baseUrl) {
  const seed = 515;
  const run = await placePaidMergedTower(page, baseUrl, 'tier');
  await startFirstWave(page, run.start);
  const first = await advanceUntil(page, (round) => round.wave === 1 && round.phase === 'recovering',
    'The paid turret must fund the first recovery', 8_000);
  assert.equal(first.combat[0].towerKills, 8);
  assert.equal(await run.cash(), '16.0');
  await assertPrice(run, 6);
  await run.draw('economy');
  await run.draw('tower');
  const later = await advanceUntil(page, (round) => round.combat[1]?.towerKills >= 9,
    'The second wave must fund the remaining purchases', 30_000);
  await assertPrice(run, 6);
  await run.draw('economy');
  await run.draw('wall');
  await assertPrice(run, 9);
  assert.equal(await page.locator('#expedition-feedback').textContent(), '下次制造费用升至 9 经济');
  const before = Number(await run.cash());
  await run.draw('economy');
  const after = Number(await run.cash());
  assert.equal(before - after, 9);
  await page.clock.runFor(216);
  const { economy } = await readRound(page);
  assert.deepEqual(economy.map(({ cardsMade, cardSpend }) => [cardsMade, cardSpend]), [[4, 15], [2, 12], [3, 21]]);
  return { seed, cardsMade: 9, cardSpend: 48, ninthCost: 9, before, after,
    secondWaveKills: later.combat[1].towerKills, hp: later.hp };
}

export async function runMidgameDecaySmoke(page, baseUrl) {
  const seed = 515;
  const run = await placePaidMergedTower(page, baseUrl, 'kill-decay');
  await assertPrice(run, 3);
  await startFirstWave(page, run.start);
  const first = await advanceUntil(page, (round) => round.wave === 1 && round.phase === 'recovering',
    'The actual merged tower must finish wave one', 8_000);
  const waveOne = first.combat[0];
  assert.equal(waveOne.towerKills, 8);
  assert.equal(first.economy.find(({ waveId }) => waveId === 1).cohortKillIncome, 16);
  assert.equal(await run.cash(), '16.0');

  const later = await advanceUntil(page, (round) => round.combat[1]?.towerKills >= 9,
    'The second cohort must provide at least one reduced payout', 30_000);
  const waveTwo = later.combat[1];
  const ledger = later.economy.find(({ waveId }) => waveId === 2);
  assert.equal(ledger.cohortKillIncome, 16 + (waveTwo.towerKills - 8));
  assert.equal(ledger.killIncome, ledger.cohortKillIncome);
  assert.equal(ledger.balance, 16 + ledger.cohortKillIncome);
  assert.equal(waveTwo.towerHitsOnKills, waveTwo.towerKills);
  assert.equal(ledger.cardsMade, 0);
  return { seed, tower: { col: 25, row: 91, level: 2 }, first: { kills: waveOne.towerKills, reward: 16 },
    second: { kills: waveTwo.towerKills, reward: ledger.cohortKillIncome }, paidCraftCost: 3,
    balance: ledger.balance, hp: later.hp };
}

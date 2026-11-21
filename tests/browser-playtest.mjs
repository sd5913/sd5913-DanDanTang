import assert from 'node:assert/strict';
import { GENERATED_SPAWN } from '../src/generated-map.ts';
import { readCardInventory } from './browser-card-feedback.mjs';
import { advanceUntil, openChallenge, runChallengeLossSmoke, startFirstWave } from './browser-challenge.mjs';
import { preparePaidEvolvedTower } from './browser-tower-evolution.mjs';

const experimentControls = ['#round-difficulty', '#challenge-balance', '#midgame-experiment'];
const emptyCards = { wall: 0, tower: 0, economy: 0 };
const firstDirt = { col: 19, row: 93 };

function currentSeed(page) {
  const value = new URL(page.url()).searchParams.get('seed');
  assert.match(value ?? '', /^\d+$/);
  const seed = Number(value);
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff);
  return seed;
}

async function assertFreshPlaytest(page, seed) {
  await page.waitForFunction(() => document.querySelector('#round-state')?.dataset.phase === 'preparing'
    && Number(document.querySelector('#visible-chunks')?.dataset.worldWidth) > 0);
  assert.equal(currentSeed(page), seed);
  assert.ok((await page.locator('#map-size').textContent()).includes('40 × 96 · 种子 ' + seed));
  assert.equal(await page.locator('#round-time').textContent(), '60 秒');
  assert.equal(await page.locator('#round-wave').textContent(), '0');
  assert.equal(await page.locator('#round-next-count').textContent(), '8 只');
  assert.equal(await page.locator('#player-hp').textContent(), '4');
  assert.equal(await page.locator('#player-cell').textContent(), `(${GENERATED_SPAWN.col}, ${GENERATED_SPAWN.row})`);
  assert.equal(await page.locator('#economy-balance').textContent(), '0.0');
  assert.equal(await page.locator('#tool-level').textContent(), 'Lv.1');
  assert.deepEqual(await readCardInventory(page), emptyCards);
  assert.equal(await page.locator('#make-card').textContent(), '制造卡牌（3 经济）');
  assert.ok(await page.locator('#make-card').isDisabled());
  assert.equal(await page.locator('#card-draw-reason').textContent(), '请先建造科技设施');
  for (const selector of [...experimentControls, '#defense-panel', '#expedition-debug']) {
    assert.ok(await page.locator(selector).isHidden(), `The public build cannot expose ${selector}`);
  }
  assert.ok(await page.locator('#new-round').isVisible());
  assert.ok(await page.locator('#retry-round').isVisible());
  assert.ok(await page.locator('#merge-controls').isHidden());
}

export async function runPlaytestSmoke(page, baseUrl) {
  assert.equal((await page.goto(new URL('/', baseUrl).href))?.status(), 200);
  await page.waitForURL((url) => url.searchParams.has('seed'));
  await assertFreshPlaytest(page, currentSeed(page));

  const seed = 9;
  const oldExperimentUrl = '/?mode=defense&map=single&difficulty=baseline&build=w15&midgame=control'
    + '&speed=test&fog=off&debug=1&diagnostics=1';
  const run = await openChallenge(page, baseUrl, seed, undefined, undefined, { playtestUrl: oldExperimentUrl });
  await assertFreshPlaytest(page, seed);
  await run.game.settleView();
  await run.game.aimAt({ col: 11, row: 88 });
  await page.clock.runFor(3_000);
  assert.equal(await page.locator('#hover-cell').getAttribute('data-visibility'), 'unknown');
  assert.equal(await page.locator('#round-wave').textContent(), '0');
  assert.equal(await page.locator('#round-state').getAttribute('data-phase'), 'preparing');

  const paid = [];
  async function buyWall(expectedCost) {
    assert.equal(await run.maker.textContent(), `制造卡牌（${expectedCost} 经济）`);
    const cashBefore = Number(await run.cash());
    await run.draw('wall');
    paid.push(cashBefore - Number(await run.cash()));
  }

  await run.mineOpening({ inspectPartial: true });
  await buyWall(3);
  const wall = { col: 24, row: 94 };
  await run.returnTo({ col: 23, row: 94 });
  await run.place('wall', wall);
  await run.game.inspect(wall, '空地');
  await page.clock.runFor(32);
  assert.equal(await page.locator('#expedition-building-stats').textContent(), 'Lv.1 · 耐久 25/25 HP');

  await run.mineTo(6);
  await buyWall(3);
  await buyWall(3);
  assert.equal(await run.maker.textContent(), '制造卡牌（6 经济）');
  assert.equal(await page.locator('#expedition-feedback').textContent(), '下次制造费用升至 6 经济');
  await run.attemptUnaffordableDraw();
  await run.mineTo(6);
  await buyWall(6);
  assert.deepEqual(paid, [3, 3, 3, 6]);
  assert.equal(await run.cash(), '0.0');
  assert.deepEqual(await readCardInventory(page), { ...emptyCards, wall: 3 });

  await run.reset();
  await assertFreshPlaytest(page, seed);
  await run.mine(firstDirt);
  assert.equal(await run.cash(), '0.5');
  await page.clock.resume();
  await page.locator('#retry-round').click();
  await page.waitForFunction(() => document.querySelector('#economy-balance')?.textContent === '0.0');
  await assertFreshPlaytest(page, seed);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  await run.game.inspect(firstDirt, '可挖地形', 'HP 5/5');

  await page.clock.resume();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.has('seed') && url.searchParams.get('seed') !== String(seed)),
    page.locator('#new-round').click(),
  ]);
  const newSeed = currentSeed(page);
  await assertFreshPlaytest(page, newSeed);
  return { seed, newSeed, opening: 'challenge', wallHp: 25, paid, sameSeedRetries: ['R', 'button'], legacyFlagsIgnored: true };
}

export async function runPlaytestCombinedEconomySmoke(page, baseUrl) {
  const run = await preparePaidEvolvedTower(page, baseUrl, 'piercing', { playtest: true });
  assert.equal(currentSeed(page), 515);
  assert.equal(await run.maker.textContent(), '制造卡牌（6 经济）');
  assert.equal(await run.cash(), '0.0');
  assert.ok(await page.locator('#expedition-debug').isHidden());
  const combat = page.locator('#defense-stats');
  assert.equal(await combat.getAttribute('data-wave-combat'), null);
  assert.equal(await combat.getAttribute('data-tower-effects'), null);
  const towerKills = async () => Number(await combat.getAttribute('data-tower-kills'));

  const elapsed = (await page.evaluate(() => performance.now())) - run.start;
  let waiting = Math.max(0, Math.ceil(59_300 - elapsed));
  while (waiting > 0) {
    const step = Math.min(12_000, waiting);
    await page.clock.runFor(step);
    waiting -= step;
  }
  await advanceUntil(page, (round) => round.wave === 1 && round.phase === 'recovering',
    'The public merged tower must complete the first wave', 8_000);
  assert.equal(await towerKills(), 8);
  assert.equal(await run.cash(), '16.0');

  await advanceUntil(page, (round) => round.wave === 2 && round.phase === 'attacking',
    'The public build must advance to a second wave', 22_000);
  let beforeNinth;
  let withNinth;
  for (let advanced = 0; advanced <= 8_000; advanced += 64) {
    const kills = (await towerKills()) - 8;
    const balance = Number(await run.cash());
    if (kills >= 9) {
      withNinth = { kills, balance };
      break;
    }
    if (kills > 0) beforeNinth = { kills, balance };
    await page.clock.runFor(64);
  }
  assert.ok(beforeNinth && withNinth, 'Capture the second cohort balance on both sides of the ninth kill');
  assert.equal(beforeNinth.balance, 16 + 2 * beforeNinth.kills);
  // One piercing attack can skip over kill 8 in the UI, so account for the full-price kills in that shot.
  const reducedKills = withNinth.kills - 8;
  const reducedReward = withNinth.balance - beforeNinth.balance - 2 * (8 - beforeNinth.kills);
  assert.equal(reducedReward, reducedKills);
  assert.equal(withNinth.balance, 32 + reducedKills);
  const ninthReward = reducedReward / reducedKills;
  assert.equal(await combat.getAttribute('data-wave-combat'), null);
  assert.equal(await run.maker.textContent(), '制造卡牌（6 经济）');
  let card;
  for (let purchase = 0; purchase < 4; purchase += 1) {
    const drawn = await run.draw();
    if ((await readCardInventory(page))[drawn] === 2) {
      card = drawn;
      break;
    }
  }
  assert.ok(card, 'Four crafts must produce a duplicate among the three existing card types');
  const released = run.released.slice(0, 2);
  const stance = { col: released[1].col, row: released[1].row + 1 };
  await run.returnTo(stance);
  await run.select(card);
  const button = page.locator('#card-' + card);
  await page.keyboard.press('Escape');
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  await run.select(card);
  await page.keyboard.down('Shift');
  try {
    await run.place(card, released[0]);
    assert.equal(await button.getAttribute('aria-pressed'), 'true', 'Shift keeps the available card selected');
    await run.place(card, released[1]);
  } finally {
    await page.keyboard.up('Shift');
  }
  assert.equal(await button.getAttribute('aria-pressed'), 'false', 'Running out of the card exits placement');
  assert.equal((await readCardInventory(page))[card], 0);
  for (const reuse of released) {
    await run.game.inspect(reuse, '空地');
    await page.clock.runFor(32);
    assert.notEqual(await run.building.textContent(), '—');
  }
  return { seed: 515, evolution: 'piercing', intervalMs: run.attack.intervalMs,
    firstWaveKills: 8, firstWaveBalance: 16, beforeNinth, withNinth, ninthReward, reused: released, card, shiftPlacement: true };
}

export async function runPlaytestLiveRepathSmoke(page, baseUrl) {
  const run = await preparePaidEvolvedTower(page, baseUrl, 'piercing', { playtest: true, checkRepath: true });
  return { seed: 515, intervalMs: run.attack.intervalMs, searches: run.searches, released: run.released };
}

export async function runPlaytestMergeResetSmoke(page, baseUrl) {
  await preparePaidEvolvedTower(page, baseUrl, 'piercing', { playtest: true, readyOnly: true });
  assert.ok(await page.locator('#merge-confirm').isEnabled());
  await page.clock.resume();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.has('seed') && url.searchParams.get('seed') !== '515'),
    page.locator('#new-round').click(),
  ]);
  const newSeed = currentSeed(page);
  await assertFreshPlaytest(page, newSeed);
  return { previousSeed: 515, newSeed, selectedMergeCleared: true };
}

export async function runPlaytestBurstSmoke(page, baseUrl) {
  const run = await preparePaidEvolvedTower(page, baseUrl, 'burst', { playtest: true });
  const combat = page.locator('#defense-stats');
  assert.equal(await combat.getAttribute('data-tower-effects'), null);
  assert.equal(await run.maker.textContent(), '制造卡牌（6 经济）');
  await startFirstWave(page, run.start, { publicBuild: true });
  let previousHits = Number(await combat.getAttribute('data-shots'));
  let groupedHits = 0;
  for (let elapsed = 0; elapsed < 4_000 && groupedHits < 2; elapsed += 32) {
    await page.clock.runFor(32);
    const hits = Number(await combat.getAttribute('data-shots'));
    groupedHits = Math.max(groupedHits, hits - previousHits);
    previousHits = hits;
  }
  // There is exactly one tower. A sample shorter than its interval cannot contain two fires.
  assert.ok(groupedHits >= 2, 'The paid Burst Tower must hit multiple moving enemies in one attack');
  return { seed: 515, evolution: 'burst', radius: run.attack.radius, groupedHits };
}

export const runPlaytestLossSmoke = (page, url) => runChallengeLossSmoke(page, url, 'combined', { playtestUrl: '/' });

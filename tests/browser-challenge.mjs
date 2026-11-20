import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE } from '../src/expedition-economy.ts';
import { GENERATED_SPAWN } from '../src/generated-map.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { assertVisibleCardDraw, readCardInventory } from './browser-card-feedback.mjs';
import { openWideGame, playFixture } from './browser-fix02.mjs';

const emptyCards = { wall: 0, tower: 0, economy: 0 };
const firstDirt = { col: 19, row: 93 };
const opening = '挖掘地形获得经济，使用科技设施制造建筑卡。';
const firstReady = '已可制造第一张建筑卡';
const { attackIntervalMs, dirtMaxHp } = MINING_CONFIG;
const cell = (col, row) => ({ col, row });
const coords = ({ col, row }) => '(' + col + ', ' + row + ')';
const now = (page) => page.evaluate(() => performance.now());

async function openChallenge(page, baseUrl, seed) {
  const layout = playFixture(seed).layout;
  const url = baseUrl + '/?mode=play&difficulty=challenge&debug=1&seed=' + seed;
  const game = await openWideGame(page, url, layout);
  const roundUrl = page.url();
  const maker = page.locator('#make-card');
  const status = page.locator('#expedition-feedback');
  const dig = page.locator('#dig-result');
  const cash = () => page.locator('#economy-balance').textContent();

  async function assertFresh() {
    assert.equal(page.url(), roundUrl);
    assert.deepEqual(await game.position(), GENERATED_SPAWN);
    assert.equal(await page.locator('#round-difficulty option:checked').textContent(), '挑战模式：从零开始');
    assert.equal(await page.locator('#round-time-label').textContent(), '首波倒计时');
    assert.equal(await page.locator('#round-time').textContent(), '60 秒');
    assert.equal(await page.locator('#round-next-count').textContent(), '8 只');
    assert.equal(await page.locator('#round-stage').textContent(), '1 · 4 HP');
    assert.equal(await page.locator('#tool-level').textContent(), 'Lv.1');
    assert.equal(await cash(), '0.0');
    assert.deepEqual(await readCardInventory(page), emptyCards);
    assert.ok(await maker.isDisabled());
    assert.ok(await page.locator('#research-tool').isDisabled());
    assert.ok(await page.locator('#rebuild-technology').isHidden());
    assert.equal(await status.textContent(), opening);
    await game.inspect(ECONOMY_PROTOTYPE.technologyCell, '空地');
    await page.clock.runFor(32);
    assert.match(await page.locator('#expedition-building').textContent(), /^科技设施 \(17, 90\) · 10 HP$/);
    await game.inspect(firstDirt, '可挖地形', 'HP 5/5');
  }

  async function clickBoard() {
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await page.clock.runFor(32);
  }

  async function attemptUnaffordableDraw() {
    assert.ok(await maker.isDisabled());
    await maker.scrollIntoViewIfNeeded();
    const box = await maker.boundingBox();
    assert.ok(box);
    const inventory = await readCardInventory(page);
    const balance = await cash();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.deepEqual(await readCardInventory(page), inventory);
    assert.equal(await cash(), balance);
  }

  async function mine(target, remainingHp = dirtMaxHp) {
    await game.inspect(target, '可挖地形', 'HP ' + remainingHp + '/5');
    await page.mouse.down({ button: 'left' });
    try {
      await page.clock.runFor(remainingHp * attackIntervalMs + 64);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
    await game.inspect(target, '空地');
    assert.ok((await dig.textContent()).includes('挖掘成功'));
    assert.match(await dig.textContent(), /\+0\.1 经济$/);
  }

  async function mineOpening({ inspectPartial = false } = {}) {
    let firstRewardAt;
    if (inspectPartial) {
      await game.inspect(cell(19, 91), '空地');
      await clickBoard();
      assert.equal(await cash(), '0.0');
      await game.inspect(firstDirt, '可挖地形');
      await clickBoard();
      firstRewardAt = await now(page);
      assert.equal(await cash(), '0.1');
      assert.match(await dig.textContent(), /\+0\.1 经济$/);
      await clickBoard();
      assert.equal(await cash(), '0.1', 'Rapid taps must respect mining cooldown');
      await page.clock.runFor(2 * attackIntervalMs);
      await game.inspect(firstDirt, '可挖地形', 'HP 4/5');
    }
    await mine(firstDirt, inspectPartial ? 4 : dirtMaxHp);
    assert.equal(await cash(), '0.5', 'Five effective HP must yield exactly half a currency');
    await clickBoard();
    assert.equal(await cash(), '0.5', 'Re-clicking excavated soil must pay nothing');
    await game.walkTo(firstDirt, true);
    await mine(cell(18, 93));
    await mine(cell(20, 93));
    await game.walkTo(cell(20, 93), true);
    await mine(cell(20, 94));
    await game.walkTo(cell(21, 93), true);
    await mine(cell(22, 93));
    assert.equal(await cash(), '2.5');
    assert.ok(await maker.isDisabled());
    await game.walkTo(cell(21, 92), true);
    await mine(cell(22, 92));
    assert.equal(await cash(), '3.0', 'Six mined tiles must pay for exactly one card');
    assert.ok(await maker.isEnabled());
    assert.equal(await status.textContent(), firstReady);
    return { firstRewardAt, firstAffordableAt: await now(page) };
  }

  async function draw(expected) {
    assert.ok(await maker.isEnabled());
    const before = await readCardInventory(page);
    const beforeCash = Number(await cash());
    await maker.click();
    const kind = await page.locator('#card-draw-result').getAttribute('data-card');
    if (expected) assert.equal(kind, expected);
    await assertVisibleCardDraw(page, kind, before[kind]);
    assert.notEqual(await status.textContent(), firstReady, 'The first-afford cue must clear on purchase');
    assert.deepEqual(await readCardInventory(page), { ...before, [kind]: before[kind] + 1 });
    assert.equal(Number(await cash()), beforeCash - ECONOMY_PROTOTYPE.drawCost);
    return kind;
  }

  async function select(kind) {
    const card = page.locator('#card-' + kind);
    if (await card.getAttribute('aria-pressed') !== 'true') await card.click();
  }

  async function place(kind, target) {
    const before = await readCardInventory(page);
    await select(kind);
    await game.inspect(target, '空地');
    await clickBoard();
    assert.match(await status.textContent(), /^已建造/);
    assert.deepEqual(await readCardInventory(page), { ...before, [kind]: before[kind] - 1 });
  }

  async function reset() {
    await game.holdKey('KeyR', () => page.clock.runFor(48));
    await assertFresh();
  }

  await assertFresh();
  const start = await now(page);
  return { game, layout, cash, status, start, maker, clickBoard, mine, mineOpening, draw, select, place, reset, attemptUnaffordableDraw };
}

async function readRound(page) {
  return page.evaluate(() => {
    const data = document.getElementById('defense-stats').dataset;
    return {
      phase: document.getElementById('round-state').dataset.phase,
      wave: Number(document.getElementById('round-wave').textContent),
      hp: Number(document.getElementById('player-hp').textContent),
      combat: JSON.parse(data.waveCombat ?? '[]'),
      economy: JSON.parse(data.waveEconomy ?? '[]'),
    };
  });
}

async function advanceUntil(page, predicate, description, limitMs) {
  let state = await readRound(page);
  for (let delay = 0; !predicate(state) && delay < limitMs; delay += 128) {
    await page.clock.runFor(128);
    state = await readRound(page);
  }
  assert.ok(predicate(state), description + '. Last state: ' + JSON.stringify(state));
  return state;
}

async function startFirstWave(page, start) {
  let waiting = Math.max(0, Math.ceil(59_300 - ((await now(page)) - start)));
  while (waiting > 0) {
    const step = Math.min(12_000, waiting);
    await page.clock.runFor(step);
    waiting -= step;
  }
  assert.equal((await readRound(page)).phase, 'preparing');
  const state = await advanceUntil(page, (round) => round.wave === 1 && round.phase === 'attacking',
    'The challenge first wave must start at 60 seconds', 1_600);
  assert.equal(state.combat[0].planned, 8);
  assert.ok(Math.abs(state.combat[0].startedAtMs - 60_000) <= 96);
}

async function recoverFirstWave(page) {
  const state = await advanceUntil(page, (round) => round.wave === 1 && round.phase === 'recovering',
    'Surviving the first real attack must enter recovery', 7_000);
  assert.equal(state.hp, 4);
  assert.equal(await page.locator('#round-time-label').textContent(), '下波倒计时');
  assert.equal(await page.locator('#round-time').textContent(), '20 秒');
  assert.equal(await page.locator('#round-next-count').textContent(), '16 只');
  const first = state.combat[0];
  assert.equal(first.spawned, 8);
  assert.equal(first.pending + first.active, 0);
  return { state, first };
}

export async function runChallengeWallSmoke(page, baseUrl) {
  const seed = 9;
  const run = await openChallenge(page, baseUrl, seed);
  const { game } = run;
  await run.attemptUnaffordableDraw();
  const openingTimes = await run.mineOpening({ inspectPartial: true });
  assert.equal(await run.draw('wall'), 'wall');
  const firstDefenseAt = await now(page);
  const wall = cell(24, 94);
  await run.select('wall');
  await game.inspect(wall, '空地');
  await run.clickBoard();
  assert.equal(await page.locator('#build-preview').getAttribute('data-reason'), 'out-of-range');
  assert.deepEqual(await readCardInventory(page), { ...emptyCards, wall: 1 });
  await game.walkVia(cell(21, 93), cell(21, 94), cell(23, 94));
  await run.place('wall', wall);
  await page.keyboard.press('Escape');
  await game.walkVia(cell(21, 94), cell(21, 92), GENERATED_SPAWN);
  await game.openLineTo(cell(19, 83), true);
  await game.walkTo(GENERATED_SPAWN, true);
  assert.equal(await run.cash(), '0.5');
  await startFirstWave(page, run.start);
  assert.equal(await run.cash(), '0.5');
  const { state, first } = await recoverFirstWave(page);
  assert.equal(first.wallImpacts, 8);
  assert.equal(first.wallDamage, 8);
  assert.equal(first.towerKills + first.playerDamage, 0);
  assert.equal(await run.cash(), '0.5', 'Wall impacts do not grant kill income');
  await game.inspect(wall, '空地');
  await page.clock.runFor(32);
  assert.equal(await page.locator('#expedition-building').textContent(), '城墙 ' + coords(wall) + ' · 42 HP');
  const beforeWave = state.economy.find((wave) => wave.waveId === 0);
  assert.equal(beforeWave.miningIncome, 3.5);
  assert.equal(beforeWave.cardSpend, 3);
  assert.equal(state.economy.find((wave) => wave.waveId === 1).killIncome, 0);

  await page.clock.runFor(19_300);
  assert.equal((await readRound(page)).phase, 'recovering');
  const next = await advanceUntil(page, (round) => round.wave === 2 && round.phase === 'attacking',
    'The real recovery must end with a new wave', 1_400);
  assert.equal(next.combat[1].planned, 16);
  assert.ok(Math.abs(next.combat[1].startedAtMs - first.attackEndedAtMs - 20_000) <= 64);
  await run.reset();

  return {
    seed, case: 'wall', miningIncomeBeforeWave: beforeWave.miningIncome, openingWaveBalance: beforeWave.balance,
    firstRewardMs: Math.round(openingTimes.firstRewardAt - run.start),
    firstAffordableMs: Math.round(openingTimes.firstAffordableAt - run.start),
    firstDefenseCardMs: Math.round(firstDefenseAt - run.start),
    firstThreatMs: Math.round(first.firstThreatAtMs), firstHitMs: Math.round(first.firstBuildingDamageAtMs),
    waveOne: first.planned, waveTwo: next.combat[1].planned, wallHp: 42, playerHp: state.hp,
  };
}

export async function runChallengeTowerSmoke(page, baseUrl) {
  const seed = 512;
  const run = await openChallenge(page, baseUrl, seed);
  const { game, layout } = run;
  await run.mineOpening();
  await run.draw('tower');
  await game.walkTo(GENERATED_SPAWN, true);
  const dirtRows = Array.from({ length: 29 }, (_, index) => 92 - index).filter((row) => layout[row][19] === '+');
  assert.ok(dirtRows.length >= 6);
  await game.openLineTo(cell(19, dirtRows[5]), true);
  await game.walkTo(GENERATED_SPAWN, true);
  assert.equal(await run.cash(), '3.0');
  await run.draw('tower');
  await game.walkVia(cell(21, 92), cell(21, 93), cell(22, 93));
  await run.mine(cell(23, 93));
  await run.place('tower', cell(23, 93));
  await run.place('tower', cell(22, 92));
  await page.keyboard.press('Escape');
  await game.walkVia(cell(21, 93), cell(21, 92), GENERATED_SPAWN);
  await startFirstWave(page, run.start);
  const { first, state } = await recoverFirstWave(page);
  assert.equal(first.towerKills, 8);
  assert.equal(first.averageTowerHitsOnKill, 2);
  assert.equal(first.playerDamage + first.buildingDamage, 0);
  const economy = state.economy.find((wave) => wave.waveId === 1);
  assert.equal(economy.openingBalance, 0.5);
  assert.equal(economy.killIncome, 16);
  assert.equal(economy.miningIncome, 0);
  assert.equal(await run.cash(), '16.5');
  return { seed, case: 'tower', towerKills: first.towerKills, averageHits: first.averageTowerHitsOnKill,
    firstThreatMs: Math.round(first.firstThreatAtMs), balance: Number(await run.cash()), playerHp: state.hp };
}

export async function runChallengeLossSmoke(page, baseUrl) {
  const seed = 12;
  const run = await openChallenge(page, baseUrl, seed);
  await run.game.walkVia(cell(21, 92), cell(21, 94), cell(26, 94));
  await startFirstWave(page, run.start);
  const loss = await advanceUntil(page, (state) => state.phase === 'lost', 'Unprotected player encounters the first wave', 4_000);
  assert.equal(loss.wave, 1);
  assert.equal(loss.hp, 0);
  assert.equal(loss.combat[0].playerContacts, 4);
  assert.equal(loss.combat[0].playerDamage, 4);
  assert.equal(loss.combat[0].towerKills, 0);
  assert.equal(await run.cash(), '0.0');
  assert.deepEqual(await readCardInventory(page), emptyCards);
  return { seed, case: 'no-defense', wave: loss.wave, firstDamageMs: Math.round(loss.combat[0].firstPlayerDamageAtMs), playerHp: loss.hp };
}

export async function runChallengePitySmoke(page, baseUrl) {
  const seed = 1091;
  const run = await openChallenge(page, baseUrl, seed);
  const { game } = run;
  await run.attemptUnaffordableDraw();
  await run.mineOpening();
  await run.draw('economy');
  await run.attemptUnaffordableDraw();

  await game.walkVia(GENERATED_SPAWN, cell(19, 84));
  for (const col of [18, 17, 16, 15]) {
    await game.walkTo(cell(col, 84), true);
    await run.mine(cell(col, 83));
  }
  await game.walkTo(cell(19, 84), true);
  await game.openLineTo(cell(19, 64), true);
  assert.equal(await run.cash(), '9.0');
  const second = await run.draw('economy');
  const third = await run.draw();
  assert.ok(third === 'wall' || third === 'tower', 'The third successful paid draw must cover the two economy draws');
  const fourth = await run.draw('economy');
  assert.deepEqual(await readCardInventory(page), { ...emptyCards, economy: 3, [third]: 1 });
  assert.equal(await run.cash(), '0.0', 'The pity draw must not be free or refund its cost');
  await run.reset();
  await run.mineOpening();
  await run.draw('economy');

  await page.clock.resume();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.has('seed') && url.searchParams.get('seed') !== String(seed)),
    page.locator('#new-round').click(),
  ]);
  await page.waitForFunction(() => document.getElementById('round-difficulty').value === 'challenge'
    && document.getElementById('round-state').dataset.phase === 'preparing'
    && Number(document.getElementById('visible-chunks').dataset.worldWidth) > 0);
  const next = new URL(page.url()).searchParams;
  assert.equal(next.get('difficulty'), 'challenge');
  assert.equal(await run.cash(), '0.0');
  assert.deepEqual(await readCardInventory(page), emptyCards);

  return { seed, case: 'pity', draws: ['economy', second, third, fourth],
    newRoundRetainedChallenge: true };
}

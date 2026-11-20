import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE } from '../src/expedition-economy.ts';
import { GENERATED_GOAL, GENERATED_SPAWN } from '../src/generated-map.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { assertVisibleCardDraw, readCardInventory } from './browser-card-feedback.mjs';
import { openWideGame, playFixture } from './browser-fix02.mjs';
import { findDiggablePath, followRoute } from './browser-goal.mjs';

const emptyCards = { wall: 0, tower: 0, economy: 0 };
const firstDirt = { col: 19, row: 93 };
const firstTechnology = { col: 18, row: 92 };
const technologyCost = 10;
const researchCost = 20;
const wallHpByBuild = Object.freeze({ control: 50, w35: 35, w25: 25, w15: 15 });
const firstReady = '已可制造第一张建筑卡';
const { attackIntervalMs, dirtMaxHp } = MINING_CONFIG;
const cell = (col, row) => ({ col, row });
const coords = ({ col, row }) => '(' + col + ', ' + row + ')';
const now = (page) => page.evaluate(() => performance.now());
const neighbors = ({ col, row }) => [cell(col, row - 1), cell(col - 1, row), cell(col + 1, row), cell(col, row + 1)];

export async function openChallenge(page, baseUrl, seed, build, experiment, { playtestUrl } = {}) {
  const layout = [...playFixture(seed).layout];
  const url = new URL(playtestUrl ?? '/?mode=play&difficulty=challenge&debug=1&seed=' + seed, baseUrl);
  if (playtestUrl === undefined) {
    if (build) url.searchParams.set('build', build);
    if (experiment) url.searchParams.set('midgame', experiment);
  } else {
    url.searchParams.set('seed', String(seed));
  }
  const game = await openWideGame(page, url.href, layout);
  const roundUrl = page.url();
  const maker = page.locator('#make-card');
  const technology = page.locator('#rebuild-technology');
  const research = page.locator('#research-tool');
  const building = page.locator('#expedition-building');
  const preview = page.locator('#build-preview');
  const status = page.locator('#expedition-feedback');
  const dig = page.locator('#dig-result');
  const cash = () => page.locator('#economy-balance').textContent();
  const occupied = new Set();

  async function assertFresh() {
    assert.equal(page.url(), roundUrl);
    assert.deepEqual(await game.position(), GENERATED_SPAWN);
    if (playtestUrl === undefined) {
      assert.equal(await page.locator('#round-difficulty option:checked').textContent(), '挑战模式：从零开始');
      assert.equal(await page.locator('#challenge-balance').inputValue(), build ?? 'w25');
      assert.equal(await page.locator('#midgame-experiment').inputValue(), experiment ?? 'control');
    }
    assert.equal(await page.locator('#round-time-label').textContent(), '首波倒计时');
    assert.equal(await page.locator('#round-time').textContent(), '60 秒');
    assert.equal(await page.locator('#round-next-count').textContent(), '8 只');
    assert.equal(await page.locator('#round-stage').textContent(), '1 · 4 HP');
    assert.equal(await page.locator('#tool-level').textContent(), 'Lv.1');
    assert.equal(await cash(), '0.0');
    assert.deepEqual(await readCardInventory(page), emptyCards);
    assert.ok(await maker.isDisabled());
    assert.equal(await page.locator('#card-draw-reason').textContent(), '请先建造科技设施');
    assert.ok(await research.isDisabled());
    assert.match(await research.textContent(), /20 经济/);
    assert.ok(await technology.isVisible());
    assert.ok(await technology.isDisabled());
    assert.match(await technology.textContent(), /10 经济/);
    assert.match(await status.textContent(), /挖掘.*科技设施/);
    await game.inspect(ECONOMY_PROTOTYPE.technologyCell, '空地');
    await page.clock.runFor(32);
    assert.equal(await building.textContent(), '—', 'The original slot starts without a gifted facility');
    await game.inspect(firstTechnology, '空地');
    await page.clock.runFor(32);
    assert.equal(await building.textContent(), '—');
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
    const { col, row } = target;
    layout[row] = layout[row].slice(0, col) + '.' + layout[row].slice(col + 1);
  }

  async function findReachable(goal) {
    const start = await game.position();
    const queue = [{ from: start, path: [start] }];
    const visited = new Set([coords(start)]);
    for (let index = 0; index < queue.length; index += 1) {
      const { from, path } = queue[index];
      const target = goal(from);
      if (target) return { target, path };
      for (const next of neighbors(from)) {
        const key = coords(next);
        if (visited.has(key) || occupied.has(key) || !/[.SG]/.test(layout[next.row]?.[next.col] ?? '')) continue;
        visited.add(key);
        queue.push({ from: next, path: [...path, next] });
      }
    }
    assert.fail('No legal open route from ' + coords(start));
  }

  async function followOpenPath(path) {
    let cursor = 0;
    while (cursor < path.length - 1) {
      let end = cursor + 1;
      const axis = path[cursor].col === path[end].col ? 'col' : 'row';
      while (end < path.length - 1 && path[end + 1][axis] === path[cursor][axis]) end += 1;
      await game.walkTo(path[end], true);
      cursor = end;
    }
  }

  async function returnTo(target) {
    const { path } = await findReachable((from) => coords(from) === coords(target) ? target : undefined);
    await followOpenPath(path);
  }

  async function mineTo(balance, { allowCombatIncome = false } = {}) {
    const deficit = balance - Number(await cash());
    const tiles = 2 * (allowCombatIncome ? Math.max(0, deficit) : deficit);
    assert.ok(Number.isInteger(tiles) && tiles >= 0, 'Funding must start in exact half-unit increments');
    for (let index = 0; index < tiles; index += 1) {
      if (allowCombatIncome && Number(await cash()) >= balance) break;
      const { path, target } = await findReachable((from) => neighbors(from).find(({ col, row }) =>
        row >= 64 && row <= 91 && col >= 9 && col <= 25 && !(col === 19 && row === 83)
        && layout[row][col] === '+'));
      await followOpenPath(path);
      await mine(target);
    }
    if (allowCombatIncome) assert.ok(Number(await cash()) >= balance);
    else assert.equal(Number(await cash()), balance);
  }

  async function buildTechnology(target = firstTechnology, checkInvalid = false) {
    assert.ok(await technology.isEnabled());
    const before = Number(await cash());
    const inventory = await readCardInventory(page);
    await technology.click();
    assert.equal(await technology.getAttribute('aria-pressed'), 'true');
    if (checkInvalid) {
      await game.inspect(ECONOMY_PROTOTYPE.technologyCell, '空地');
      await page.clock.runFor(32);
      assert.equal(await preview.getAttribute('data-reason'), 'out-of-range');
      await clickBoard();
      assert.equal(Number(await cash()), before, 'An invalid technology placement must not charge');
    }
    await game.inspect(target, '空地');
    await page.clock.runFor(32);
    assert.equal(await preview.getAttribute('data-state'), 'valid',
      'Technology placement at ' + coords(target) + ' rejected: ' + await preview.getAttribute('data-reason'));
    await clickBoard();
    assert.equal(Number(await cash()), before - technologyCost);
    assert.deepEqual(await readCardInventory(page), inventory);
    await game.inspect(target, '空地');
    await page.clock.runFor(32);
    assert.equal(await building.textContent(), '科技设施 ' + coords(target) + ' · 1 HP');
    occupied.add(coords(target));
  }

  async function researchTool() {
    assert.ok(await research.isEnabled());
    const before = Number(await cash());
    await research.click();
    assert.equal(Number(await cash()), before - researchCost);
    assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2');
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
    assert.equal(await cash(), '3.0', 'Six mined tiles must yield exactly three currency');
    assert.ok(await maker.isDisabled(), 'Money alone does not manufacture before the facility exists');
    assert.ok(await technology.isDisabled());
    await mineTo(technologyCost);
    await returnTo(GENERATED_SPAWN);
    await buildTechnology(firstTechnology, inspectPartial);
    const technologyAt = await now(page);
    assert.equal(await cash(), '0.0');
    assert.deepEqual(await readCardInventory(page), emptyCards);
    await mineTo(ECONOMY_PROTOTYPE.drawCost);
    assert.ok(await maker.isEnabled());
    assert.equal(await status.textContent(), firstReady);
    return { firstRewardAt, technologyAt, firstAffordableAt: await now(page) };
  }

  async function draw(expected) {
    assert.ok(await maker.isEnabled());
    const before = await readCardInventory(page);
    const beforeCash = Number(await cash());
    const displayedCost = (await maker.textContent()).match(/制造卡牌（(\d+) 经济）/);
    assert.ok(displayedCost);
    if (playtestUrl === undefined && !experiment) assert.equal(Number(displayedCost[1]), ECONOMY_PROTOTYPE.drawCost);
    await maker.click();
    const kind = await page.locator('#card-draw-result').getAttribute('data-card');
    if (expected) assert.equal(kind, expected);
    await assertVisibleCardDraw(page, kind, before[kind]);
    assert.notEqual(await status.textContent(), firstReady, 'The first-afford cue must clear on purchase');
    assert.deepEqual(await readCardInventory(page), { ...before, [kind]: before[kind] + 1 });
    assert.equal(Number(await cash()), beforeCash - Number(displayedCost[1]));
    return kind;
  }

  async function select(kind) {
    const card = page.locator('#card-' + kind);
    if (await card.getAttribute('aria-pressed') !== 'true') await card.click();
  }

  async function place(kind, target, { merge = false } = {}) {
    const before = await readCardInventory(page);
    await select(kind);
    await game.inspect(target, '空地');
    await clickBoard();
    assert.match(await status.textContent(), merge ? /^已合成/ : /^已建造/);
    assert.deepEqual(await readCardInventory(page), { ...before, [kind]: before[kind] - 1 });
    occupied.add(coords(target));
  }

  async function reset() {
    await game.holdKey('KeyR', () => page.clock.runFor(48));
    layout.splice(0, layout.length, ...playFixture(seed).layout);
    occupied.clear();
    await assertFresh();
  }

  await assertFresh();
  const start = await now(page);
  return {
    game, cash, start, maker, technology, building, occupied, clickBoard, mine,
    mineTo, mineOpening, returnTo, buildTechnology, researchTool, draw, select, place, reset, attemptUnaffordableDraw,
  };
}

export async function readRound(page) {
  return page.evaluate(() => {
    const data = document.getElementById('defense-stats').dataset;
    return {
      phase: document.getElementById('round-state').dataset.phase,
      wave: Number(document.getElementById('round-wave').textContent),
      hp: Number(document.getElementById('player-hp').textContent),
      buildingContacts: Number(data.buildingContacts),
      playerContacts: Number(data.playerContacts), towerKills: Number(data.towerKills),
      combat: JSON.parse(data.waveCombat ?? '[]'),
      economy: JSON.parse(data.waveEconomy ?? '[]'),
    };
  });
}

export async function advanceUntil(page, predicate, description, limitMs, stepMs = 128) {
  let state = await readRound(page);
  for (let delay = 0; !predicate(state) && delay < limitMs; delay += stepMs) {
    await page.clock.runFor(stepMs);
    state = await readRound(page);
  }
  assert.ok(predicate(state), description + '. Last state: ' + JSON.stringify(state));
  return state;
}

export async function startFirstWave(page, start, { publicBuild = false } = {}) {
  let waiting = Math.max(0, Math.ceil(59_300 - ((await now(page)) - start)));
  while (waiting > 0) {
    const step = Math.min(12_000, waiting);
    await page.clock.runFor(step);
    waiting -= step;
  }
  assert.equal((await readRound(page)).phase, 'preparing');
  const state = await advanceUntil(page, (round) => round.wave === 1 && round.phase === 'attacking',
    'The challenge first wave must start at 60 seconds', 1_600, publicBuild ? 16 : 128);
  if (publicBuild) {
    assert.deepEqual(state.combat, []);
    assert.equal(await page.locator('#defense-stats').getAttribute('data-requested'), '8');
  } else {
    assert.equal(state.combat[0].planned, 8);
    assert.ok(Math.abs(state.combat[0].startedAtMs - 60_000) <= 96);
  }
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

export async function runChallengeWallSmoke(page, baseUrl, build) {
  const seed = 9;
  const run = await openChallenge(page, baseUrl, seed, build);
  const profile = build ?? 'w25';
  const initialWallHp = wallHpByBuild[profile];
  const { game } = run;
  await run.attemptUnaffordableDraw();
  const openingTimes = await run.mineOpening({ inspectPartial: true });
  assert.equal(await run.draw('wall'), 'wall');
  const firstDefenseAt = await now(page);
  const wall = cell(24, 94);
  await run.returnTo(cell(21, 92));
  await run.select('wall');
  await game.inspect(wall, '空地');
  await run.clickBoard();
  assert.equal(await page.locator('#build-preview').getAttribute('data-reason'), 'out-of-range');
  assert.deepEqual(await readCardInventory(page), { ...emptyCards, wall: 1 });
  await game.walkVia(cell(21, 93), cell(21, 94), cell(23, 94));
  await run.place('wall', wall);
  await game.inspect(wall, '空地');
  await page.clock.runFor(32);
  assert.equal(await run.building.textContent(), '城墙 ' + coords(wall) + ' · ' + initialWallHp + ' HP');
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
  const wallHp = initialWallHp - first.wallDamage;
  assert.equal(await run.building.textContent(), '城墙 ' + coords(wall) + ' · ' + wallHp + ' HP');
  const beforeWave = state.economy.find((wave) => wave.waveId === 0);
  assert.equal(beforeWave.miningIncome, 13.5);
  assert.equal(beforeWave.technologySpend, 10);
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
    seed, case: 'wall', profile, initialWallHp, wallImpacts: first.wallImpacts,
    miningIncomeBeforeWave: beforeWave.miningIncome, openingWaveBalance: beforeWave.balance,
    firstRewardMs: Math.round(openingTimes.firstRewardAt - run.start),
    firstTechnologyMs: Math.round(openingTimes.technologyAt - run.start),
    firstAffordableMs: Math.round(openingTimes.firstAffordableAt - run.start),
    firstDefenseCardMs: Math.round(firstDefenseAt - run.start),
    firstThreatMs: Math.round(first.firstThreatAtMs), firstHitMs: Math.round(first.firstBuildingDamageAtMs),
    waveOne: first.planned, waveTwo: next.combat[1].planned, wallHp, playerHp: state.hp,
  };
}

export async function runChallengeTowerSmoke(page, baseUrl) {
  const seed = 512;
  const run = await openChallenge(page, baseUrl, seed);
  const { game } = run;
  await run.mineOpening();
  await run.draw('tower');
  await run.mineTo(3);
  await run.draw('tower');
  await run.returnTo(cell(22, 93));
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

export async function runChallengeLossSmoke(page, baseUrl, experiment, options) {
  const seed = 12;
  const run = await openChallenge(page, baseUrl, seed, undefined, experiment, options);
  await run.game.walkVia(cell(21, 92), cell(21, 94), cell(26, 94));
  await startFirstWave(page, run.start, { publicBuild: Boolean(options?.playtestUrl) });
  const loss = await advanceUntil(page, (state) => state.phase === 'lost', 'Unprotected player encounters the first wave', 4_000);
  assert.equal(loss.wave, 1);
  assert.equal(loss.hp, 0);
  assert.equal(loss.playerContacts, 4);
  assert.equal(loss.towerKills, 0);
  if (!options?.playtestUrl) {
    assert.equal(loss.combat[0].playerContacts, 4);
    assert.equal(loss.combat[0].playerDamage, 4);
    assert.equal(loss.combat[0].towerKills, 0);
  }
  assert.equal(await run.cash(), '0.0');
  assert.deepEqual(await readCardInventory(page), emptyCards);
  return { seed, experiment, case: 'no-defense', wave: loss.wave,
    firstDamageMs: loss.combat[0] ? Math.round(loss.combat[0].firstPlayerDamageAtMs) : undefined, playerHp: loss.hp };
}

export async function runChallengePitySmoke(page, baseUrl) {
  const seed = 1091;
  const run = await openChallenge(page, baseUrl, seed);
  await run.attemptUnaffordableDraw();
  await run.mineOpening();
  await run.draw('economy');
  await run.attemptUnaffordableDraw();

  await run.mineTo(9);
  const second = await run.draw('economy');
  const third = await run.draw('tower');
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

export async function runChallengeTechnologyRelocationSmoke(page, baseUrl) {
  const seed = 12;
  const run = await openChallenge(page, baseUrl, seed);
  const doorway = cell(21, 93);
  const oldSite = cell(21, 94);
  const shelteredSite = cell(18, 84);
  // Fund the setup before the exposed facility attracts attackers.
  await run.mineTo(technologyCost + researchCost + ECONOMY_PROTOTYPE.drawCost);
  await run.returnTo(doorway);
  await run.buildTechnology(oldSite);
  const before = await readRound(page);
  await run.researchTool();
  await run.draw('wall');
  await run.game.walkTo(cell(21, 92), true);
  await run.place('wall', doorway);
  await run.game.inspect(cell(20, 93), '可挖地形', 'HP 5/5');
  await run.game.inspect(cell(22, 93), '可挖地形', 'HP 5/5');
  await run.returnTo(cell(19, 84));
  if (await run.technology.isHidden() && (await readRound(page)).phase === 'preparing') {
    await page.locator('#expedition-spawn').click();
  }
  const attack = await advanceUntil(page, (state) => state.buildingContacts > before.buildingContacts,
    'An actual southern enemy must damage the exposed technology', 8_000);
  assert.equal(attack.hp, 4);
  assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2', 'Loss of a facility must not reset researched tools');
  assert.equal(await page.locator('#card-draw-reason').textContent(), '科技设施已损毁');
  assert.deepEqual(await readCardInventory(page), emptyCards);
  await run.mineTo(technologyCost);
  assert.ok(await run.maker.isDisabled(), 'The replacement budget cannot manufacture without a facility');
  assert.ok(await run.technology.isEnabled());
  assert.equal(await run.cash(), '10.0');

  run.occupied.delete(coords(oldSite));
  await run.returnTo(cell(19, 84));
  await run.buildTechnology(shelteredSite);
  await run.returnTo(cell(21, 92));
  await run.game.inspect(oldSite, '空地');
  await page.clock.runFor(32);
  assert.equal(await run.building.textContent(), '—');
  assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2');
  assert.equal(await run.cash(), '0.0');
  assert.deepEqual(await readCardInventory(page), emptyCards);
  const remainingHp = (await readRound(page)).hp;
  assert.equal(remainingHp, 4, 'The shelter protects the player throughout mining and relocation');
  return { seed, oldSite, replacement: shelteredSite, attackWave: attack.wave, remainingHp };
}

export async function runChallengeVictorySmoke(page, baseUrl, build = 'control', experiment, options) {
  const seed = 12;
  const run = await openChallenge(page, baseUrl, seed, build, experiment, options);
  const gate = cell(19, 83);
  const northFacility = cell(18, 82);
  const routeStart = cell(19, 79);
  const reinforceGate = options?.reinforceGate === true;
  const defendSouth = !reinforceGate && build === 'w25';
  const fourCards = defendSouth || reinforceGate;
  const openingCards = fourCards ? ['wall', 'tower', 'tower', 'wall'] : ['wall'];

  // Mine a southern strip to leave row 83 solid until we cross it.
  await run.returnTo(cell(15, 90));
  const endCol = fourCards ? 1 : 6;
  for (let col = 14; col >= endCol; col -= 1) {
    const through = cell(col, 90);
    await run.mine(through);
    await run.game.walkTo(through, true);
    await run.mine(cell(col, 89));
    if (fourCards || col > 6) await run.mine(cell(col, 91));
  }
  if (fourCards) {
    for (const col of [1, 2]) {
      await run.returnTo(cell(col, 89));
      await run.mine(cell(col, 88));
    }
  }
  if (reinforceGate) {
    // The fourth Combined card costs three extra currency. Mine six more five-HP tiles away from the north gate.
    for (const col of [3, 4, 5]) {
      await run.returnTo(cell(col, 89));
      await run.mine(cell(col, 88));
    }
    for (const col of [1, 2, 3]) {
      await run.returnTo(cell(col, 91));
      await run.mine(cell(col, 92));
    }
  }
  const startingSpend = technologyCost + openingCards.length * ECONOMY_PROTOTYPE.drawCost + (reinforceGate ? 3 : 0);
  assert.equal(Number(await run.cash()), startingSpend);
  await run.returnTo(cell(19, 84));
  for (const target of [gate, cell(19, 82)]) {
    await run.mine(target);
    await run.game.walkTo(target, true);
  }
  await run.mine(northFacility);
  await run.buildTechnology(northFacility);
  for (const kind of openingCards) await run.draw(kind);
  if (defendSouth) {
    await run.returnTo(cell(23, 94));
    await run.place('wall', cell(24, 94));
    for (const col of [23, 22]) {
      const stance = cell(col, 93);
      await run.mine(stance);
      await run.game.walkTo(stance, true);
      await run.place('tower', cell(col, 94));
    }
    await run.returnTo(cell(19, 82));
  }
  await run.place('wall', gate);
  for (const row of [81, 80, 79]) {
    const target = cell(19, row);
    await run.mine(target);
    await run.game.walkTo(target, true);
    if (row === 81 && reinforceGate) {
      await run.place('wall', cell(19, 82));
      for (const col of [18, 20]) {
        const towerSite = cell(col, row);
        await run.mine(towerSite);
        await run.place('tower', towerSite);
      }
    }
  }
  await run.mineTo(researchCost, { allowCombatIncome: fourCards });
  await run.researchTool();
  await run.returnTo(routeStart);
  await run.game.inspect(cell(18, gate.row), '可挖地形', 'HP 5/5');
  await run.game.inspect(cell(20, gate.row), '可挖地形', 'HP 5/5');
  const route = findDiggablePath([northFacility]);
  const start = route.findIndex((step) => coords(step) === coords(routeStart));
  assert.ok(start > 0);
  try {
    await followRoute(page, run.game, route.slice(start));
  } catch (error) {
    const state = await readRound(page);
    throw new Error(`Expedition route stopped in wave ${state.wave}, phase ${state.phase}, HP ${state.hp}: ${error.message}`, { cause: error });
  }
  assert.deepEqual(await run.game.position(), GENERATED_GOAL);
  const victory = await readRound(page);
  assert.equal(victory.phase, 'won');
  assert.ok(victory.wave > 0, 'The expedition must win under real attack timing');
  assert.ok(victory.hp > 0);
  return { seed, profile: build, experiment, hp: victory.hp, wave: victory.wave, gate, routeSteps: route.length - 1,
    openingCards, towerKills: victory.towerKills, reinforcedGate: reinforceGate };
}

import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE } from '../src/expedition-economy.ts';
import { GENERATED_SPAWN } from '../src/generated-map.ts';
import { readCardInventory } from './browser-card-feedback.mjs';
import { advanceUntil, openChallenge, startFirstWave } from './browser-challenge.mjs';
import { openWideGame, playFixture } from './browser-fix02.mjs';

const seed = 12;

function waitForExpedition(page) {
  return page.waitForFunction(() => Number(document.getElementById('visible-chunks').dataset.worldWidth) > 0
    && document.getElementById('round-state').dataset.phase === 'preparing');
}

export async function runBuildingBalanceSelectionSmoke(page, baseUrl) {
  const { layout } = playFixture(seed);
  const game = await openWideGame(page, baseUrl + '/?mode=play&difficulty=challenge&seed=' + seed, layout);
  const balance = page.locator('#challenge-balance');
  const currentSeed = () => new URL(page.url()).searchParams.get('seed');
  assert.ok(await balance.isVisible());
  assert.equal(await balance.inputValue(), 'w25');
  assert.deepEqual(await balance.locator('option').evaluateAll((options) =>
    options.map(({ value, textContent }) => [value, textContent])), [
    ['control', 'Control · 50 HP · 原属性'], ['w35', 'W35 · 35 HP'],
    ['w25', 'W25 · 25 HP · 试玩候选'], ['w15', 'W15 · 15 HP'],
  ]);
  assert.equal(new URL(page.url()).searchParams.get('build'), null);

  await page.clock.resume();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get('build') === 'w35'),
    balance.selectOption('w35'),
  ]);
  await waitForExpedition(page);
  assert.equal(await balance.inputValue(), 'w35');
  assert.equal(currentSeed(), String(seed));
  assert.equal(await page.locator('#economy-balance').textContent(), '0.0');

  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  const selectedUrl = page.url();
  await game.holdKey('KeyR', () => page.clock.runFor(48));
  assert.equal(page.url(), selectedUrl);
  assert.equal(await balance.inputValue(), 'w35');

  await page.clock.resume();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get('seed') !== String(seed)),
    page.locator('#new-round').click(),
  ]);
  await waitForExpedition(page);
  assert.equal(await balance.inputValue(), 'w35');
  assert.equal(new URL(page.url()).searchParams.get('build'), 'w35');

  const legacyWallHp = {};
  for (const difficulty of ['baseline', 'a', 'b']) {
    const url = new URL('/?mode=play&build=w15&seed=' + seed, baseUrl);
    if (difficulty !== 'baseline') url.searchParams.set('difficulty', difficulty);
    assert.equal((await page.goto(url.href))?.status(), 200);
    await waitForExpedition(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
    assert.equal(await page.locator('#round-difficulty').inputValue(), difficulty);
    assert.ok(await balance.isHidden());
    assert.deepEqual(await readCardInventory(page), { wall: 4, tower: 2, economy: 1 });
    const target = { col: 20, row: 92 };
    await page.locator('#card-wall').click();
    await game.inspect(target, '空地');
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await page.clock.runFor(32);
    assert.equal(await page.locator('#expedition-building').textContent(), '城墙 (20, 92) · 50 HP');
    assert.equal((await readCardInventory(page)).wall, 3);
    legacyWallHp[difficulty] = 50;
    await page.clock.resume();
  }
  return { default: 'w25', persisted: 'w35', legacyWallHp };
}

export async function runBoundarySeedOpeningSmoke(page, baseUrl, seed) {
  const run = await openChallenge(page, baseUrl, seed, 'w25');
  await run.mineOpening();
  await run.mineTo(ECONOMY_PROTOTYPE.drawCost);
  const firstCard = await run.draw('wall');
  assert.equal(await run.cash(), '0.0');
  assert.equal(await page.locator('#round-state').getAttribute('data-phase'), 'preparing');
  await run.reset();
  return { seed, firstCard, technologyCost: 10, cardCost: ECONOMY_PROTOTYPE.drawCost, reset: true };
}

const cell = (col, row) => ({ col, row });
const now = (page) => page.evaluate(() => performance.now());

async function fundCards(run, kinds) {
  await run.mineOpening();
  await run.draw(kinds[0]);
  await run.mineTo((kinds.length - 1) * ECONOMY_PROTOTYPE.drawCost);
  for (const kind of kinds.slice(1)) await run.draw(kind);
  assert.equal(await run.cash(), '0.0');
}

async function assertBuildingStats(page, run, target, details) {
  await run.game.inspect(target, '空地');
  await page.clock.runFor(32);
  const stats = page.locator('#expedition-building-stats');
  assert.ok(await stats.isVisible());
  assert.equal(await stats.textContent(), details);
}

async function assertReleasedSites(page, run, sites) {
  for (const site of sites) {
    await run.game.inspect(site, '空地');
    await page.clock.runFor(32);
    assert.equal(await run.building.textContent(), '—');
    assert.ok(await page.locator('#expedition-building-stats').isHidden());
  }
}

export async function runBuildingWallUpgradeSmoke(page, baseUrl) {
  const run = await openChallenge(page, baseUrl, 9);
  await fundCards(run, ['wall', 'wall', 'wall', 'wall']);
  const oldest = cell(24, 94);
  const consumed = [cell(23, 94), cell(22, 94), cell(21, 94)];
  await run.returnTo(cell(23, 94));
  await run.place('wall', oldest);
  await assertBuildingStats(page, run, oldest, 'Lv.1 · 耐久 25/25 HP');

  await run.returnTo(GENERATED_SPAWN);
  await page.locator('#expedition-spawn').click();
  await page.clock.runFor(1_500);
  assert.equal(await page.locator('#defense-stats').getAttribute('data-wall-impacts'), '1');
  assert.equal(await page.locator('#defense-stats').getAttribute('data-removed'), '1');
  await assertBuildingStats(page, run, oldest, 'Lv.1 · 耐久 24/25 HP');

  for (const [index, stance] of [cell(22, 94), cell(21, 94), cell(21, 93)].entries()) {
    await run.returnTo(stance);
    await run.place('wall', consumed[index], { merge: index === consumed.length - 1 });
  }
  await assertBuildingStats(page, run, oldest, 'Lv.2 · 耐久 49/50 HP');
  assert.equal(await run.building.textContent(), '城墙 (24, 94) · 49 HP · Lv.2');
  assert.equal((await readCardInventory(page)).wall, 0);
  await assertReleasedSites(page, run, consumed);
  await run.game.walkVia(cell(21, 94), cell(23, 94));
  return { seed: 9, oldest, currentHp: 49, maxHp: 50, released: consumed.length };
}

export async function runBuildingTowerUpgradeSmoke(page, baseUrl) {
  const run = await openChallenge(page, baseUrl, 515);
  await fundCards(run, ['tower', 'tower', 'tower', 'tower']);
  const oldest = cell(25, 93);
  const consumed = [cell(24, 93), cell(23, 93), cell(22, 93)];
  const sites = [oldest, ...consumed];
  for (const [index, site] of sites.entries()) {
    await run.returnTo(cell(site.col, 94));
    if (site.col !== 22) await run.mine(site);
    await run.place('tower', site, { merge: index === sites.length - 1 });
    if (index === 0) {
      await assertBuildingStats(page, run, oldest, 'Lv.1 · 伤害 2 · 射程 5 格 · 间隔 350 ms');
    }
  }
  await assertBuildingStats(page, run, oldest, 'Lv.2 · 伤害 5 · 射程 6 格 · 间隔 300 ms');
  assert.equal(await run.building.textContent(), '防御塔 (25, 93) · 1 HP · Lv.2');
  assert.equal((await readCardInventory(page)).tower, 0);
  await assertReleasedSites(page, run, consumed);
  await run.game.walkVia(cell(22, 93), cell(24, 93), cell(24, 94));
  await run.returnTo(GENERATED_SPAWN);

  const openingBalance = Number(await run.cash());
  await startFirstWave(page, run.start);
  const attack = await advanceUntil(page, (round) => round.combat[0]?.towerKills > 0,
    'The upgraded tower must defeat a real 4 HP enemy in the first wave', 2_000);
  const { towerKills, towerHitsOnKills } = attack.combat[0];
  assert.equal(towerHitsOnKills, towerKills, 'Each killed stage-one enemy takes one Lv.2 shot');
  assert.equal(Number(await run.cash()), openingBalance + towerKills * ECONOMY_PROTOTYPE.towerKillReward);
  return { seed: 515, oldest, towerKills, towerHitsOnKills, released: consumed.length };
}

export async function runBuildingEconomyUpgradeSmoke(page, baseUrl) {
  const run = await openChallenge(page, baseUrl, 317);
  await fundCards(run, ['wall', 'economy', 'economy', 'economy', 'economy']);
  const oldest = cell(17, 89);
  const consumed = [cell(18, 89), cell(19, 89), cell(20, 89)];
  await run.returnTo(cell(18, 90));
  await run.place('economy', oldest);
  const placedAt = await now(page);
  await assertBuildingStats(page, run, oldest, 'Lv.1 · 每 4000 ms 产出 1 经济');
  await page.clock.runFor(2_000);
  await run.place('economy', consumed[0]);
  await run.returnTo(cell(19, 90));
  await run.place('economy', consumed[1]);
  await run.place('economy', consumed[2], { merge: true });
  const mergedAt = await now(page);

  await assertBuildingStats(page, run, oldest, 'Lv.2 · 每 4000 ms 产出 2 经济');
  assert.equal(await run.building.textContent(), '经济建筑 (17, 89) · 1 HP · Lv.2');
  assert.equal((await readCardInventory(page)).economy, 0);
  await assertReleasedSites(page, run, consumed);
  await page.clock.runFor(Math.max(0, Math.ceil(3_650 - ((await now(page)) - placedAt))));
  assert.equal(await run.cash(), '0.0', 'The merge itself must not pay a production cycle');
  await page.clock.runFor(Math.max(0, Math.ceil(4_250 - ((await now(page)) - placedAt))));
  assert.ok((await now(page)) - mergedAt < 4_000);
  assert.equal(await run.cash(), '2.0', 'The first upgraded payout keeps the time already earned by the oldest producer');
  await page.clock.runFor(320);
  assert.equal(await run.cash(), '2.0', 'The three removed producers must not get paid');
  return { seed: 317, oldest, firstPayout: Number(await run.cash()), released: consumed.length };
}

import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { ECONOMY_PROTOTYPE } from '../src/expedition-economy.ts';
import { GENERATED_SPAWN } from '../src/generated-map.ts';
import { openWideGame } from './browser-fix02.mjs';

const cardInfo = {
  wall: { name: '城墙', symbol: '▦' },
  tower: { name: '防御塔', symbol: '▲' },
  economy: { name: '经济建筑', symbol: '◆' },
};
const kinds = Object.keys(cardInfo);
const noticeMs = 1_750;
const productionStep = ECONOMY_PROTOTYPE.productionIntervalMs;
const startingCash = ECONOMY_PROTOTYPE.initialBalance;
const drawCost = ECONOMY_PROTOTYPE.drawCost;

export async function readCardInventory(page) {
  return Object.fromEntries(await Promise.all(kinds.map(async (kind) => {
    const amount = await page.locator(`#card-${kind}`).getAttribute('data-count');
    assert.match(amount ?? '', /^\d+$/);
    return [kind, Number(amount)];
  })));
}

export async function assertVisibleCardDraw(page, kind, before) {
  const info = cardInfo[kind];
  assert.ok(info, `Unexpected manufactured card: ${kind}`);
  const result = page.locator('#card-draw-result');
  assert.ok(await result.isVisible(), 'The acquisition result must be visible');
  assert.equal(await result.getAttribute('role'), 'status');
  assert.equal(await result.getAttribute('data-card'), kind);
  assert.ok(await page.locator('#card-draw-symbol').isVisible());
  assert.equal(await page.locator('#card-draw-symbol').textContent(), info.symbol);
  assert.equal(await page.locator('#card-draw-text').textContent(),
    `获得：一级${info.name}卡 ×1 · 库存：${before} → ${before + 1}`);
  assert.equal(await page.locator(`#card-${kind}`).getAttribute('data-count'), String(before + 1));
  for (const slot of kinds) {
    const highlighting = await page.locator(`#card-${slot}`).getAttribute('data-drawn');
    assert.equal(highlighting === 'true', slot === kind, 'Only the latest draw must highlight its slot');
  }
}

async function clickDisabledMaker(page, button) {
  assert.ok(await button.isDisabled());
  await button.scrollIntoViewIfNeeded();
  const rect = await button.boundingBox();
  assert.ok(rect, 'The unavailable action must remain visible');
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

function boxShadow(locator) {
  return locator.evaluate((node) => getComputedStyle(node).boxShadow);
}

export async function runCardFeedbackSmoke(page, url) {
  const game = await openWideGame(page, url);
  const make = page.locator('#make-card');
  const reason = page.locator('#card-draw-reason');
  const result = page.locator('#card-draw-result');
  const summary = page.locator('#card-draw-summary');
  const balance = page.locator('#economy-balance');
  const roundUrl = page.url();

  async function place(kind, target) {
    await page.locator(`#card-${kind}`).click();
    await game.inspect(target, '空地');
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await page.clock.runFor(32);
  }

  async function fundThirdDraw() {
    await place('economy', { col: 20, row: 91 });
    await page.clock.runFor(productionStep + 100);
    assert.equal(Number(await balance.textContent()), startingCash + ECONOMY_PROTOTYPE.productionAmount);
  }

  async function draw(expected) {
    const before = await readCardInventory(page);
    const cash = Number(await balance.textContent());
    await make.click();
    await assertVisibleCardDraw(page, expected, before[expected]);
    assert.equal(Number(await balance.textContent()), cash - drawCost);
    assert.deepEqual(await readCardInventory(page), { ...before, [expected]: before[expected] + 1 });
  }

  async function assertUnobstructed() {
    const notice = await result.boundingBox();
    const board = await page.locator('#board').boundingBox();
    assert.ok(notice && board);
    assert.ok(notice.x >= board.x + board.width || notice.y >= board.y + board.height,
      'Acquisition feedback must not cover the play area');
    assert.ok(await result.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      'Acquisition feedback must fit its panel width');
  }

  assert.ok(await page.locator('#expedition-spawn').isHidden());
  assert.ok(await result.isHidden());
  await fundThirdDraw();
  const regularWall = await boxShadow(page.locator('#card-wall'));
  await draw('wall');
  const firstAt = await page.evaluate(() => Date.now());
  assert.notEqual(await boxShadow(page.locator('#card-wall')), regularWall, 'The highlighted slot must have a visual cue');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'make-card');
  await game.walkTo({ col: 20, row: 92 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'make-card');
  assert.ok(await result.isVisible(), 'WASD must work while acquisition feedback is visible');
  const buildingCell = { col: 21, row: 91 };
  await place('wall', buildingCell);
  assert.equal(await page.locator('#expedition-feedback').textContent(), '已建造城墙 (21, 91)');
  assert.ok(await result.isVisible(), 'A new-card notification must not interrupt canvas construction');

  await draw('economy');
  await draw('tower');
  const latestAt = await page.evaluate(() => Date.now());
  assert.ok(latestAt - firstAt < noticeMs, 'The three draws must exercise overlapping notification lifetimes');
  const allThree = '本局获得 · 城墙 1 · 防御塔 1 · 经济建筑 1';
  assert.equal(await summary.textContent(), allThree);
  assert.equal(await balance.textContent(), '0');
  assert.equal(await reason.textContent(), `经济不足，需要 ${drawCost} 经济`);
  assert.ok(await reason.isVisible());
  assert.equal(await make.getAttribute('aria-describedby'), 'card-draw-reason');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.clock.runFor(48);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  const desktopNotice = await result.boundingBox();
  assert.ok(desktopNotice && desktopNotice.y >= 0 && desktopNotice.y + desktopNotice.height <= page.viewportSize().height,
    'The desktop acquisition result must be completely visible without scrolling');
  await assertUnobstructed();

  if (process.env.ESTD_CARD_SCREENSHOT) {
    assert.ok(isAbsolute(process.env.ESTD_CARD_SCREENSHOT), 'Use an absolute screenshot-evidence path');
    await page.screenshot({ path: process.env.ESTD_CARD_SCREENSHOT, fullPage: true });
  }

  const defaultViewport = page.viewportSize();
  await page.setViewportSize({ width: 540, height: 900 });
  await page.clock.runFor(64);
  await assertVisibleCardDraw(page, 'tower', ECONOMY_PROTOTYPE.initialCards.tower);
  await assertUnobstructed();
  await page.setViewportSize(defaultViewport);
  await page.clock.runFor(64);

  const currentTime = await page.evaluate(() => Date.now());
  const afterOldExpiry = firstAt + noticeMs + 32 - currentTime;
  assert.ok(afterOldExpiry > 0 && currentTime + afterOldExpiry < latestAt + noticeMs,
    'The first draw must expire while the latest is still active');
  await page.clock.runFor(afterOldExpiry);
  await assertVisibleCardDraw(page, 'tower', ECONOMY_PROTOTYPE.initialCards.tower);
  await page.clock.runFor(latestAt + noticeMs + 64 - (currentTime + afterOldExpiry));
  assert.ok(await result.isHidden());
  assert.equal(await summary.textContent(), allThree, 'Expired prompts must leave the acquisition history');
  for (const kind of kinds) assert.notEqual(await page.locator(`#card-${kind}`).getAttribute('data-drawn'), 'true');

  const beforeFailure = await readCardInventory(page);
  await clickDisabledMaker(page, make);
  assert.equal(await balance.textContent(), '0');
  assert.deepEqual(await readCardInventory(page), beforeFailure);
  assert.ok(await result.isHidden(), 'An unaffordable attempt must not produce acquisition feedback');
  await page.clock.runFor(productionStep * drawCost);
  assert.equal(await balance.textContent(), String(drawCost));
  // Seed 1's fourth card is tower, while its fifth is wall.
  await draw('tower');

  await game.holdKey('KeyR', () => page.clock.runFor(48));
  assert.equal(page.url(), roundUrl);
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
  assert.equal(await balance.textContent(), String(startingCash));
  assert.deepEqual(await readCardInventory(page), ECONOMY_PROTOTYPE.initialCards);
  assert.ok(await result.isHidden());
  assert.equal(await summary.textContent(), '');
  await fundThirdDraw();
  for (const kind of ['wall', 'economy', 'tower']) await draw(kind);
  assert.equal(await summary.textContent(), allThree, 'R must reproduce the three-card sequence at the same seed');
}

export async function runDestroyedTechFeedbackSmoke(page, url) {
  const game = await openWideGame(page, url);
  const rebuild = page.locator('#rebuild-technology');
  const make = page.locator('#make-card');
  const result = page.locator('#card-draw-result');
  const phase = page.locator('#round-state');
  const tech = ECONOMY_PROTOTYPE.technologyCell;
  await game.inspect(tech, '空地');
  await page.clock.runFor(32);
  assert.match(await page.locator('#expedition-building').textContent(), /^科技设施/);
  await game.walkTo({ col: 19, row: 84 }, true);
  await game.walkTo({ col: 22, row: 84 }, true);
  for (let elapsed = 0; elapsed < 60_000 && !await rebuild.isVisible(); elapsed += 256) {
    assert.notEqual(await phase.getAttribute('data-phase'), 'lost', 'The player must stay alive while the facility is attacked');
    await page.clock.runFor(256);
  }
  assert.ok(await rebuild.isVisible(), 'Scheduled enemies must actually destroy the technology facility');
  assert.notEqual(await phase.getAttribute('data-phase'), 'lost');
  await game.inspect(tech, '空地');
  await page.clock.runFor(32);
  assert.equal(await page.locator('#expedition-building').textContent(), '—');
  assert.match(await page.locator('#expedition-feedback').textContent(), /科技设施.+受袭.+已摧毁/);
  const reason = page.locator('#card-draw-reason');
  assert.ok(await reason.isVisible());
  assert.match(await reason.textContent(), /科技设施已损毁/);
  assert.equal(await page.locator('#economy-balance').textContent(), String(startingCash));
  const beforeFailure = await readCardInventory(page);
  await clickDisabledMaker(page, make);
  assert.deepEqual(await readCardInventory(page), beforeFailure);
  assert.equal(await page.locator('#economy-balance').textContent(), String(startingCash));
  assert.ok(await result.isHidden());
}

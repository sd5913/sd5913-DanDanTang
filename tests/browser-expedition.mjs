import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE, TECHNOLOGY_PROTOTYPE } from '../src/expedition-economy.ts';
import { EXPEDITION_STRATA, PLAY_GENERATOR_VERSION } from '../src/expedition-terrain.ts';
import { GENERATED_SPAWN } from '../src/generated-map.ts';
import { MINING_CONFIG, TERRAIN_HP_BY_LEVEL } from '../src/mining-config.ts';
import { assertVisibleCardDraw } from './browser-card-feedback.mjs';
import { openWideGame, playFixture, readCanvasFingerprint } from './browser-fix02.mjs';

const starterCards = { wall: 4, tower: 2, economy: 1 };
const technologyCell = { col: 17, row: 90 };
const economyCell = { col: 21, row: 90 };
// Leave a few open tiles between the spawn and the tower so this measures a shot, not immediate contact.
const towerCell = { col: 27, row: 94 };
const formatCell = (cell) => `(${cell.col}, ${cell.row})`;

export async function runExpeditionSmoke(page, url) {
  const game = await openWideGame(page, url);
  const cards = Object.fromEntries(Object.keys(starterCards).map((kind) => [kind, page.locator(`#card-${kind}`)]));
  const economyBalance = page.locator('#economy-balance');
  const building = page.locator('#expedition-building');
  const feedback = page.locator('#expedition-feedback');
  const makeCard = page.locator('#make-card');
  const spawnEnemy = page.locator('#expedition-spawn');

  async function balance() {
    const value = await economyBalance.textContent();
    const match = value.match(/\d+/);
    assert.ok(match, `Expected a visible economy balance, saw ${value}`);
    return Number(match[0]);
  }

  async function inventory() {
    const counts = await Promise.all(Object.entries(cards).map(async ([kind, button]) => {
      const value = await button.getAttribute('data-count');
      assert.match(value ?? '', /^\d+$/, `Expected a card count for ${kind}`);
      return [kind, Number(value)];
    }));
    return Object.fromEntries(counts);
  }

  async function buildingAt(cell) {
    await game.inspect(cell, '空地');
    await page.clock.runFor(32);
    return building.textContent();
  }

  async function selectCard(kind) {
    const button = cards[kind];
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
  }

  async function clickAt(cell, ...details) {
    await game.inspect(cell, ...details);
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await page.clock.runFor(32);
  }

  async function build(kind, cell) {
    await selectCard(kind);
    await clickAt(cell, '空地');
  }

  async function manufacture() {
    const startBalance = await balance();
    const before = await inventory();
    await makeCard.click();
    await page.clock.runFor(32);
    assert.equal(await balance(), startBalance - ECONOMY_PROTOTYPE.drawCost);
    const after = await inventory();
    const kinds = Object.keys(before);
    const differences = kinds.map((kind) => after[kind] - before[kind]);
    assert.deepEqual(differences.toSorted((a, b) => a - b), [0, 0, 1]);
    const kind = kinds[differences.indexOf(1)];
    await assertVisibleCardDraw(page, kind, before[kind]);
    return differences;
  }

  const roundUrl = page.url();
  async function assertFreshRound() {
    assert.equal(page.url(), roundUrl);
    assert.deepEqual(await game.position(), GENERATED_SPAWN);
    assert.equal(await balance(), 8);
    assert.deepEqual(await inventory(), starterCards);
    for (const button of Object.values(cards)) assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.match(await buildingAt(technologyCell), /^科技设施 \(17, 90\)/);
    assert.ok(await makeCard.isEnabled());
  }

  async function reset() {
    await game.holdKey('KeyR', () => page.clock.runFor(48));
    await assertFreshRound();
  }

  assert.ok(await page.locator('#expedition-panel').isVisible());
  assert.ok(await page.locator('#defense-panel').isHidden());
  await assertFreshRound();

  const walls = [16, 17, 18, 19].map((col) => ({ col, row: 88 }));
  const [anchor] = walls;
  const released = walls.at(-1);
  assert.equal(await buildingAt(anchor), '—');
  for (const key of ['KeyB', 'KeyT']) await game.holdKey(key, () => page.clock.runFor(48));
  assert.equal(await buildingAt(anchor), '—', 'Debug keys must not place free buildings in play mode');
  await game.inspect(technologyCell, '空地');
  await game.holdKey('KeyX', () => page.clock.runFor(48));
  assert.match(await buildingAt(technologyCell), /^科技设施/, 'Debug key X must not remove a play-mode building');
  assert.deepEqual(await inventory(), starterCards);

  const dirt = { col: GENERATED_SPAWN.col, row: GENERATED_SPAWN.row + 1 };
  await selectCard('wall');
  await clickAt(dirt, '可挖地形', 'HP 5/5');
  await game.inspect(dirt, '可挖地形', 'HP 5/5');
  assert.deepEqual(await inventory(), starterCards, 'An invalid placement must not consume cards');
  assert.equal(await balance(), 8, 'An invalid placement must not consume economy');
  assert.equal(await cards.wall.getAttribute('aria-pressed'), 'true');

  await game.walkVia({ col: 19, row: 89 }, { col: 17, row: 89 });
  for (const [index, cell] of walls.entries()) {
    if (index === 3) await game.walkVia({ col: 18, row: 89 });
    await build('wall', cell);
    assert.equal((await inventory()).wall, starterCards.wall - index - 1);
  }
  assert.equal(await feedback.textContent(), `已合成城墙 Lv.2 ${formatCell(anchor)}`);
  assert.match(await buildingAt(anchor), /^城墙 \(16, 88\) · \d+ HP · Lv\.2$/);
  for (const cell of walls.slice(1)) assert.equal(await buildingAt(cell), '—');
  await game.walkVia({ col: 19, row: 89 }, released);

  await game.walkVia({ col: 19, row: 89 }, { col: 20, row: 89 });
  await build('economy', economyCell);
  assert.match(await buildingAt(economyCell), /^经济建筑 \(21, 90\)/);
  assert.equal((await inventory()).economy, 0);
  assert.equal(await balance(), 8, 'Building from inventory must not charge economy');
  await page.clock.runFor(ECONOMY_PROTOTYPE.productionIntervalMs - 300);
  assert.equal(await balance(), 8, 'The economy building must wait for its production interval');
  await page.clock.runFor(450);
  assert.equal(await balance(), 8 + ECONOMY_PROTOTYPE.productionAmount);

  const firstDraw = await manufacture();
  await reset();
  assert.equal(await buildingAt(anchor), '—');
  assert.equal(await buildingAt(economyCell), '—');
  assert.deepEqual(await manufacture(), firstDraw, 'The first draw must repeat after the same-seed reset');
  await manufacture();
  assert.ok(await makeCard.isDisabled(), 'Manufacture must be unavailable when the cost is not covered');

  await reset();
  await game.walkVia({ col: 21, row: 92 }, { col: 21, row: 94 }, { col: 26, row: 94 });
  await game.settleView();
  await build('tower', towerCell);
  assert.match(await buildingAt(towerCell), /^防御塔 \(27, 94\)/);
  assert.equal((await inventory()).tower, starterCards.tower - 1);
  await spawnEnemy.click();
  await page.clock.runFor(64);
  assert.equal(await page.locator('#defense-stats').getAttribute('data-tower-kills'), '1');
  assert.equal(await page.locator('#defense-stats').getAttribute('data-wall-impacts'), '0');
  assert.equal(await page.locator('#defense-stats').getAttribute('data-building-contacts'), '0');
  assert.equal(await balance(), 8 + ECONOMY_PROTOTYPE.towerKillReward);
}

export async function runResearchSmoke(page, url) {
  const { layout, biomes } = playFixture();
  const game = await openWideGame(page, url, layout);
  const tool = page.locator('#tool-level');
  const research = page.locator('#research-tool');
  const balance = page.locator('#economy-balance');
  const hover = page.locator('#hover-cell');
  const center = (row) => ({ col: GENERATED_SPAWN.col, row });
  const firstDirt = center(83);
  const { transitionNorthRow, transitionSouthRow, bodySouthRow } = EXPEDITION_STRATA;
  const advancedRow = layout.findLastIndex((line, row) => row < GENERATED_SPAWN.row && line[GENERATED_SPAWN.col] === '2');
  assert.ok(advancedRow >= transitionNorthRow && advancedRow <= transitionSouthRow);
  const advancedDirt = center(advancedRow);
  const beforeGate = center(advancedRow + 1);
  const transitionLow = [beforeGate.col + 1, beforeGate.col - 1]
    .map((col) => ({ col, row: beforeGate.row }))
    .find((cell) => layout[cell.row][cell.col] === '+'
      && biomes[cell.row][cell.col] === biomes[advancedDirt.row][advancedDirt.col]);
  assert.ok(transitionLow && transitionLow.row <= transitionSouthRow, 'The same transition stance must see both dirt levels');
  const bodyRows = layout.flatMap((line, row) => row >= 50 && row <= bodySouthRow && line[GENERATED_SPAWN.col] === '2' ? [row] : []);
  const firstBody = bodyRows.at(-1);
  const deeperBody = bodyRows.findLast((row) => row <= firstBody - 4);
  assert.ok(firstBody !== undefined && deeperBody !== undefined, 'The fixture must have two separated body cells on the route');
  const advancedHp = TERRAIN_HP_BY_LEVEL[2];
  const lowHp = TERRAIN_HP_BY_LEVEL[1];

  async function holdMining(ms) {
    await page.mouse.down({ button: 'left' });
    try {
      if (ms > 0) await page.clock.runFor(ms);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
  }

  async function assertGateBlocked() {
    await game.holdKey('KeyW', () => page.clock.runFor(500));
    assert.deepEqual(await game.position(), beforeGate);
  }

  async function inspectDirt(cell, tier, hp) {
    await game.inspect(cell, '可挖地形', `HP ${hp}/${TERRAIN_HP_BY_LEVEL[tier]}`, `Lv.${tier}`);
    assert.equal(await hover.getAttribute('data-visibility'), 'visible');
  }

  const startingUrl = page.url();
  assert.equal(await tool.textContent(), 'Lv.1');
  assert.equal(await balance.textContent(), '8');
  assert.ok(await research.isDisabled());
  await game.walkVia({ col: 19, row: 91 }, { col: 20, row: 91 });
  await page.locator('#card-economy').click();
  await game.inspect(economyCell, '空地');
  await holdMining(32);
  assert.equal(await page.locator('#card-economy').getAttribute('data-count'), '0');
  await page.clock.runFor(ECONOMY_PROTOTYPE.productionIntervalMs + 100);
  assert.equal(await balance.textContent(), '9');
  assert.ok(await research.isDisabled());
  await page.clock.runFor(ECONOMY_PROTOTYPE.productionIntervalMs);
  assert.equal(await balance.textContent(), '10');
  assert.ok(await research.isEnabled());

  await game.walkVia(center(91), center(84));
  await inspectDirt(firstDirt, 1, lowHp);
  await game.openLineTo(firstDirt);
  await game.openLineTo(beforeGate);
  await inspectDirt(transitionLow, 1, lowHp);
  const basicColor = await game.tilePixel(transitionLow);
  await inspectDirt(advancedDirt, 2, advancedHp);
  const advancedColor = await game.tilePixel(advancedDirt);
  assert.notDeepEqual(advancedColor, basicColor, 'Fog-visible first and second-tier dirt must look different in the same biome');
  await holdMining(MINING_CONFIG.attackIntervalMs * 2);
  assert.match(await page.locator('#dig-result').textContent(), /需要二级挖掘工具/);
  await inspectDirt(advancedDirt, 2, advancedHp);
  await assertGateBlocked();

  await inspectDirt(advancedDirt, 2, advancedHp);
  await holdMining(0);
  await inspectDirt(transitionLow, 1, lowHp);
  await holdMining(0);
  await inspectDirt(transitionLow, 1, lowHp - 1);
  await page.clock.runFor(MINING_CONFIG.attackIntervalMs + 32);

  const beforeResearch = Number(await balance.textContent());
  await research.click();
  assert.equal(await tool.textContent(), 'Lv.2');
  assert.equal(Number(await balance.textContent()), beforeResearch - TECHNOLOGY_PROTOTYPE.researchCost);
  assert.ok(await research.isDisabled());
  await inspectDirt(advancedDirt, 2, advancedHp);
  const intact = await game.tilePixel(advancedDirt);
  await holdMining(Math.floor(MINING_CONFIG.attackIntervalMs / 2));
  await inspectDirt(advancedDirt, 2, advancedHp - 1);
  assert.notDeepEqual(await game.tilePixel(advancedDirt), intact, 'Second-tier damage must be visible');
  await assertGateBlocked();

  await game.walkTo(center(74));
  await game.walkTo(beforeGate);
  assert.equal(await tool.textContent(), 'Lv.2');
  await inspectDirt(advancedDirt, 2, advancedHp - 1);
  await holdMining(advancedHp * MINING_CONFIG.attackIntervalMs + 64);
  await game.inspect(advancedDirt, '空地');
  await game.walkTo(advancedDirt);
  for (const row of [firstBody, deeperBody]) {
    await game.openLineTo(center(row + 1));
    assert.match(await page.locator('#chunk-status').textContent(), /, 1\)$/);
    await inspectDirt(center(row), 2, advancedHp);
    await game.openLineTo(center(row), true);
    await game.inspect(center(row), '空地');
  }

  await game.holdKey('KeyR', () => page.clock.runFor(48));
  assert.equal(page.url(), startingUrl);
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
  assert.equal(await tool.textContent(), 'Lv.1');
  assert.equal(await balance.textContent(), '8');
  assert.ok(await research.isDisabled());
  await game.openLineTo(beforeGate);
  await inspectDirt(advancedDirt, 2, advancedHp);
  await inspectDirt(transitionLow, 1, lowHp);
  await assertGateBlocked();
  return { gateRow: advancedRow, advancedBodyRows: [firstBody, deeperBody] };
}

export async function runStrataSeedSmoke(page, url) {
  const freshSeed = 13;
  await page.addInitScript((nextSeed) => {
    const original = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(crypto, 'getRandomValues', { value(values) {
      if (!(values instanceof Uint32Array) || values.length !== 1) return original(values);
      values[0] = nextSeed;
      return values;
    } });
  }, freshSeed);
  assert.equal(PLAY_GENERATOR_VERSION, 4);
  const game = await openWideGame(page, url);
  const seedLabel = page.locator('#map-size');
  const initial = await seedLabel.textContent();
  assert.match(initial, /种子 12 · 生成器 v4 · 备用布局 未启用/);
  const canvas = await readCanvasFingerprint(page);

  await page.clock.resume();
  assert.equal((await page.reload())?.status(), 200);
  await page.waitForFunction(() => Number(document.querySelector('#visible-chunks')?.dataset.worldWidth) > 0);
  assert.equal(await seedLabel.textContent(), initial);
  assert.deepEqual(await readCanvasFingerprint(page), canvas, 'Version four must reproduce the initial canvas at seed 12');

  await Promise.all([
    page.waitForURL((next) => next.searchParams.get('seed') === String(freshSeed)),
    page.getByRole('button', { name: '新开一局', exact: true }).click(),
  ]);
  await page.waitForFunction(() => Number(document.querySelector('#visible-chunks')?.dataset.worldWidth) > 0);
  const newUrl = new URL(page.url());
  assert.equal(newUrl.searchParams.get('mode'), 'play');
  assert.equal(newUrl.searchParams.get('seed'), String(freshSeed));
  assert.match(await seedLabel.textContent(), /种子 13 · 生成器 v4 · 备用布局 未启用/);
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
}

export async function runBiomeFogSmoke(page, url) {
  const game = await openWideGame(page, url, playFixture().layout);
  const hover = page.locator('#hover-cell');
  const biome = page.locator('#expedition-biome');
  const target = { col: GENERATED_SPAWN.col, row: 83 };
  const northernStep = { col: GENERATED_SPAWN.col, row: 90 };
  const plain = { col: GENERATED_SPAWN.col, row: 73 };
  const lakeShore = { col: GENERATED_SPAWN.col, row: 50 };
  const water = { col: lakeShore.col + 1, row: lakeShore.row };
  const roundUrl = page.url();

  async function interactWith(cell, ...details) {
    await game.inspect(cell, ...details);
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await page.clock.runFor(32);
  }

  async function observe(visibility) {
    await game.aimAt(target);
    await page.clock.runFor(32);
    assert.equal(await hover.getAttribute('data-visibility'), visibility);
    const label = await hover.textContent();
    if (visibility === 'visible') {
      assert.match(label, /可挖地形.*\(19, 83\).*HP 5\/5/);
    } else {
      assert.doesNotMatch(label, /HP|可挖地形|不可破坏岩石|空地|水域/,
        'A tile outside current vision must not disclose its live terrain and HP');
    }
    return game.tilePixel(target);
  }

  const hidden = await observe('unknown');
  await game.walkTo(northernStep);
  const visible = await observe('visible');
  assert.notDeepEqual(visible, hidden, 'A fully hidden tile must be drawn differently from a visible tile');

  await game.walkTo(GENERATED_SPAWN);
  const explored = await observe('explored');
  assert.notDeepEqual(explored, visible, 'An explored tile outside vision must be dimmed');
  assert.notDeepEqual(explored, hidden, 'Explored terrain must remain distinguishable from unknown terrain');

  await game.holdKey('KeyR', () => page.clock.runFor(48));
  assert.equal(page.url(), roundUrl);
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
  assert.deepEqual(await observe('unknown'), hidden, 'R must clear exploration memory for the same seed');

  await game.walkVia({ col: 19, row: 91 }, { col: 20, row: 91 });
  await page.locator('#card-economy').click();
  await interactWith(economyCell, '空地');
  await page.clock.runFor(2 * ECONOMY_PROTOTYPE.productionIntervalMs + 150);
  await page.locator('#research-tool').click();
  await game.walkVia({ col: 19, row: 91 });
  await game.openLineTo(plain);
  assert.equal(await biome.textContent(), '平原', 'An excavated plain tile must preserve its biome');
  await game.openLineTo(lakeShore);
  assert.equal(await biome.textContent(), '湖泊');
  await interactWith(water, '水域');
  assert.match(await page.locator('#dig-result').textContent(), /水域不可挖掘/);
  await game.holdKey('KeyD', () => page.clock.runFor(500));
  assert.deepEqual(await game.position(), lakeShore, 'Water must block movement from the dry shore');
  await game.inspect(water, '水域');

  await page.clock.resume();
  const debugUrl = new URL(roundUrl);
  debugUrl.searchParams.set('fog', 'off');
  assert.equal((await page.goto(debugUrl.href))?.status(), 200);
  await page.waitForFunction(() => Number(document.querySelector('#visible-chunks')?.dataset.worldWidth) > 0);
  await game.inspect(target, '可挖地形', 'HP 5/5');
  assert.equal(await hover.getAttribute('data-visibility'), null, 'The explicit fog-off view must show actual terrain');
}

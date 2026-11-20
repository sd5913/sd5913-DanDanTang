import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE } from '../src/expedition-economy.ts';
import { generateExpeditionBiomes } from '../src/expedition-biomes.ts';
import { addExpeditionTiers } from '../src/expedition-terrain.ts';
import { GENERATED_SPAWN, generateExpeditionMap } from '../src/generated-map.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { openWideGame } from './browser-fix02.mjs';

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
    const differences = Object.keys(before).map((kind) => after[kind] - before[kind]);
    assert.deepEqual(differences.toSorted((a, b) => a - b), [0, 0, 1]);
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

  for (const [index, cell] of walls.entries()) {
    await build('wall', cell);
    assert.equal((await inventory()).wall, starterCards.wall - index - 1);
  }
  assert.equal(await feedback.textContent(), `已合成城墙 Lv.2 ${formatCell(anchor)}`);
  assert.match(await buildingAt(anchor), /^城墙 \(16, 88\) · \d+ HP · Lv\.2$/);
  for (const cell of walls.slice(1)) assert.equal(await buildingAt(cell), '—');
  await game.walkTo(released);

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
  await game.openLineTo({ col: 28, row: 92 });
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
  const game = await openWideGame(page, url);
  const tool = page.locator('#tool-level');
  const research = page.locator('#research-tool');
  const balance = page.locator('#economy-balance');
  const center = (row) => ({ col: GENERATED_SPAWN.col, row });
  const firstDirt = center(83);
  const beforeSeam = center(64);
  const advancedDirt = center(63);

  async function holdMining(ms) {
    await page.mouse.down({ button: 'left' });
    try {
      await page.clock.runFor(ms);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
  }

  async function assertSeamBlocked() {
    await game.holdKey('KeyW', () => page.clock.runFor(500));
    assert.deepEqual(await game.position(), beforeSeam);
  }

  const startingUrl = page.url();
  assert.equal(await tool.textContent(), 'Lv.1');
  assert.equal(await balance.textContent(), '8');
  assert.ok(await research.isDisabled());
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

  await game.walkTo(center(84));
  await game.inspect(firstDirt, '可挖地形', 'HP 5/5');
  await game.openLineTo(firstDirt);
  await game.openLineTo(beforeSeam);
  await game.inspect(advancedDirt, '可挖地形', 'HP 8/8');
  await holdMining(MINING_CONFIG.attackIntervalMs * 2);
  assert.match(await page.locator('#dig-result').textContent(), /需要更高等级的工具/);
  await game.inspect(advancedDirt, 'HP 8/8');
  await assertSeamBlocked();

  const beforeResearch = Number(await balance.textContent());
  await research.click();
  assert.equal(await tool.textContent(), 'Lv.2');
  assert.equal(Number(await balance.textContent()), beforeResearch - 10);
  assert.ok(await research.isDisabled());
  await game.inspect(advancedDirt, 'HP 8/8');
  const intact = await game.tilePixel(advancedDirt);
  await holdMining(Math.floor(MINING_CONFIG.attackIntervalMs / 2));
  await game.inspect(advancedDirt, 'HP 7/8');
  assert.notDeepEqual(await game.tilePixel(advancedDirt), intact, 'Second-tier damage must be visible');
  await assertSeamBlocked();

  await game.walkTo(center(74));
  await game.walkTo(beforeSeam);
  assert.equal(await tool.textContent(), 'Lv.2');
  await game.inspect(advancedDirt, 'HP 7/8');
  await holdMining(8 * MINING_CONFIG.attackIntervalMs + 64);
  await game.inspect(advancedDirt, '空地');
  await game.walkTo(advancedDirt);
  assert.match(await page.locator('#chunk-status').textContent(), /, 1\)$/);

  await game.holdKey('KeyR', () => page.clock.runFor(48));
  assert.equal(page.url(), startingUrl);
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
  assert.equal(await tool.textContent(), 'Lv.1');
  assert.equal(await balance.textContent(), '8');
  assert.ok(await research.isDisabled());
  await game.openLineTo(beforeSeam);
  await game.inspect(advancedDirt, '可挖地形', 'HP 8/8');
  await assertSeamBlocked();
}

export async function runBiomeFogSmoke(page, url) {
  const seeded = generateExpeditionBiomes(generateExpeditionMap(12), 12);
  const game = await openWideGame(page, url, addExpeditionTiers(seeded.layout));
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

  await page.locator('#card-economy').click();
  await interactWith(economyCell, '空地');
  await page.clock.runFor(2 * ECONOMY_PROTOTYPE.productionIntervalMs + 150);
  await page.locator('#research-tool').click();
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

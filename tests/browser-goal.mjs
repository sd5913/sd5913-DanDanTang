import assert from 'node:assert/strict';
import { BIOME_NAMES } from '../src/biome-effects.ts';
import { generateExpeditionBiomes } from '../src/expedition-biomes.ts';
import { ECONOMY_PROTOTYPE, TECHNOLOGY_PROTOTYPE } from '../src/expedition-economy.ts';
import { PROTOTYPE_ONLY } from '../src/expedition-round.ts';
import { addExpeditionApproach, addExpeditionTiers, EXPEDITION_STRATA } from '../src/expedition-terrain.ts';
import { GENERATED_GOAL, GENERATED_SPAWN, generateExpeditionMap } from '../src/generated-map.ts';
import { assertVisibleCardDraw, readCardInventory } from './browser-card-feedback.mjs';
import { openWideGame } from './browser-fix02.mjs';

const seed = 12;
const { layout: biomeLayout, biomes } = generateExpeditionBiomes(generateExpeditionMap(seed), seed);
const layout = addExpeditionApproach(addExpeditionTiers(biomeLayout, seed));

async function readRound(page) {
  return page.evaluate(() => {
    const text = (id) => document.getElementById(id).textContent;
    const numeric = (id) => Number(text(id).match(/\d+/)?.[0]);
    const stats = document.getElementById('defense-stats').dataset;
    return {
      phase: document.getElementById('round-state').dataset.phase,
      label: text('round-state'),
      hp: numeric('player-hp'),
      wave: numeric('round-wave'),
      pressure: numeric('round-pressure'),
      stage: numeric('round-stage'),
      requested: Number(stats.requested),
      active: Number(stats.active),
      pending: Number(stats.pending),
      towerKills: Number(stats.towerKills),
    };
  });
}

async function awaitRound(page, condition, description, budgetMs = 10_000) {
  const tickMs = 64;
  let current = await readRound(page);
  for (let elapsed = 0; !condition(current) && elapsed < budgetMs; elapsed += tickMs) {
    const previous = current;
    await page.clock.runFor(tickMs);
    current = await readRound(page);
    if (condition(current, previous)) return current;
  }
  assert.ok(condition(current), `${description}. Last round state: ${JSON.stringify(current)}`);
  return current;
}

async function assertTerminal(page, game, outcome) {
  const terminal = await readRound(page);
  const position = await game.position();
  assert.equal(terminal.phase, outcome);
  assert.equal(terminal.active, 0);
  assert.equal(terminal.pending, 0);
  await game.holdKey('KeyS', () => page.clock.runFor(700));
  await page.clock.runFor(PROTOTYPE_ONLY.fast.recoveringMs);
  assert.deepEqual(await game.position(), position, 'Terminal rounds must stop player movement');
  assert.deepEqual(await readRound(page), terminal, 'Terminal rounds must stop wave and combat updates');
}

export async function runLossSmoke(page, url) {
  const game = await openWideGame(page, url, layout);
  const initial = await readRound(page);
  assert.equal(initial.phase, 'preparing');
  assert.equal(initial.hp, PROTOTYPE_ONLY.playerHp);
  assert.equal(initial.wave, 0);
  assert.ok(await page.locator('#expedition-spawn').isHidden());

  await game.walkTo({ col: 21, row: 92 }, true);
  await game.walkTo({ col: 21, row: 94 }, true);
  await game.walkTo({ col: 25, row: 94 });
  const attack = await awaitRound(page, (state) => state.phase === 'attacking' && state.wave === 1,
    'The first wave must start without a debug spawn');
  assert.equal(attack.requested, PROTOTYPE_ONLY.baseWaveCount);
  const recovery = await awaitRound(page, (state) => state.phase === 'recovering' && state.wave === 1,
    'The first wave must finish when its enemies have resolved');
  assert.equal(recovery.hp, 1, 'Three real contacts must spend three of four player HP');
  const loss = await awaitRound(page, (state) => state.phase === 'lost', 'The next real enemy contact must cause defeat');
  assert.equal(loss.hp, 0);
  assert.match(loss.label, /战败|失败/);
  await assertTerminal(page, game, 'lost');

  const sameSeed = page.url();
  await game.holdKey('KeyR', () => page.clock.runFor(48));
  assert.equal(page.url(), sameSeed);
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
  const reset = await readRound(page);
  assert.equal(reset.phase, 'preparing');
  assert.equal(reset.hp, PROTOTYPE_ONLY.playerHp);
  assert.equal(reset.wave, 0);
  assert.equal(reset.pressure, 0);
  return { hp: loss.hp, wave: loss.wave, firstWaveSize: attack.requested, hpAfterFirstWave: recovery.hp };
}

export function findDiggablePath(blockers) {
  const start = GENERATED_SPAWN;
  const goal = GENERATED_GOAL;
  const width = layout[0].length;
  const index = ({ col, row }) => row * width + col;
  const cell = (value) => ({ col: value % width, row: Math.floor(value / width) });
  const occupied = new Set(blockers.map(index));
  const distance = new Float64Array(width * layout.length).fill(Infinity);
  const previous = new Int32Array(width * layout.length).fill(-1);
  const frontier = [{ id: index(start), cost: 0 }];
  distance[index(start)] = 0;

  while (frontier.length) {
    frontier.sort((a, b) => b.cost - a.cost);
    const { id, cost } = frontier.pop();
    if (cost !== distance[id]) continue;
    if (id === index(goal)) break;
    const { col, row } = cell(id);
    const neighbors = [{ col, row: row - 1 }, { col: col - 1, row }, { col: col + 1, row }, { col, row: row + 1 }];
    for (const next of neighbors) {
      const marker = layout[next.row]?.[next.col];
      const idNext = index(next);
      if (!marker || marker === '#' || marker === '~' || occupied.has(idNext) || (marker === 'G' && idNext !== index(goal))) continue;
      const nextCost = cost + (marker === '2' ? 6 : marker === '+' ? 4 : 1);
      if (nextCost >= distance[idNext]) continue;
      distance[idNext] = nextCost;
      previous[idNext] = id;
      frontier.push({ id: idNext, cost: nextCost });
    }
  }

  const path = [];
  for (let id = index(goal); id !== -1; id = previous[id]) path.push(cell(id));
  path.reverse();
  assert.deepEqual(path[0], start, 'The fixture must have a valid excavatable route around rock and water');
  assert.ok(path.some(({ col, row }) => layout[row][col] === '2'), 'The victory route must include advanced terrain');
  return path;
}

export async function followRoute(page, game, route) {
  const visitedBiomes = new Set();
  let start = 0;
  while (start < route.length - 1) {
    let end = start + 1;
    const stepCol = route[end].col - route[start].col;
    const stepRow = route[end].row - route[start].row;
    const biome = biomes[route[end].row][route[end].col];
    while (end < route.length - 1 && route[end + 1].col - route[end].col === stepCol
      && route[end + 1].row - route[end].row === stepRow
      && biomes[route[end + 1].row][route[end + 1].col] === biome) end += 1;
    await game.openLineTo(route[end], true);
    assert.equal(await page.locator('#expedition-biome').textContent(), BIOME_NAMES[biome]);
    visitedBiomes.add(biome);
    assert.notEqual((await readRound(page)).phase, 'lost', 'The defended expedition must survive to the next route turn');
    start = end;
  }
  assert.ok([...visitedBiomes].some((biome) => biome !== 'ordinary'), 'Victory must discover special terrain');
  return [...visitedBiomes];
}

export async function runVictorySmoke(page, url) {
  const game = await openWideGame(page, url, layout);
  const fast = new URL(url).searchParams.get('speed') === 'test';
  const timing = fast ? PROTOTYPE_ONLY.fast : PROTOTYPE_ONLY.normal;
  const initial = await readRound(page);
  assert.equal(initial.phase, 'preparing');
  assert.equal(initial.wave, 0);
  assert.ok(await page.locator('#expedition-spawn').isHidden());
  const towers = [{ col: 25, row: 94 }, { col: 26, row: 94 }];
  const walls = [16, 17, 18, 19].map((col) => ({ col, row: 88 }));
  const producer = { col: 21, row: 90 };

  async function place(kind, cell) {
    const card = page.locator(`#card-${kind}`);
    if (await card.getAttribute('aria-pressed') !== 'true') await card.click();
    await game.inspect(cell, '空地');
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
    await page.clock.runFor(32);
  }

  async function balance() { return Number(await page.locator('#economy-balance').textContent()); }

  async function manufacture() {
    const cash = await balance();
    const before = await readCardInventory(page);
    await page.locator('#make-card').click();
    assert.equal(await balance(), cash - ECONOMY_PROTOTYPE.drawCost);
    const after = await readCardInventory(page);
    const drawn = Object.keys(before).find((kind) => after[kind] === before[kind] + 1);
    await assertVisibleCardDraw(page, drawn, before[drawn]);
    assert.deepEqual(after, { ...before, [drawn]: before[drawn] + 1 });
    return drawn;
  }

  let firstDraw;
  if (!fast) {
    const fogTarget = { col: 19, row: 82 };
    await game.aimAt(fogTarget);
    assert.equal(await page.locator('#hover-cell').getAttribute('data-visibility'), 'unknown');
    const initialSoil = { col: 19, row: 93 };
    await game.inspect(initialSoil, '可挖地形', 'HP 5/5', 'Lv.1');
    await page.mouse.down({ button: 'left' });
    try {
      await page.clock.runFor(700);
    } finally {
      await page.mouse.up({ button: 'left' });
    }
    await game.inspect(initialSoil, '空地');
    firstDraw = await manufacture();

    const before = await readCardInventory(page);
    await place('tower', towers[1]);
    assert.match(await page.locator('#expedition-feedback').textContent(), /过远|一格|相邻/);
    assert.deepEqual(await readCardInventory(page), before, 'A distant placement must keep the tower card');
  }

  const beforeTowers = await readCardInventory(page);
  await game.walkVia({ col: 21, row: 92 }, { col: 21, row: 94 }, { col: 25, row: 94 });
  await place('tower', towers[1]);
  await game.walkTo({ col: 24, row: 94 }, true);
  await place('tower', towers[0]);
  assert.equal((await readCardInventory(page)).tower, beforeTowers.tower - towers.length);
  await game.walkVia({ col: 21, row: 94 }, { col: 21, row: 92 }, GENERATED_SPAWN);

  // Keep normal preparation inside the actual simulated frame loop.
  if (!fast) {
    let remaining = timing.preparingMs - 2_000;
    while (remaining > 0) {
      const step = Math.min(12_000, remaining);
      await page.clock.runFor(step);
      remaining -= step;
    }
  }
  const defending = await awaitRound(page, (state) => state.phase === 'recovering' && state.wave === 1,
    'The built towers must defeat the first scheduled wave');
  const firstWaveSize = Math.min(PROTOTYPE_ONLY.maxWaveCount,
    PROTOTYPE_ONLY.baseWaveCount + Math.floor(timing.preparingMs / timing.pressureStepMs));
  assert.equal(defending.requested, firstWaveSize);
  assert.equal(defending.towerKills, firstWaveSize);
  assert.equal(defending.hp, PROTOTYPE_ONLY.playerHp);
  const spentAtStart = firstDraw ? ECONOMY_PROTOTYPE.drawCost : 0;
  const startingCash = ECONOMY_PROTOTYPE.initialBalance - spentAtStart;
  assert.equal(await balance(), startingCash + defending.towerKills * ECONOMY_PROTOTYPE.towerKillReward);

  const beforeWalls = await readCardInventory(page);
  await game.walkVia({ col: 19, row: 89 }, { col: 17, row: 89 });
  if (!fast) {
    const explored = { col: 19, row: 82 };
    await game.inspect(explored, '可挖地形');
  }
  for (const wall of walls.slice(0, 3)) await place('wall', wall);
  await game.walkTo({ col: 18, row: 89 }, true);
  await place('wall', walls.at(-1));
  assert.equal((await readCardInventory(page)).wall, beforeWalls.wall - walls.length);
  assert.match(await page.locator('#expedition-feedback').textContent(), /已合成城墙 Lv\.2 \(16, 88\)/);

  await game.walkVia({ col: 19, row: 89 }, { col: 19, row: 91 }, { col: 20, row: 91 });
  await place('economy', producer);
  await game.walkVia({ col: 19, row: 91 }, GENERATED_SPAWN);
  await page.clock.runFor(ECONOMY_PROTOTYPE.productionIntervalMs + 100);
  const withIncome = await readRound(page);
  assert.equal(await balance(), startingCash + withIncome.towerKills * ECONOMY_PROTOTYPE.towerKillReward
    + ECONOMY_PROTOTYPE.productionAmount);
  await manufacture();
  const balanceBeforeResearch = await balance();
  await page.locator('#research-tool').click();
  assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2');
  assert.equal(await balance(), balanceBeforeResearch - TECHNOLOGY_PROTOTYPE.researchCost);

  let lingered = defending;
  if (fast) {
    lingered = await awaitRound(page,
      (state, previous) => previous && state.wave > previous.wave && state.pressure > 0
        && state.requested - previous.requested > PROTOTYPE_ONLY.baseWaveCount,
      'Staying at the southern stage must increase a later real wave size');
    assert.equal(lingered.stage, 1);
  }
  assert.deepEqual(await game.position(), GENERATED_SPAWN);

  const route = findDiggablePath([...towers, walls[0], producer, ECONOMY_PROTOTYPE.technologyCell]);
  const visitedBiomes = await followRoute(page, game, route);
  assert.deepEqual(await game.position(), GENERATED_GOAL);
  const win = await readRound(page);
  assert.equal(win.phase, 'won');
  assert.equal(win.stage, 3);
  assert.ok(win.hp > 0);
  assert.match(win.label, /获胜/);
  await assertTerminal(page, game, 'won');
  const routeCells = route.slice(1);
  const minedTiles = routeCells.filter(({ col, row }) => /[+2]/.test(layout[row][col])).length;
  const advancedCells = routeCells.filter(({ col, row }) => layout[row][col] === '2');
  const advancedBody = advancedCells.filter(({ row }) => row <= EXPEDITION_STRATA.bodySouthRow).length;
  const advancedTransition = advancedCells.filter(({ row }) => row >= EXPEDITION_STRATA.transitionNorthRow
    && row <= EXPEDITION_STRATA.transitionSouthRow).length;
  assert.ok(advancedTransition > 0 && advancedBody >= 3, 'The route must excavate both the transition and the advanced body');
  return {
    hp: win.hp, wave: win.wave, towerKills: win.towerKills, routeSteps: route.length - 1,
    minedTiles: minedTiles + Number(!fast), advancedTransition, advancedBody, visitedBiomes, firstDraw,
    preparingMs: timing.preparingMs, firstWaveSize, lingerWave: lingered.wave, lingerPressure: lingered.pressure,
  };
}

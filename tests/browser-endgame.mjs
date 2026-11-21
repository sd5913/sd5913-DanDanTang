import assert from 'node:assert/strict';
import { GENERATED_GOAL } from '../src/generated-map.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { advanceUntil, openChallenge, readRound } from './browser-challenge.mjs';
import { replayEndgame } from './endgame-replay.mjs';

const seed = 12;
const elapsed = async (page, run) => Math.round(await page.evaluate(() => performance.now()) - run.start);
const pathSearches = async (page) => Number(await page.locator('#defense-stats').getAttribute('data-searches'));

async function readEvacuation(page) {
  const data = await page.locator('#evacuation').evaluate((panel) => ({ ...panel.dataset }));
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, key === 'outcome' ? value : Number(value)]));
}

async function dig(page, run, target) {
  await run.game.inspect(target, '可挖地形');
  const label = await page.locator('#hover-cell').textContent();
  const hp = Number(label.match(/HP (\d+)\//)?.[1]);
  assert.ok(hp > 0, label);
  await page.mouse.down({ button: 'left' });
  try {
    await page.clock.runFor(16);
    for (let strikes = 0; strikes < hp + 2; strikes += 1) {
      if ((await page.locator('#hover-cell').textContent()).includes('空地')) break;
      await page.clock.runFor(MINING_CONFIG.attackIntervalMs);
    }
  } finally {
    await page.mouse.up({ button: 'left' });
  }
  await run.game.inspect(target, '空地');
}

async function runEndgame(page, url, strategy) {
  const plan = replayEndgame(seed, strategy);
  const run = await openChallenge(page, url, seed, 'w25', 'combined', { playtestUrl: '/' });
  const start = page.locator('#evacuation-start');
  assert.ok(await start.isHidden());
  await page.keyboard.press('KeyE');
  await page.clock.runFor(16);
  assert.equal((await readEvacuation(page)).planned, 0, 'E cannot activate from the southern start');

  let arrivalMs;
  let activationMs;
  let activeWave;
  let searchesAtActivation;
  const construction = { wall: 0, tower: 0, economy: 0 };
  const paidCards = [];
  for (const [index, action] of plan.actions.entries()) {
    try {
      const { target } = action;
      switch (action.type) {
        case 'walk':
          await run.game.walkTo(target, true);
          if (arrivalMs === undefined && target.col === GENERATED_GOAL.col && target.row === GENERATED_GOAL.row) {
            arrivalMs = await elapsed(page, run);
            assert.notEqual((await readRound(page)).phase, 'won', 'Northern arrival must never grant victory');
            assert.equal((await readEvacuation(page)).planned, 0);
            assert.ok(await start.isVisible());
          }
          break;
        case 'dig':
          await dig(page, run, target);
          break;
        case 'technology':
          await run.buildTechnology(target);
          break;
        case 'research':
          await run.researchTool();
          break;
        case 'draw':
          paidCards.push(await run.draw(action.card));
          break;
        case 'place':
          await run.place(action.kind, target);
          construction[action.kind] += 1;
          break;
        case 'evacuate':
          assert.ok(arrivalMs > 0);
          activeWave = (await readRound(page)).wave;
          searchesAtActivation = await pathSearches(page);
          if (strategy === 'B1') await page.keyboard.press('KeyE');
          else await start.click();
          await page.clock.runFor(16);
          activationMs = await elapsed(page, run);
          assert.equal((await readRound(page)).phase, 'evacuating');
          assert.match(await page.locator('#goal-status').textContent(), /守住装置/);
          assert.equal((await readEvacuation(page)).hp, 6);
          await page.keyboard.press('KeyE');
          await page.clock.runFor(16);
          assert.equal((await readEvacuation(page)).planned, 32, 'Repeated interaction cannot duplicate a batch');
          break;
        default:
          assert.fail('Unexpected browser route action ' + action.type);
      }
    } catch (error) {
      const current = { index, action, cell: await run.game.position(), time: await elapsed(page, run),
        phase: (await readRound(page)).phase, cash: await run.cash() };
      throw new Error('Paid evacuation replay stopped: ' + JSON.stringify(current), { cause: error });
    }
  }

  const terminal = await advanceUntil(page, ({ phase }) => phase === 'won' || phase === 'lost',
    'Evacuation must reach its actual combat outcome', 75_000, 1_024);
  const result = await readEvacuation(page);
  const terminalState = { seed, strategy, arrivalMs, activationMs, endedMs: await elapsed(page, run), construction, paidCards,
    playerHp: terminal.hp, newPathFields: await pathSearches(page) - searchesAtActivation, ...result };
  assert.equal(terminal.wave, activeWave, 'Evacuation must suppress new ordinary waves');
  assert.ok(terminal.hp > 0, JSON.stringify(terminalState));
  assert.equal(result.pending, 0);
  if (strategy === 'B1') {
    assert.equal(terminal.phase, 'lost', JSON.stringify(terminalState));
    assert.equal(result.outcome, 'evacuation');
    assert.equal(result.hp, 0);
    assert.ok(result.contacts >= 3);
    assert.equal(result.damage, 6);
    assert.match(await page.locator('#goal-status').textContent(), /战败.*装置已摧毁/);
  } else {
    assert.equal(terminal.phase, 'won', JSON.stringify(terminalState));
    assert.equal(result.outcome, 'won');
    assert.deepEqual([result.firstSpawned, result.secondSpawned, result.spawned, result.resolved, result.active], [12, 20, 32, 32, 0]);
    assert.ok(result.hp > 0 && construction.wall > 0 && construction.tower > 0);
    assert.match(await page.locator('#goal-status').textContent(), /撤离成功.*已清场/);
  }
  return terminalState;
}

export const runPlaytestEvacuationLossSmoke = (page, url) => runEndgame(page, url, 'B1');
export const runPlaytestEvacuationVictorySmoke = (page, url) => runEndgame(page, url, 'B3');

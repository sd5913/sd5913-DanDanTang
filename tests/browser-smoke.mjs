import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { TerrainMap } from '../src/terrain.ts';
import { runBuildDebugIsolationSmoke, runBuildRangeSmoke } from './browser-build-range.mjs';
import {
  runBoundarySeedOpeningSmoke, runBuildingBalanceSelectionSmoke, runBuildingEconomyUpgradeSmoke,
  runBuildingTowerUpgradeSmoke, runBuildingWallUpgradeSmoke,
} from './browser-building-balance.mjs';
import { runCardFeedbackSmoke, runDestroyedTechFeedbackSmoke } from './browser-card-feedback.mjs';
import {
  runChallengeLossSmoke, runChallengePitySmoke, runChallengeTechnologyRelocationSmoke, runChallengeTowerSmoke,
  runChallengeVictorySmoke, runChallengeWallSmoke,
} from './browser-challenge.mjs';
import { runDenseMapSmoke } from './browser-dense-map.mjs';
import { runDefenseSmoke } from './browser-defense.mjs';
import { runEnemyContactSmoke } from './browser-enemy-contact.mjs';
import { runBiomeFogSmoke, runExpeditionSmoke, runResearchSmoke, runStrataSeedSmoke } from './browser-expedition.mjs';
import { runFix02MapSmoke, runFix02DefenseSmoke, runFix02RoundSmoke, runSynthesisSmoke } from './browser-fix02.mjs';
import { runLossSmoke, runVictorySmoke } from './browser-goal.mjs';
import { runLongMapSmoke } from './browser-long-map.mjs';
import { runMidgameProfilesSmoke, runCombinedVictorySmoke, runCombinedLossSmoke } from './browser-midgame.mjs';
import { runMidgameCombatSmoke } from './browser-midgame-combat.mjs';
import { runMidgameDecaySmoke, runMidgameTierLateSmoke, runMidgameTierSmoke } from './browser-midgame-economy.mjs';
import { runTerminalMiningPreviewSmoke, runWideMiningPreviewSmoke } from './browser-mining-preview.mjs';
import {
  runFirstWaveFacilitySmoke, runPressureAlertsSmoke, runPressureEconomySmoke, runPressureFirstWaveSmoke, runPressureForecastSmoke,
  runPressureOutcomeSmoke, runPressurePlayerContactSmoke, runPressureProfileSelectionSmoke, runPressureQueueRolloverSmoke,
} from './browser-pressure.mjs';
import { runEnemyRetargetSmoke } from './browser-retarget.mjs';
import { openBrowserTestServer } from './browser-regression-server.mjs';
import { runEvolvedTowerCombatSmoke } from './browser-tower-evolution.mjs';

const development = process.argv.includes('--dev');
const playtest = process.argv.includes('--playtest');
const map = new TerrainMap();
const { url, close } = await openBrowserTestServer({ development, playtest });

try {
  const browser = await chromium.launch({ channel: 'msedge' });

  try {
    const mode = development ? 'dev regression' : 'compiled regression';
    if (playtest) {
      const { runPlaytestSmoke, runPlaytestCombinedEconomySmoke } = await import('./browser-playtest.mjs');
      for (const [name, run] of [
        ['unified playtest', runPlaytestSmoke], ['unified economy', runPlaytestCombinedEconomySmoke],
      ]) {
        const result = await withSmokePage(browser, { width: 1280, height: 900 }, (page) => run(page, url));
        console.log(`Edge smoke (production, ${name}): passed; ${JSON.stringify(result)}; no browser errors.`);
      }
    } else if (process.argv.includes('--directional-mining')) {
      await withSmokePage(browser, { width: 1440, height: 1060 },
        (page) => runSingleMapSmoke(page, url + '/?map=single', { directionalOnly: true }));
      console.log(`Edge smoke (${mode}, directional mining): passed; queued out-of-range aiming, amber Canvas outlines, locked strikes, stationary-pointer turns, key order and cancellation, cooldown, release, and blur verified; no browser errors.`);
      await runWideMiningPreviewBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--challenge')) {
      await runChallengeBrowserSmoke(browser, url, mode, true);
    } else if (process.argv.includes('--tower-evolution')) {
      await runTowerEvolutionBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--building-balance')) {
      await runBuildingBalanceBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--midgame')) {
      await runMidgameBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--pressure-outcomes')) {
      await runPressureOutcomesBrowserSmoke(browser, url, mode, true);
    } else if (process.argv.includes('--pressure-alerts')) {
      await runPressureAlertsBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--pressure-economy')) {
      await runPressureEconomyBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--pressure-combat')) {
      await runPressureCombatBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--contacts')) {
      await runContactBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--pressure-profiles')) {
      await runPressureProfilesBrowserSmoke(browser, url, mode, true);
    } else if (process.argv.includes('--fix01-a')) {
      await runCardFeedbackBrowserSmoke(browser, url, mode);
    } else if (process.argv.includes('--fix01-b')) {
      await runBuildRangeBrowserSmoke(browser, url, mode);
      await withSmokePage(browser, { width: 1280, height: 900 },
        (page) => runSynthesisSmoke(page, `${url}/?mode=defense&seed=12`));
      console.log(`Edge smoke (${mode}, FIX01-B legacy defense): passed; original remote debug building and synthesis retained; no browser errors.`);
    } else if (process.argv.includes('--fix01-c')) {
      await runStrataBrowserSmoke(browser, url, mode);
    } else {
      await runStandardBrowserSmoke(browser, url, mode);
      await runContactBrowserSmoke(browser, url, mode);
      await runPressureProfilesBrowserSmoke(browser, url, mode, process.argv.includes('--normal-round'));
      await runPressureCombatBrowserSmoke(browser, url, mode);
      await runPressureEconomyBrowserSmoke(browser, url, mode);
      await runPressureAlertsBrowserSmoke(browser, url, mode);
      await runPressureOutcomesBrowserSmoke(browser, url, mode, process.argv.includes('--normal-round'));
      await runCardFeedbackBrowserSmoke(browser, url, mode);
      await runBuildRangeBrowserSmoke(browser, url, mode);
      await runChallengeBrowserSmoke(browser, url, mode, false);
      await runTowerEvolutionBrowserSmoke(browser, url, mode);
    }
  } finally {
    await browser.close();
  }
} finally {
  await close();
}

async function runTowerEvolutionBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  for (const kind of ['piercing', 'burst']) {
    const result = await withSmokePage(browser, viewport, (page) => runEvolvedTowerCombatSmoke(page, url, kind));
    console.log(`Edge smoke (${mode}, ${kind} evolution): passed; ${JSON.stringify(result)}; no browser errors.`);
  }
}

async function runContactBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  const contacts = await withSmokePage(browser, viewport, (page) => runEnemyContactSmoke(page, url));
  console.log(`Edge smoke (${mode}, enemy body contact): passed; ${JSON.stringify(contacts)}; no browser errors.`);
  const wave = await withSmokePage(browser, viewport, (page) => runFirstWaveFacilitySmoke(page, url));
  console.log(`Edge smoke (${mode}, first-wave facility contact): passed; ${JSON.stringify(wave)}; no browser errors.`);
  const retarget = await withSmokePage(browser, viewport, (page) => runEnemyRetargetSmoke(page, url));
  console.log(`Edge smoke (${mode}, enemy retarget): passed; ${JSON.stringify(retarget)}; no browser errors.`);
}

async function runMidgameBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  const scenarios = [
    ["profiles", runMidgameProfilesSmoke],
    ["density", (page, baseUrl) => runMidgameCombatSmoke(page, baseUrl, "density")],
    ["armor", (page, baseUrl) => runMidgameCombatSmoke(page, baseUrl, "armor")],
    ["tier prices", runMidgameTierSmoke],
    ["late tier price", runMidgameTierLateSmoke],
    ["kill decay", runMidgameDecaySmoke],
    ["Combined loss", runCombinedLossSmoke],
    ["Combined victory", runCombinedVictorySmoke],
  ];
  for (const [name, run] of scenarios) {
    const result = await withSmokePage(browser, viewport, (page) => run(page, url));
    console.log(`Edge smoke (${mode}, midgame ${name}): passed; ${JSON.stringify(result)}; no browser errors.`);
  }
}

async function runChallengeBrowserSmoke(browser, url, mode, full) {
  const viewport = { width: 1280, height: 900 };
  const cases = full
    ? [
      runChallengeWallSmoke, runChallengeTowerSmoke, runChallengeLossSmoke, runChallengePitySmoke,
      runChallengeTechnologyRelocationSmoke, runChallengeVictorySmoke,
    ]
    : [runChallengeWallSmoke];
  for (const run of cases) {
    const result = await withSmokePage(browser, viewport, (page) => run(page, url));
    console.log(`Edge smoke (${mode}, challenge): passed; ${JSON.stringify(result)}; no browser errors.`);
  }
}

async function runBuildingBalanceBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  const selection = await withSmokePage(browser, viewport, (page) => runBuildingBalanceSelectionSmoke(page, url));
  console.log(`Edge smoke (${mode}, building balance selection): passed; ${JSON.stringify(selection)}; no browser errors.`);
  for (const build of [undefined, 'control', 'w35', 'w15']) {
    const wall = await withSmokePage(browser, viewport, (page) => runChallengeWallSmoke(page, url, build));
    console.log(`Edge smoke (${mode}, paid wall balance): passed; ${JSON.stringify(wall)}; no browser errors.`);
  }
  for (const run of [runBuildingWallUpgradeSmoke, runBuildingTowerUpgradeSmoke, runBuildingEconomyUpgradeSmoke]) {
    const upgrade = await withSmokePage(browser, viewport, (page) => run(page, url));
    console.log(`Edge smoke (${mode}, paid building upgrade): passed; ${JSON.stringify(upgrade)}; no browser errors.`);
  }
  const outcome = await withSmokePage(browser, viewport, (page) => runChallengeVictorySmoke(page, url, 'w25'));
  console.log(`Edge smoke (${mode}, W25 challenge victory): passed; ${JSON.stringify(outcome)}; no browser errors.`);
  for (const seed of [0, 0xffff_ffff]) {
    const opening = await withSmokePage(browser, viewport, (page) => runBoundarySeedOpeningSmoke(page, url, seed));
    console.log(`Edge smoke (${mode}, boundary seed opening): passed; ${JSON.stringify(opening)}; no browser errors.`);
  }
}

async function runPressureProfilesBrowserSmoke(browser, url, mode, includeNormalTiming) {
  const viewport = { width: 1280, height: 900 };
  await withSmokePage(browser, viewport, (page) => runPressureProfileSelectionSmoke(page, url));
  console.log(`Edge smoke (${mode}, pressure profile selection): passed; Baseline/A/B selection, same-seed world, and reload verified; no browser errors.`);
  const speeds = includeNormalTiming ? ['test', 'normal'] : ['test'];
  for (const speed of speeds) {
    for (const profile of ['baseline', 'a', 'b']) {
      const wave = await withSmokePage(browser, viewport,
        (page) => runPressureFirstWaveSmoke(page, url, profile, speed));
      console.log(`Edge smoke (${mode}, pressure profile wave): passed; ${JSON.stringify(wave)}; queue, reset and no browser errors verified.`);
    }
  }
}

async function runPressureCombatBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  const rollover = await withSmokePage(browser, viewport, (page) => runPressureQueueRolloverSmoke(page, url));
  console.log(`Edge smoke (${mode}, pressure queue rollover): passed; real tech damage, stalled entry retained across waves, and reset verified; no browser errors.`);
  console.log(JSON.stringify(rollover));
  const contact = await withSmokePage(browser, viewport, (page) => runPressurePlayerContactSmoke(page, url));
  console.log(`Edge smoke (${mode}, pressure player contact): passed; damage timestamps and terminal cancellation reconciled; no browser errors.`);
  console.log(JSON.stringify(contact));
}

async function runPressureEconomyBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  const a = await withSmokePage(browser, viewport, (page) => runPressureEconomySmoke(page, url, 'a'));
  const b = await withSmokePage(browser, viewport, (page) => runPressureEconomySmoke(page, url, 'b'));
  assert.equal(a.planned, b.planned);
  assert.ok(b.towerKills < a.towerKills && b.wallImpacts > a.wallImpacts);
  assert.ok(b.averageTowerHitsOnKill > a.averageTowerHitsOnKill);
  console.log(`Edge smoke (${mode}, pressure economy): passed; paired A/B tower hits, wall HP, kill rewards, production, spending and reset verified; no browser errors.`);
  console.log(JSON.stringify([a, b]));
}

async function runPressureAlertsBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  await withSmokePage(browser, viewport, (page) => runPressureForecastSmoke(page, url));
  console.log(`Edge smoke (${mode}, pressure forecast): passed; normal countdown, wave size and enemy strength verified; no browser errors.`);
  const alerts = await withSmokePage(browser, viewport, (page) => runPressureAlertsSmoke(page, url));
  console.log(`Edge smoke (${mode}, battlefield alerts): passed; attack, real offscreen warning, deduplication, distinct breach, fog and reset verified; no browser errors.`);
  console.log(JSON.stringify(alerts));
}

async function runPressureOutcomesBrowserSmoke(browser, url, mode, includeNormalTiming) {
  const viewport = { width: 1280, height: 900 };
  const speeds = includeNormalTiming ? ['wait-test', 'normal'] : ['wait-test'];
  for (const speed of speeds) {
    for (const profile of ['baseline', 'a', 'b']) {
      for (const outcome of ['lost', 'won']) {
        const result = await withSmokePage(browser, viewport,
          (page) => runPressureOutcomeSmoke(page, url, profile, speed, outcome));
        console.log(`Edge smoke (${mode}, pressure outcome): passed; ${JSON.stringify(result)}; no browser errors.`);
      }
    }
  }
}

async function runCardFeedbackBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  await withSmokePage(browser, viewport, (page) => runCardFeedbackSmoke(page, `${url}/?mode=play&seed=1`));
  console.log(`Edge smoke (${mode}, FIX01-A acquisition): passed; all three cards, highlights, movement and placement, insufficient funds, and seeded reset verified; no browser errors.`);
  await withSmokePage(browser, viewport,
    (page) => runDestroyedTechFeedbackSmoke(page, `${url}/?mode=play&seed=12&speed=test`));
  console.log(`Edge smoke (${mode}, FIX01-A destroyed technology): passed; scheduled enemies destroyed the facility and visible manufacture denial preserved economy and cards; no browser errors.`);
}

async function runBuildRangeBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  await withSmokePage(browser, viewport, (page) => runBuildRangeSmoke(page, `${url}/?mode=play&seed=12`));
  console.log(`Edge smoke (${mode}, FIX01-B placement): passed; range and occupancy reasons, cardinal and diagonal use, preview, resize, edge, synthesis, and cross-seam placement verified; no browser errors.`);
  await withSmokePage(browser, viewport,
    (page) => runBuildDebugIsolationSmoke(page, `${url}/?mode=play&seed=12&debug=1`));
  console.log(`Edge smoke (${mode}, FIX01-B debug isolation): passed; play mode debug controls cannot bypass range; no browser errors.`);
}

async function runStrataBrowserSmoke(browser, url, mode) {
  const viewport = { width: 1280, height: 900 };
  const scene = `${url}/?mode=play&seed=12`;
  const reached = await withSmokePage(browser, viewport, (page) => runResearchSmoke(page, scene));
  console.log(`Edge smoke (${mode}, P0-E / FIX01-C strata): passed; research, mixed visible transition, tool gate without cooldown, body excavation, persistence, and R verified; no browser errors.`);
  console.log(JSON.stringify(reached));
  await withSmokePage(browser, viewport, (page) => runStrataSeedSmoke(page, scene));
  console.log(`Edge smoke (${mode}, FIX01-C strata seeds): passed; version four, same-seed reload, and new-seed round verified; no browser errors.`);
}

async function runWideMiningPreviewBrowserSmoke(browser, url, mode) {
  await withSmokePage(browser, { width: 1280, height: 900 },
    (page) => runWideMiningPreviewSmoke(page, `${url}/?mode=play&seed=12`));
  console.log(`Edge smoke (${mode}, wide mining preview): passed; Canvas outline aligned after camera movement, resize and a chunk crossing, with fog and range verified; no browser errors.`);
  await withSmokePage(browser, { width: 1280, height: 900 },
    (page) => runTerminalMiningPreviewSmoke(page, `${url}/?mode=play&seed=12&speed=test`));
  console.log(`Edge smoke (${mode}, terminal mining preview): passed; real defeat cleared the held outline and stopped damage; no browser errors.`);
}

async function runStandardBrowserSmoke(browser, url, mode) {
    const dugTiles = await withSmokePage(browser, { width: 1440, height: 1060 },
      (page) => runSingleMapSmoke(page, `${url}/?map=single`));
    console.log(`Edge smoke (${mode}, single map): passed; real rapid clicks and cross-target cooldown, hold/release, queued aiming, target lock and pointer/directional chaining after clearing, interruption, and ready-tool reset verified; ${dugTiles} tiles mined on the route; no browser errors.`);

    await runWideMiningPreviewBrowserSmoke(browser, url, mode);

    await withSmokePage(browser, { width: 1040, height: 840 },
      (page) => runLongMapSmoke(page, `${url}/?map=regression`));
    console.log(`Edge smoke (${mode}, long map regression): passed; scaled camera input, two seams, offscreen HP and cleared terrain, viewport chunk counts, north goal, and reset across all three chunks verified; no browser errors.`);

    const denseDigs = await withSmokePage(browser, { width: 1040, height: 840 },
      (page) => runDenseMapSmoke(page, `${url}/?map=fix01`));
    console.log(`Edge smoke (${mode}, FIX01 dense map): passed; partial damage remained solid, ${denseDigs} dirt tiles cleared along the route to the first seam, actual terrain drawing and reset verified; no browser errors.`);

    await withSmokePage(browser, { width: 1440, height: 1060 },
      (page) => runDefenseSmoke(page, `${url}/?mode=defense&map=fix01`));
    console.log(`Edge smoke (${mode}, FIX01 defense): passed; queued 1/10/50/100 spawn counts, separated enemy drawings, blocked queue retry/reset, no-path recovery, alternate route, wall impacts and breach survivor, tower kill, and offscreen seam crossing verified; no browser errors.`);

    await withSmokePage(browser, { width: 1280, height: 840 },
      (page) => runFix02MapSmoke(page, `${url}/?seed=12`));
    console.log(`Edge smoke (${mode}, FIX02 map): passed; 18-column responsive camera, zoomed input and target lock, four camera bounds, two seams, north goal, and terrain persistence verified; no browser errors.`);

    await withSmokePage(browser, { width: 1280, height: 900 },
      (page) => runFix02DefenseSmoke(page, `${url}/?mode=defense&seed=12`));
    console.log(`Edge smoke (${mode}, FIX02 defense): passed; enemy and tower graphics aligned under horizontal scrolling and resize, tower shot and kill verified; no browser errors.`);

    await withSmokePage(browser, { width: 1280, height: 900 }, (page) => runFix02RoundSmoke(page, url));
    console.log(`Edge smoke (${mode}, FIX02 rounds): passed; automatic seed URL, reproducible reload, same-seed reset, fresh round, and invalid seed normalization verified; no browser errors.`);

    await withSmokePage(browser, { width: 1280, height: 900 },
      (page) => runSynthesisSmoke(page, `${url}/?mode=defense&seed=12`));
    console.log(`Edge smoke (${mode}, P0-C synthesis): passed; six-building bridge, oldest survivor, three released cells, two unchanged buildings, rendering, movement, and reset verified; no browser errors.`);

    await withSmokePage(browser, { width: 1280, height: 900 },
      (page) => runExpeditionSmoke(page, `${url}/?mode=play&seed=12&debug=1`));
    console.log(`Edge smoke (${mode}, P0-D expedition): passed; card placement and synthesis, separate controls, timed production, seeded manufacture, tower reward, and round reset verified; no browser errors.`);

    await runStrataBrowserSmoke(browser, url, mode);

    await withSmokePage(browser, { width: 1280, height: 900 },
      (page) => runBiomeFogSmoke(page, `${url}/?mode=play&seed=12`));
    console.log(`Edge smoke (${mode}, P0-F biomes and fog): passed; three visibility states, same-seed reset, plain excavation, lake shore and water rejection verified; no browser errors.`);

    await withSmokePage(browser, { width: 1280, height: 900 },
      (page) => runLossSmoke(page, `${url}/?mode=play&seed=12&speed=test`));
    console.log(`Edge smoke (${mode}, P0-G defeat): passed; real waves, contact HP loss, terminal stop, and reset verified; no browser errors.`);

    const fastVictory = await withSmokePage(browser, { width: 1280, height: 900 },
      (page) => runVictorySmoke(page, `${url}/?mode=play&seed=12&speed=test`));
    console.log(`Edge smoke (${mode}, P0-G victory): passed; defenses, wave pressure, economy, research, actual mining route, north goal, and terminal stop verified; no browser errors.`);
    console.log(JSON.stringify(fastVictory));

    if (process.argv.includes('--normal-round')) {
      const normalVictory = await withSmokePage(browser, { width: 1280, height: 900 },
        (page) => runVictorySmoke(page, `${url}/?mode=play&seed=12`));
      console.log(`Edge smoke (${mode}, P0-G normal timing): passed; normal preparation and wave timing, north goal, and terminal stop verified; no browser errors.`);
      console.log(JSON.stringify(normalVictory));
    }
}

async function withSmokePage(browser, viewport, run) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    const result = await run(page);
    assert.deepEqual(errors, [], 'Browser console and page must have no errors');
    return result;
  } finally {
    await page.close();
  }
}

async function runSingleMapSmoke(page, url, { directionalOnly = false } = {}) {
  const board = page.locator('#board canvas');
  const { attackIntervalMs, dirtMaxHp } = MINING_CONFIG;
  const { col, row } = map.spawn;
  const firstDig = { col, row: row - 1 };
  const east = { col: col + 1, row };
  const south = { col, row: row + 1 };
  // Both dirt targets are eligible from this empty cell.
  const lockOrigin = { col: col + 2, row: row - 1 };
  const lockedTarget = { col: lockOrigin.col - 1, row: lockOrigin.row };
  const otherTarget = { col: lockOrigin.col, row: lockOrigin.row - 1 };

  function coordinates(cell) {
    return `(${cell.col}, ${cell.row})`;
  }

  async function waitForText(selector, ...expected) {
    await page.waitForFunction(
      ({ selector, expected }) => {
        const text = document.querySelector(selector)?.textContent;
        return expected.every((value) => text?.includes(value));
      },
      { selector, expected },
    );
  }

  async function cellCenter(cell) {
    await board.scrollIntoViewIfNeeded();
    const box = await board.boundingBox();
    assert.ok(box, 'Game canvas must be visible');
    return {
      x: box.x + ((cell.col + 0.5) / map.columns) * box.width,
      y: box.y + ((cell.row + 0.5) / map.rows) * box.height,
    };
  }

  async function aimAt(cell) {
    const { x, y } = await cellCenter(cell);
    await page.mouse.move(x, y);
  }

  async function inspectCell(cell, ...details) {
    await aimAt(cell);
    await waitForText('#hover-cell', coordinates(cell), ...details);
  }

  async function samplePixel(column, line) {
    return page.evaluate(async ({ column, line, columns, rows }) => {
      // The HUD updates before Phaser renders the next frame.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.querySelector('#board canvas');
      const x = Math.floor((column / columns) * canvas.width);
      const y = Math.floor((line / rows) * canvas.height);
      const context = canvas.getContext('2d');
      return Array.from(context.getImageData(x, y, 1, 1).data);
    }, { column, line, columns: map.columns, rows: map.rows });
  }

  async function assertMiningPreview(expected, ...alternatives) {
    const cells = expected ? [expected, ...alternatives] : alternatives;
    const outlined = await board.evaluate((canvas, { cells, columns, rows }) => {
      const context = canvas.getContext('2d');
      return cells.filter(({ col, row }) => {
        // The thick amber outline is one world pixel inside the top and left tile edges.
        return [[0.5, 0.05], [0.05, 0.5]].every(([x, y]) => {
          const pixel = context.getImageData(
            Math.floor(((col + x) / columns) * canvas.width),
            Math.floor(((row + y) / rows) * canvas.height), 1, 1,
          ).data;
          return [255, 207, 117].every((channel, index) => Math.abs(pixel[index] - channel) <= 3);
        });
      });
    }, { cells, columns: map.columns, rows: map.rows });
    assert.deepEqual(outlined, expected ? [expected] : [],
      expected ? `Expected amber outline only at ${coordinates(expected)}` : 'Expected no amber mining outline');
  }

  async function holdKey(key, until) {
    await page.keyboard.down(key);
    try {
      await until();
    } finally {
      await page.keyboard.up(key);
    }
  }

  async function movePlayer(key, cell) {
    await holdKey(key, () => waitForText('#player-cell', coordinates(cell)));
  }

  async function holdMouse(until) {
    await page.mouse.down({ button: 'left' });
    try {
      await until();
    } finally {
      await page.mouse.up({ button: 'left' });
    }
  }

  async function rejectDig(cell, terrain, reason) {
    await inspectCell(cell, terrain);
    await holdMouse(() => waitForText('#dig-result', reason, coordinates(cell)));
  }

  async function dig(cell) {
    await inspectCell(cell, '可挖地形');
    await holdMouse(async () => {
      await waitForText('#dig-result', '挖掘成功', coordinates(cell));
      await waitForText('#hover-cell', '空地', coordinates(cell));
    });
  }

  async function assertHoverHp(cell, hp, message) {
    const hover = await page.locator('#hover-cell').textContent();
    assert.ok(hover.includes(`${coordinates(cell)} | HP ${hp}/5`), `${message}. Hover showed: ${hover}`);
  }

  async function assertHoverHpStays(cell, hp, message) {
    // A negative assertion must leave at least one scheduled attack time behind it.
    await page.waitForTimeout(attackIntervalMs * 2);
    await assertHoverHp(cell, hp, message);
  }

  async function resetMap() {
    await holdKey('KeyR', () => waitForText('#dig-result', '等待挖掘'));
    await waitForText('#player-cell', coordinates(map.spawn));
  }

  async function moveToLockOrigin() {
    await movePlayer('KeyD', { col: lockOrigin.col + 1, row });
    await movePlayer('KeyA', { col: lockOrigin.col, row });
    await movePlayer('KeyW', lockOrigin);
  }

  async function advanceTo(locator, expected, detail = '') {
    const timeBudget = (dirtMaxHp + 1) * attackIntervalMs;
    for (let elapsed = 0; elapsed <= timeBudget; elapsed += 16) {
      const actual = await locator.textContent();
      if (actual.includes(expected) && actual.includes(detail)) return;
      await page.clock.runFor(16);
    }
    assert.fail('Expected ' + expected + ' ' + detail + ', got ' + await locator.textContent());
  }

  async function verifyDirectionalMining() {
    const turnTarget = { col: otherTarget.col - 1, row: otherTarget.row };
    const straightTarget = { col: otherTarget.col, row: otherTarget.row - 1 };
    const result = page.locator('#dig-result');
    const player = page.locator('#player-cell');

    await moveToLockOrigin();
    await inspectCell(lockedTarget, '可挖地形', 'HP 5/5');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
    try {
      // Settle against the west dirt so the player's footprint fits the north passage.
      await holdKey('KeyA', () => page.clock.runFor(300));
      await holdKey('KeyW', () => page.clock.runFor(attackIntervalMs * 2));
      assert.equal((await player.textContent()).trim(), coordinates(lockOrigin));
      assert.match(await result.textContent(), /等待挖掘/, 'W alone must not start mining');
      await assertHoverHp(lockedTarget, 5, 'The aim must be intact before pressing');
      await assertMiningPreview(null, lockedTarget, otherTarget);

      await holdMouse(async () => {
        await assertHoverHp(lockedTarget, 4, 'Pressing must hit the aimed tile first');
        await holdKey('KeyW', async () => {
          await page.clock.runFor(2 * attackIntervalMs + 32);
          await assertHoverHp(lockedTarget, 2, 'W must not switch away from the started tile');
          await assertMiningPreview(lockedTarget, otherTarget);
          await advanceTo(result, '挖掘成功', coordinates(lockedTarget));
          await page.clock.runFor(Math.floor(attackIntervalMs / 2));
          assert.ok((await result.textContent()).includes(coordinates(lockedTarget)),
            'The next tile must respect the cooldown after clearing');
          await assertMiningPreview(otherTarget, lockedTarget);

          await holdKey('KeyS', () => page.clock.runFor(2 * attackIntervalMs));
          assert.ok((await result.textContent()).includes(coordinates(lockedTarget)),
            'Opposing W and S must cancel before starting the next tile');
          await assertMiningPreview(null, otherTarget, lockedTarget);
          await advanceTo(result, '剩余 4 HP', coordinates(otherTarget));
          await holdKey('KeyS', async () => {
            await advanceTo(result, '剩余 3 HP', coordinates(otherTarget));
            await assertMiningPreview(otherTarget, lockedTarget);
          });
          await advanceTo(result, '挖掘成功', coordinates(otherTarget));
          await advanceTo(player, coordinates(otherTarget));

          // W remains down, but the newer A should select west from the entered cell.
          await holdKey('KeyA', async () => {
            await advanceTo(result, '剩余 4 HP', coordinates(turnTarget));
            await assertMiningPreview(turnTarget, straightTarget, lockedTarget);
          });
        });
        await waitForText('#hover-cell', '空地', coordinates(lockedTarget));
      });

      await holdKey('KeyA', () => page.clock.runFor(2 * attackIntervalMs));
      await assertMiningPreview(null, turnTarget, straightTarget, lockedTarget);
      await inspectCell(turnTarget, '可挖地形', 'HP 4/5');
      await inspectCell(straightTarget, '可挖地形', 'HP 5/5');
      await inspectCell(otherTarget, '空地');
    } finally {
      await page.clock.resume();
    }
    await resetMap();
  }

  async function verifyMiningPreviewKeyOrder() {
    const starter = { col: otherTarget.col - 1, row: otherTarget.row };
    const north = { col: otherTarget.col, row: otherTarget.row - 1 };
    const right = { col: otherTarget.col + 1, row: otherTarget.row };
    const result = page.locator('#dig-result');

    await moveToLockOrigin();
    await holdKey('KeyA', () => page.waitForTimeout(300));
    await dig(otherTarget);
    await movePlayer('KeyW', otherTarget);
    await inspectCell(starter, '可挖地形', 'HP 5/5');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
    try {
      await holdKey('KeyW', () => page.clock.runFor(200));
      await holdMouse(async () => {
        await advanceTo(result, '挖掘成功', coordinates(starter));
        await holdKey('KeyW', async () => {
          await page.clock.runFor(16);
          await assertMiningPreview(north, right, starter);
          await holdKey('KeyD', async () => {
            await page.clock.runFor(16);
            await assertMiningPreview(right, north, starter);
          });
          await page.clock.runFor(16);
          await assertMiningPreview(north, right, starter);
        });
        await holdKey('KeyD', async () => {
          await page.clock.runFor(16);
          await assertMiningPreview(right, north, starter);
          await holdKey('KeyA', async () => {
            await page.clock.runFor(16);
            await assertMiningPreview(null, north, right, starter);
          });
          await holdKey('KeyW', async () => {
            await page.clock.runFor(16);
            await assertMiningPreview(north, right, starter);
            assert.ok((await result.textContent()).includes(coordinates(starter)),
              'Preview switches during cooldown must not deal damage');
            await advanceTo(result, '剩余 4 HP', coordinates(north));
          });

          await page.clock.runFor(16);
          await assertMiningPreview(north, right, starter);
          await page.evaluate(() => window.dispatchEvent(new Event('blur')));
          await page.clock.runFor(32);
          await assertMiningPreview(null, north, right, starter);
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await page.clock.runFor(2 * attackIntervalMs);
          await assertMiningPreview(null, north, right, starter);
        });
      });
      await inspectCell(north, '可挖地形', 'HP 4/5');
      await inspectCell(right, '可挖地形', 'HP 5/5');
    } finally {
      await page.clock.resume();
    }
    await resetMap();
  }

  async function verifyQueuedMiningApproach() {
    const queued = { col: col + 1, row: row - 1 };
    const decoy = { col, row: row - 2 };
    const result = page.locator('#dig-result');
    const player = page.locator('#player-cell');

    for (const interruption of ['none', 'release', 'blur']) {
      await dig(firstDig);
      await inspectCell(queued, '可挖地形', 'HP 5/5');
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
      try {
        const approach = () => holdKey('KeyW', async () => {
          await advanceTo(player, coordinates(firstDig));
          if (interruption === 'none') {
            await advanceTo(result, '剩余 4 HP', coordinates(queued));
            await assertMiningPreview(queued, decoy);
            await assertHoverHp(decoy, 5, 'Neither the cursor nor W may steal the queued attack');
          }
        });

        await holdMouse(async () => {
          const waiting = await result.textContent();
          assert.ok(waiting.includes(coordinates(queued)), waiting);
          assert.match(waiting, /上下左右相邻/);
          assert.match(waiting, /按住左键.*(?:靠近|走近)/);
          await inspectCell(decoy, '可挖地形', 'HP 5/5');
          await page.clock.runFor(2 * attackIntervalMs);
          assert.equal(await result.textContent(), waiting, 'Hover changes must not replace the original request');
          await assertMiningPreview(null, queued, decoy);

          if (interruption === 'release') return;
          if (interruption === 'blur') {
            await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            await page.clock.runFor(32);
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          }
          await approach();
        });
        if (interruption === 'release') await approach();
        await page.clock.runFor(2 * attackIntervalMs);
        await assertMiningPreview(null, queued, decoy);
        await assertHoverHp(decoy, 5, 'The other adjacent tile must remain untouched');
        await inspectCell(queued, '可挖地形', interruption === 'none' ? 'HP 4/5' : 'HP 5/5');
      } finally {
        await page.clock.resume();
      }
      await resetMap();
    }
  }

  await page.clock.install();
  const response = await page.goto(url);
  assert.equal(response?.status(), 200, 'Game page must load');
  await board.waitFor();
  await waitForText('#player-cell', coordinates(map.spawn));
  assert.ok(await page.locator('#new-round').isHidden());
  if (directionalOnly) {
    await verifyDirectionalMining();
    await verifyMiningPreviewKeyOrder();
    await verifyQueuedMiningApproach();
    return;
  }

  const originalGridStatus = await page.locator('#grid-status').textContent();
  assert.match(originalGridStatus, /显示|隐藏/);
  const toggledGridStatus = originalGridStatus.includes('显示') ? '隐藏' : '显示';
  const gridColumn = col;
  const gridRow = row - 2.5;
  const originalGridPixel = await samplePixel(gridColumn, gridRow);
  assert.equal(originalGridPixel[3], 255, 'The map must be fully painted');
  if (process.env.P0A_SCREENSHOT) {
    await page.screenshot({ path: process.env.P0A_SCREENSHOT, fullPage: true });
  }
  await holdKey('KeyG', () => waitForText('#grid-status', toggledGridStatus));
  assert.notDeepEqual(await samplePixel(gridColumn, gridRow), originalGridPixel,
    'G must change the rendered grid line');
  await holdKey('KeyG', () => waitForText('#grid-status', originalGridStatus.trim()));
  assert.deepEqual(await samplePixel(gridColumn, gridRow), originalGridPixel,
    'G must restore the initial rendered grid line');

  await rejectDig({ col: col + 1, row: row - 1 }, '可挖地形', '上下左右相邻');
  await rejectDig({ col, row: row - 2 }, '可挖地形', '上下左右相邻');
  await rejectDig({ col: col - 1, row }, '不可破坏岩石', '岩石不可挖掘');
  await rejectDig(east, '空地', '已经是空地');
  const emptyReference = await samplePixel(col + 1.78, row + 0.35);

  await holdKey('KeyA', () => page.waitForTimeout(800));
  assert.ok((await page.locator('#player-cell').textContent()).includes(coordinates(map.spawn)),
    'Rock must block movement');
  await movePlayer('KeyD', east);
  await movePlayer('KeyS', { col: col + 1, row: row + 1 });
  await resetMap();

  await inspectCell(firstDig, '可挖地形', 'HP 5/5');
  const terrainColumn = firstDig.col + 0.78;
  const terrainRow = firstDig.row + 0.35;
  const originalTerrainPixel = await samplePixel(terrainColumn, terrainRow);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await waitForText('#hover-cell', 'HP 4/5');
  await waitForText('#dig-result', '命中', '-1 HP', coordinates(firstDig));
  assert.notDeepEqual(await samplePixel(terrainColumn, terrainRow), originalTerrainPixel,
    'The first hit must visibly repaint the solid tile');
  await holdKey('KeyW', () => assertHoverHpStays(firstDig, 4, 'Releasing after one hit must stop damage'));
  assert.ok((await page.locator('#player-cell').textContent()).includes(coordinates(map.spawn)),
    'Partially mined terrain must still block movement');

  await resetMap();
  await waitForText('#hover-cell', 'HP 5/5');
  await holdMouse(() => waitForText('#hover-cell', 'HP 3/5'));
  await movePlayer('KeyS', south);
  await movePlayer('KeyW', map.spawn);
  await page.setViewportSize({ width: 1040, height: 840 });
  await inspectCell(east, '空地');
  await inspectCell(firstDig, '可挖地形', 'HP 3/5');

  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  try {
    // Use the west wall to establish a known position before approaching the east edge.
    await holdKey('KeyA', () => page.clock.runFor(300));
    await holdKey('KeyD', () => page.clock.runFor(80));
    assert.equal((await page.locator('#player-cell').textContent()).trim(), coordinates(map.spawn));
    await holdMouse(async () => {
      await assertHoverHp(firstDig, 2, 'A ready hold must strike once on press');
      await holdKey('KeyD', () => page.clock.runFor(attackIntervalMs - 16));
      assert.equal((await page.locator('#player-cell').textContent()).trim(), coordinates(east));
      await page.clock.runFor(attackIntervalMs * 2);
      await assertHoverHp(firstDig, 2, 'Moving out of range must stop mining');
      // Settle against the west wall so the player's right edge fits through the cleared tile later.
      await holdKey('KeyA', () => page.clock.runFor(300));
      assert.equal((await page.locator('#player-cell').textContent()).trim(), coordinates(map.spawn));
      await page.clock.runFor(attackIntervalMs * 2);
      await assertHoverHp(firstDig, 2, 'Returning to range with the same press must not restart mining');
    });
  } finally {
    await page.clock.resume();
  }

  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 1/5');
    await page.mouse.move(2, 2);
    await waitForText('#hover-cell', '—');
    await inspectCell(firstDig, '可挖地形', 'HP 1/5');
    await assertHoverHpStays(firstDig, 1, 'Leaving the board must stop mining until a new press');
  });

  await dig(firstDig);
  const dugPixel = await samplePixel(terrainColumn, terrainRow);
  assert.notDeepEqual(dugPixel, originalTerrainPixel, 'Digging must repaint the terrain');
  assert.ok(dugPixel.every((channel, index) => Math.abs(channel - emptyReference[index]) <= 3),
    'The dug tile must render with the empty-terrain color');
  await movePlayer('KeyW', firstDig);
  await resetMap();
  await inspectCell(firstDig, '可挖地形', 'HP 5/5');
  assert.deepEqual(await samplePixel(terrainColumn, terrainRow), originalTerrainPixel,
    'Reset must restore the original terrain drawing');

  // Headless Edge keeps both tabs visible, so send the corresponding lifecycle DOM events.
  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 4/5');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await aimAt(firstDig);
    await assertHoverHpStays(firstDig, 4, 'Window blur must stop an in-progress press');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await assertHoverHpStays(firstDig, 4, 'Window focus must not resume the same press');
  });
  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 3/5');
    await page.evaluate(() => {
      Object.defineProperties(document, {
        hidden: { configurable: true, value: true },
        visibilityState: { configurable: true, value: 'hidden' },
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    try {
      await page.waitForTimeout(Math.max(750, attackIntervalMs * 3));
    } finally {
      await page.evaluate(() => {
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await inspectCell(firstDig, '可挖地形', 'HP 3/5');
    await assertHoverHpStays(firstDig, 3, 'Returning to the tab must not apply missed hits or resume the press');
  });

  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 2/5');
    await resetMap();
    await inspectCell(firstDig, '可挖地形', 'HP 5/5');
    await assertHoverHpStays(firstDig, 5, 'Reset must restore all HP and cancel the ongoing press');
  });

  await moveToLockOrigin();
  const firstTargetPoint = await cellCenter(lockedTarget);
  const secondTargetPoint = await cellCenter(otherTarget);
  // Use Edge's input events with explicit time advances around the tool cooldown.
  const rapidPressDelay = Math.floor(attackIntervalMs / 5);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  try {
    await page.mouse.dblclick(firstTargetPoint.x, firstTargetPoint.y);
    await assertHoverHp(lockedTarget, 4, 'A rapid double click must only deal one hit');

    await page.clock.runFor(rapidPressDelay);
    await page.mouse.click(secondTargetPoint.x, secondTargetPoint.y);
    await assertHoverHp(otherTarget, 5, 'Switching to another legal tile must respect cooldown');
    await page.clock.runFor(attackIntervalMs);
    await assertHoverHp(otherTarget, 5, 'Releasing during cooldown must not queue a later hit');

    await page.mouse.click(firstTargetPoint.x, firstTargetPoint.y);
    await assertHoverHp(lockedTarget, 3, 'A click after cooldown must hit immediately');
    await page.clock.runFor(rapidPressDelay);
    await page.mouse.move(secondTargetPoint.x, secondTargetPoint.y);
    await holdMouse(async () => {
      await assertHoverHp(otherTarget, 5, 'Holding a new target must wait for cooldown');
      await page.mouse.move(firstTargetPoint.x, firstTargetPoint.y);
      await page.clock.runFor(attackIntervalMs);
      await assertHoverHp(lockedTarget, 3, 'A waiting hold must not switch to the new pointer position');
      await page.mouse.move(secondTargetPoint.x, secondTargetPoint.y);
      await assertHoverHp(otherTarget, 4, 'The original target must receive one hit when cooldown expires');
    });

    await holdKey('KeyR', () => page.clock.runFor(32));
    const spawnTargetPoint = await cellCenter(firstDig);
    await page.mouse.click(spawnTargetPoint.x, spawnTargetPoint.y);
    await assertHoverHp(firstDig, 4, 'Reset must restore a ready tool and full terrain HP');
    await holdKey('KeyR', () => page.clock.runFor(32));
  } finally {
    await page.clock.resume();
  }

  const clearAt = (dirtMaxHp - 1) * attackIntervalMs;
  for (const hoverBeforeClearing of [true, false]) {
    await moveToLockOrigin();
    await inspectCell(lockedTarget, '可挖地形', 'HP 5/5');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
    try {
      await holdMouse(async () => {
        await assertHoverHp(lockedTarget, 4, 'The starting target must take the first strike');
        if (hoverBeforeClearing) await inspectCell(otherTarget, '可挖地形', 'HP 5/5');
        await page.clock.runFor(clearAt - 1);
        await inspectCell(lockedTarget, '可挖地形', 'HP 1/5');
        if (hoverBeforeClearing) await inspectCell(otherTarget, '可挖地形', 'HP 5/5');

        // Advance past the clearing frame, with time still left on the tool cooldown.
        await page.clock.runFor(33);
        const result = await page.locator('#dig-result').textContent();
        assert.ok(result.includes('挖掘成功') && result.includes(coordinates(lockedTarget)), result);
        if (!hoverBeforeClearing) {
          await inspectCell(lockedTarget, '空地');
          await page.clock.runFor(attackIntervalMs);
        }
        await inspectCell(otherTarget, '可挖地形', 'HP 5/5');
        await page.clock.runFor(hoverBeforeClearing ? attackIntervalMs : 32);
        await assertHoverHp(otherTarget, 4, 'The new target must take a hit without releasing the button');
      });
    } finally {
      await page.clock.resume();
    }
    await inspectCell(lockedTarget, '空地');
    await resetMap();
  }

  const dugCells = [];
  let nextRow = row;
  do {
    nextRow -= 1;
    const nextCell = { col, row: nextRow };
    const terrain = map.getCell(nextCell)?.terrain;
    if (terrain === 'dirt') {
      await dig(nextCell);
      dugCells.push(nextCell);
    } else {
      assert.equal(terrain, 'empty', `Expected a diggable route at ${coordinates(nextCell)}`);
    }
    await movePlayer('KeyW', nextCell);
  } while (!map.isGoal({ col, row: nextRow }));

  await waitForText('#goal-status', 'P0-A 测试完成');
  await resetMap();
  assert.doesNotMatch(await page.locator('#goal-status').textContent(), /P0-A 测试完成/);
  for (const cell of dugCells) await inspectCell(cell, '可挖地形', 'HP 5/5');

  await verifyDirectionalMining();
  await verifyMiningPreviewKeyOrder();
  await verifyQueuedMiningApproach();
  return dugCells.length;
}

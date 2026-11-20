import assert from 'node:assert/strict';
import { ECONOMY_PROTOTYPE, TECHNOLOGY_PROTOTYPE } from '../src/expedition-economy.ts';
import { GENERATED_GOAL, GENERATED_SPAWN } from '../src/generated-map.ts';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { TILE_SIZE } from '../src/player.ts';
import { openWideGame, playFixture, readCanvasFingerprint } from './browser-fix02.mjs';
import { findDiggablePath, followRoute } from './browser-goal.mjs';

const seed = 12;

const cases = {
  baseline: { normal: [120_000, 45, 5], test: [2_500, 5, 3] },
  a: { normal: [90_000, 60, 10], test: [2_500, 60, 10] },
  b: { normal: [90_000, 60, 10], test: [2_500, 60, 10] },
};

async function readWave(page) {
  return page.evaluate(() => {
    const text = (id) => document.getElementById(id).textContent;
    const stats = document.getElementById('defense-stats').dataset;
    return {
      phase: document.getElementById('round-state').dataset.phase,
      difficulty: document.getElementById('round-difficulty').value,
      wave: Number(text('round-wave')),
      seconds: Number(text('round-time').match(/^\d+/)?.[0]),
      hp: Number(text('player-hp')),
      requested: Number(stats.requested),
      spawned: Number(stats.spawned),
      pending: Number(stats.pending),
      active: Number(stats.active),
      removed: Number(stats.removed),
      unreachable: Number(stats.unreachable),
      combat: JSON.parse(stats.waveCombat ?? '[]'),
      economy: JSON.parse(stats.waveEconomy ?? '[]'),
      balance: Number(text('economy-balance')),
    };
  });
}

export async function runPressureProfileSelectionSmoke(page, baseUrl) {
  const initialUrl = baseUrl + '/?mode=play&seed=' + seed + '&from=pressure-smoke';
  const game = await openWideGame(page, initialUrl);
  const picker = page.locator('#round-difficulty');
  const initialCanvas = await readCanvasFingerprint(page);
  assert.ok(await picker.isVisible());
  assert.equal(await picker.inputValue(), 'baseline');
  for (const profile of Object.keys(cases)) assert.equal(await picker.locator('option[value="' + profile + '"]').count(), 1);

  const dirt = { col: GENERATED_SPAWN.col, row: GENERATED_SPAWN.row + 1 };
  const hp = MINING_CONFIG.dirtMaxHp;
  await game.inspect(dirt, '可挖地形', 'HP ' + hp + '/' + hp);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.clock.runFor(32);
  await game.inspect(dirt, '可挖地形', 'HP ' + (hp - 1) + '/' + hp);
  await page.mouse.move(2, 2);
  await page.clock.runFor(32);
  assert.notDeepEqual(await readCanvasFingerprint(page), initialCanvas, 'The original round terrain must have changed');

  async function assertFresh(profile) {
    await page.waitForFunction((expected) => document.querySelector('#round-difficulty').value === expected
      && document.querySelector('#round-state').dataset.phase === 'preparing'
      && Number(document.querySelector('#visible-chunks').dataset.worldWidth) > 0, profile);
    const parameters = new URL(page.url()).searchParams;
    assert.equal(parameters.get('mode'), 'play');
    assert.equal(parameters.get('seed'), String(seed));
    assert.equal(parameters.get('from'), 'pressure-smoke');
    assert.equal(parameters.get('difficulty') ?? 'baseline', profile);
    assert.equal((await readWave(page)).wave, 0);
    assert.deepEqual(await game.position(), GENERATED_SPAWN);
    assert.deepEqual(await readCanvasFingerprint(page), initialCanvas, 'The selected profile must reproduce the same seed');
  }

  async function select(profile) {
    await Promise.all([
      page.waitForURL((url) => (url.searchParams.get('difficulty') ?? 'baseline') === profile),
      picker.selectOption(profile),
    ]);
    await assertFresh(profile);
  }

  await page.clock.resume();
  await select('a');
  await select('b');
  const selectedUrl = page.url();
  assert.equal((await page.reload())?.status(), 200);
  assert.equal(page.url(), selectedUrl);
  await assertFresh('b');
  await select('baseline');
}

export async function runPressureFirstWaveSmoke(page, baseUrl, profile, speed) {
  const parameters = new URLSearchParams({ mode: 'play', seed: String(seed), difficulty: profile });
  if (speed === 'test') parameters.set('speed', speed);
  const game = await openWideGame(page, baseUrl + '/?' + parameters.toString());
  const [preparationMs, attackSeconds, firstCount] = cases[profile][speed];
  const currentUrl = page.url();
  assert.ok(await page.locator('#expedition-spawn').isHidden());

  async function reset() {
    await game.holdKey('KeyR', () => page.clock.runFor(32));
    assert.equal(page.url(), currentUrl);
    assert.deepEqual(await game.position(), GENERATED_SPAWN);
    const round = await readWave(page);
    assert.equal(round.difficulty, profile);
    assert.equal(round.phase, 'preparing');
    assert.equal(round.seconds, Math.ceil(preparationMs / 1_000));
    assert.equal(round.wave, 0);
    assert.equal(round.hp, 4);
    assert.deepEqual([round.requested, round.spawned, round.pending, round.active, round.removed], [0, 0, 0, 0, 0]);
  }

  await reset();
  let elapsedMs = 0;
  const beforeWaveMs = preparationMs - 800;
  while (elapsedMs < beforeWaveMs) {
    const step = Math.min(12_000, beforeWaveMs - elapsedMs);
    await page.clock.runFor(step);
    elapsedMs += step;
  }
  let wave = await readWave(page);
  assert.equal(wave.phase, 'preparing');
  assert.equal(wave.requested, 0);
  while (wave.phase === 'preparing' && elapsedMs < preparationMs + 800) {
    await page.clock.runFor(32);
    elapsedMs += 32;
    wave = await readWave(page);
  }
  assert.equal(wave.phase, 'attacking', JSON.stringify(wave));
  assert.ok(Math.abs(elapsedMs - preparationMs) <= 500, 'The first attack must start at the configured preparation time');
  assert.equal(wave.wave, 1);
  assert.equal(wave.seconds, attackSeconds);
  assert.equal(wave.requested, firstCount);
  assert.equal(wave.spawned + wave.pending, firstCount);
  assert.equal(wave.spawned - wave.removed, wave.active);

  await page.clock.runFor(400);
  const inProgress = await readWave(page);
  assert.ok(inProgress.spawned > wave.spawned);
  assert.equal(inProgress.requested, firstCount);
  assert.equal(inProgress.spawned + inProgress.pending, firstCount);
  assert.equal(inProgress.spawned - inProgress.removed, inProgress.active);
  await reset();

  return { profile, speed, preparationMs, firstAttackObservedMs: elapsedMs, attackSeconds, firstCount };
}

async function watchWave(page, condition, description, budgetMs = 60_000) {
  const stepMs = 128;
  let state = await readWave(page);
  for (let elapsed = 0; !condition(state) && elapsed < budgetMs; elapsed += stepMs) {
    await page.clock.runFor(stepMs);
    state = await readWave(page);
  }
  assert.ok(condition(state), description + '. Last state: ' + JSON.stringify(state));
  return state;
}

async function openCombatGame(page, baseUrl, profile, speed = 'test', layout) {
  const parameters = new URLSearchParams({ mode: 'play', seed: String(seed), difficulty: profile, debug: '1' });
  if (speed !== 'normal') parameters.set('speed', speed);
  const game = await openWideGame(page, baseUrl + '/?' + parameters.toString(), layout);
  assert.equal((await readWave(page)).difficulty, profile);
  return game;
}

function combatWave(state, waveId = state.wave) {
  const wave = state.combat.find((entry) => entry.waveId === waveId);
  assert.ok(wave, 'No combat record for wave ' + waveId);
  return wave;
}

function assertCombatAccounting(state, compareTotals = false) {
  for (const wave of state.combat) {
    assert.equal(wave.planned, wave.spawned + wave.pending + wave.cancelledPending);
    assert.equal(wave.spawned, wave.active + wave.cancelledActive + wave.towerKills
      + wave.wallImpacts + wave.playerContacts);
    assert.ok(wave.active <= wave.peakActive && wave.peakActive <= wave.spawned);
    assert.ok(wave.threatened <= wave.spawned);
    assert.equal(wave.firstSpawnAtMs === null, wave.spawned === 0);
    if (wave.firstSpawnAtMs !== null) assert.ok(wave.firstSpawnAtMs >= wave.startedAtMs);
    if (wave.firstThreatAtMs !== null) {
      assert.notEqual(wave.firstSpawnAtMs, null);
      assert.ok(wave.firstThreatAtMs >= wave.firstSpawnAtMs);
    }
    for (const time of [wave.firstBuildingDamageAtMs, wave.firstPlayerDamageAtMs]) {
      if (time !== null) {
        assert.notEqual(wave.firstThreatAtMs, null);
        assert.ok(time >= wave.firstThreatAtMs);
      }
    }
  }
  if (compareTotals) {
    const sum = (key) => state.combat.reduce((total, wave) => total + wave[key], 0);
    assert.equal(sum('planned'), state.requested);
    assert.equal(sum('spawned'), state.spawned);
    assert.equal(sum('pending'), state.pending);
    assert.equal(sum('active'), state.active);
    assert.equal(state.spawned - state.active, state.removed);
  }
}

async function isolatePlayerForQueueTest(page, game) {
  await game.openLineTo({ col: 19, row: 82 }, true);
  await placePressureCard(page, game, 'wall', { col: 19, row: 83 });
}

export async function runPressureQueueRolloverSmoke(page, baseUrl) {
  const game = await openCombatGame(page, baseUrl, 'baseline', 'test', playFixture(seed).layout);
  await isolatePlayerForQueueTest(page, game);
  const blocked = await watchWave(page,
    (state) => state.phase === 'attacking' && state.unreachable > 0 && state.pending > 0
      && state.combat.some((wave) => wave.waveId === state.wave && wave.pending > 0
        && state.combat.some((cohort) => cohort.buildingDamage > 0 && cohort.waveId < wave.waveId)),
    'With the player cut off and the facility destroyed, the entry must retain live enemies and the waiting queue');
  assert.ok(await page.locator('#rebuild-technology').isVisible());
  assert.equal(blocked.hp, 4);
  assertCombatAccounting(blocked, true);
  const contacted = blocked.combat.find((entry) => entry.buildingContacts > 0);
  assert.ok(contacted.threatened > 0);
  assert.notEqual(contacted.firstBuildingDamageAtMs, null);
  assert.equal(contacted.firstPlayerDamageAtMs, null);
  assert.ok(contacted.firstBuildingDamageAtMs > contacted.firstSpawnAtMs);
  const liveCohorts = blocked.combat.filter(({ active, pending }) => active > 0 || pending > 0);
  assert.ok(liveCohorts.some((wave) => wave.active > 0));
  assert.ok(liveCohorts.some((wave) => wave.pending > 0));

  function assertCohortsPreserved(state) {
    assertCombatAccounting(state, true);
    assert.equal(state.active, blocked.active);
    assert.equal(state.unreachable, blocked.unreachable);
    for (const old of liveCohorts) {
      const current = combatWave(state, old.waveId);
      for (const key of ['spawned', 'pending', 'active', 'cancelledPending', 'cancelledActive']) {
        assert.equal(current[key], old[key], 'The previous wave must preserve ' + key + ' while stuck');
      }
      assert.equal(current.settledAtMs, null);
    }
  }

  const recovering = await watchWave(page,
    (state) => state.phase === 'recovering' && state.wave === blocked.wave,
    'The attack deadline should start recovery without clearing unarrived units', 6_000);
  assertCohortsPreserved(recovering);
  const closing = combatWave(recovering);
  assert.equal(closing.attackEndReason, 'time-limit');
  assert.ok(Math.abs(closing.attackEndedAtMs - closing.startedAtMs - 4_500) <= 64);

  const next = await watchWave(page,
    (state) => state.phase === 'attacking' && state.wave === blocked.wave + 1,
    'A no-path wave should not block the next scheduled order', 4_000);
  assertCohortsPreserved(next);
  const queued = combatWave(next);
  assert.equal(queued.spawned, 0);
  assert.equal(queued.active, 0);
  assert.equal(queued.pending, queued.planned);
  assert.equal(queued.firstSpawnAtMs, null);
  assert.equal(next.pending, blocked.pending + queued.planned);
  assert.ok(Math.abs(queued.startedAtMs - closing.attackEndedAtMs - 2_500) <= 64);

  const currentUrl = page.url();
  await game.holdKey('KeyR', () => page.clock.runFor(48));
  const fresh = await readWave(page);
  assert.equal(page.url(), currentUrl);
  assert.deepEqual(await game.position(), GENERATED_SPAWN);
  assert.equal(fresh.phase, 'preparing');
  assert.equal(fresh.wave, 0);
  assert.deepEqual(fresh.combat, []);
  return {
    contactWave: contacted.waveId,
    startedAtMs: contacted.startedAtMs,
    firstSpawnAtMs: contacted.firstSpawnAtMs,
    firstThreatAtMs: contacted.firstThreatAtMs,
    firstBuildingDamageAtMs: contacted.firstBuildingDamageAtMs,
    rolloverWave: closing.waveId,
    rolloverAfterMs: closing.attackEndedAtMs - closing.startedAtMs,
    retained: liveCohorts.map(({ waveId, active, pending }) => ({ waveId, active, pending })),
    nextWave: queued.waveId,
    nextWavePending: queued.pending,
  };
}

export async function runFirstWaveFacilitySmoke(page, baseUrl) {
  const game = await openCombatGame(page, baseUrl, 'baseline', 'test', playFixture(seed).layout);
  const technology = ECONOMY_PROTOTYPE.technologyCell;
  await game.inspect(technology, '空地');
  await page.clock.runFor(32);
  assert.match(await page.locator('#expedition-building').textContent(), /科技设施.+1 HP$/);
  await isolatePlayerForQueueTest(page, game);
  const hit = await watchWave(page, (state) => state.combat[0]?.buildingsDestroyed === 1,
    'The first wave must destroy the facility with a single contact');
  assert.ok(await page.locator('#rebuild-technology').isVisible());
  const firstAtHit = combatWave(hit, 1);
  assert.equal(firstAtHit.buildingContacts, 1);
  assert.equal(firstAtHit.buildingDamage, 1);
  assert.equal(hit.removed, 0, 'A building hit does not consume its attacker');
  assert.ok(firstAtHit.active > 0);
  assertCombatAccounting(hit, true);
  const end = await watchWave(page, (state) => state.phase === 'recovering' && state.wave === 1,
    'The complete first attack phase must close without consuming its units at the facility', 8_000);
  const first = combatWave(end, 1);
  assert.equal(first.spawned, first.planned);
  assert.equal(first.active, first.spawned);
  assert.equal(first.buildingContacts, 1);
  assert.equal(first.towerKills + first.wallImpacts + first.playerContacts, 0);
  assertCombatAccounting(end, true);
  return { planned: first.planned, spawned: first.spawned, activeAfterWave: first.active,
    buildingContacts: first.buildingContacts, buildingDamage: first.buildingDamage,
    removed: end.removed, endReason: first.attackEndReason };
}

export async function runPressurePlayerContactSmoke(page, baseUrl) {
  const game = await openCombatGame(page, baseUrl, 'b');
  await game.walkTo({ col: 21, row: 92 }, true);
  await game.walkTo({ col: 21, row: 94 }, true);
  await game.walkTo({ col: 25, row: 94 });
  const loss = await watchWave(page, (state) => state.phase === 'lost', 'The first scheduled B wave should be lethal without defenses');
  assert.equal(loss.wave, 1);
  assert.equal(loss.hp, 0);
  assert.equal(loss.active, 0);
  assert.equal(loss.pending, 0);
  assertCombatAccounting(loss, true);
  const attack = combatWave(loss);
  assert.equal(attack.planned, 10);
  assert.equal(attack.playerContacts, 4);
  assert.equal(attack.playerDamage, 4);
  assert.ok(attack.firstPlayerDamageAtMs > attack.firstSpawnAtMs);
  assert.equal(attack.firstBuildingDamageAtMs, null);
  assert.equal(attack.attackEndReason, 'terminal');
  assert.ok(attack.cancelledPending + attack.cancelledActive > 0, 'Only a terminal round cancels unfinished enemies');
  assert.notEqual(attack.settledAtMs, null);
  await page.clock.runFor(1_000);
  assert.deepEqual((await readWave(page)).combat, loss.combat);
  return attack;
}

async function placePressureCard(page, game, kind, cell) {
  const card = page.locator('#card-' + kind);
  if (await card.getAttribute('aria-pressed') !== 'true') await card.click();
  await game.inspect(cell, '空地');
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.clock.runFor(32);
  assert.match(await page.locator('#expedition-feedback').textContent(), /^已建造/);
}

export async function runPressureEconomySmoke(page, baseUrl, profile) {
  const game = await openCombatGame(page, baseUrl, profile, 'wait-test');
  const south = (col) => ({ col, row: 94 });
  const wall = south(26);
  const towers = [south(25), south(24)];
  const producer = { col: 20, row: 91 };
  const { initialBalance, towerKillReward, productionAmount, drawCost, buildingHp } = ECONOMY_PROTOTYPE;
  const { researchCost } = TECHNOLOGY_PROTOTYPE;

  await game.holdKey('KeyR', () => page.clock.runFor(32));
  await placePressureCard(page, game, 'economy', producer);
  await game.walkVia({ col: 21, row: 92 }, south(21), south(25));
  await placePressureCard(page, game, 'wall', wall);
  await game.walkTo(south(24), true);
  await placePressureCard(page, game, 'tower', towers[0]);
  await game.walkTo(south(23), true);
  await placePressureCard(page, game, 'tower', towers[1]);
  assert.equal((await readWave(page)).phase, 'preparing', 'Both profiles must complete identical defenses before the attack');
  await game.walkVia(south(21), { col: 21, row: 92 }, GENERATED_SPAWN);

  const recovering = await watchWave(page,
    (state) => state.phase === 'recovering' && state.wave === 1,
    'The fixed line should resolve the first scheduled wave', 7_000);
  assert.ok(recovering.seconds >= 2 && recovering.seconds <= 3, 'Wait-test must preserve the brief recovery window');
  assert.equal(recovering.hp, 4);
  assertCombatAccounting(recovering, true);
  const attack = combatWave(recovering);
  assert.equal(attack.planned, 10);
  assert.equal(attack.spawned, attack.planned);
  assert.equal(attack.towerKills + attack.wallImpacts, attack.planned);
  assert.equal(attack.attackEndReason, 'resolved');
  assert.equal(attack.wallsDestroyed, 0);
  assert.equal(attack.buildingDamage, 0);
  assert.ok(attack.towerKills > 0);
  assert.ok(attack.towerExposed >= attack.towerHitEnemies && attack.towerHitEnemies >= attack.towerKills);
  const hitsPerKill = profile === 'a' ? 1 : 2;
  assert.equal(attack.averageTowerHitsOnKill, hitsPerKill);
  assert.equal(attack.towerHitsOnKills, hitsPerKill * attack.towerKills);
  assert.ok(attack.towerHits >= attack.towerHitsOnKills);
  assert.equal(attack.towerExposureKills, attack.towerKills);
  assert.ok(Number.isFinite(attack.averageTowerExposureToKillMs) && attack.averageTowerExposureToKillMs >= 0);

  // Tier-one wall impacts always deduct one point even when the enemy takes two tower hits.
  assert.equal(attack.wallDamage, attack.wallImpacts);
  await game.inspect(wall, '空地');
  await page.clock.runFor(32);
  const wallHp = buildingHp.wall - attack.wallDamage;
  assert.equal(await page.locator('#expedition-building').textContent(), '城墙 (26, 94) · ' + wallHp + ' HP');

  const income = attack.towerKills * towerKillReward;
  assert.equal(recovering.balance, initialBalance + productionAmount + income);
  await page.locator('#make-card').click();
  assert.equal(Number(await page.locator('#economy-balance').textContent()), recovering.balance - drawCost);
  await page.locator('#research-tool').click();
  assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2');
  await page.clock.runFor(240);
  const settled = await readWave(page);
  assert.equal(settled.wave, 1);
  const economy = settled.economy.find((wave) => wave.waveId === 1);
  assert.deepEqual(economy, {
    waveId: 1,
    openingBalance: initialBalance,
    balance: settled.balance,
    killIncome: income,
    cohortKillIncome: income,
    productionIncome: productionAmount,
    cardsMade: 1,
    cardSpend: drawCost,
    researchSpend: researchCost,
    net: income + productionAmount - drawCost - researchCost,
  });
  assert.equal(economy.balance, economy.openingBalance + economy.net);
  assert.deepEqual(combatWave(settled), attack, 'Economic updates must not add duplicate combat credits');

  await game.holdKey('KeyR', () => page.clock.runFor(48));
  const fresh = await readWave(page);
  assert.equal(fresh.difficulty, profile);
  assert.equal(fresh.balance, initialBalance);
  assert.deepEqual(fresh.combat, []);
  assert.deepEqual(fresh.economy, [{
    waveId: 0, openingBalance: initialBalance, balance: initialBalance, net: 0, killIncome: 0,
    cohortKillIncome: 0, productionIncome: 0, cardsMade: 0, cardSpend: 0, researchSpend: 0,
  }]);
  return {
    profile, speed: 'wait-test',
    planned: attack.planned,
    towerKills: attack.towerKills,
    towerHits: attack.towerHits,
    averageTowerHitsOnKill: attack.averageTowerHitsOnKill,
    averageTowerExposureToKillMs: attack.averageTowerExposureToKillMs,
    wallImpacts: attack.wallImpacts,
    wallDamage: attack.wallDamage,
    wallHp,
    economy,
  };
}

export async function runPressureForecastSmoke(page, baseUrl) {
  await openWideGame(page, baseUrl + '/?mode=play&seed=' + seed + '&difficulty=b');
  assert.ok(await page.locator('#expedition-spawn').isHidden());
  assert.equal((await readWave(page)).phase, 'preparing');
  assert.equal(await page.locator('#round-time-label').textContent(), '下波倒计时');
  assert.equal(await page.locator('#round-time').textContent(), '90 秒');
  assert.equal(await page.locator('#round-next-count').textContent(), '10 只');
  assert.equal(await page.locator('#round-stage').textContent(), '1 · 4 HP');
}

export async function runPressureAlertsSmoke(page, baseUrl) {
  const game = await openCombatGame(page, baseUrl, 'a', 'wait-test');
  const wall = { col: 27, row: 94 };
  const feedback = page.locator('#expedition-feedback');
  const breach = page.locator('#round-breach');
  const status = page.locator('#round-state');
  const timeLabel = page.locator('#round-time-label');
  const count = page.locator('#round-next-count');
  const hover = page.locator('#hover-cell');
  const warning = /^城墙 \(27, 94\) 受袭 · 剩 \d+ HP$/;
  const breachMessage = '东侧防线被突破 · 城墙 (27, 94) 已摧毁';
  const hiddenTile = { col: 16, row: 81 };

  await page.evaluate(() => {
    const notices = [];
    window.pressureSmokeNotices = notices;
    const view = document.getElementById('visible-chunks');
    for (const id of ['expedition-feedback', 'round-breach']) {
      const element = document.getElementById(id);
      new MutationObserver(() => {
        notices.push({
          id, text: element.textContent, at: performance.now(),
          left: Number(view.dataset.worldLeft), width: Number(view.dataset.worldWidth),
        });
      }).observe(element, { childList: true, subtree: true, characterData: true });
    }
  });

  await game.holdKey('KeyR', () => page.clock.runFor(32));
  assert.equal(await timeLabel.textContent(), '下波倒计时');
  assert.equal(await count.textContent(), '10 只');
  assert.equal(await page.locator('#round-stage').textContent(), '1 · 2 HP');
  assert.ok(await breach.isHidden());
  await game.walkVia({ col: 21, row: 92 }, { col: 21, row: 94 }, { col: 26, row: 94 });
  await placePressureCard(page, game, 'wall', wall);
  assert.equal((await readWave(page)).phase, 'preparing');
  await watchWave(page, (state) => state.phase === 'attacking' && state.wave === 1, 'The first normal scheduled order should begin');
  assert.equal(await status.textContent(), '第 1 波开始 · 敌人进攻中');
  assert.equal(await timeLabel.textContent(), '进攻剩余');
  assert.equal(await count.textContent(), '—');

  // An actual move takes the wall completely off camera without changing the fixed enemy route.
  await game.walkVia({ col: 21, row: 94 }, { col: 21, row: 92 }, GENERATED_SPAWN, { col: 19, row: 91 }, { col: 16, row: 91 });
  const view = await game.settleView();
  assert.ok(view.left + view.width < wall.col * TILE_SIZE, 'The wall must be entirely beyond the viewport');
  assert.ok(wall.col - (await game.position()).col > 8, 'The wall must also be outside player vision');
  await watchWave(page, (state) => state.phase === 'recovering' && state.wave === 1, 'The warning fixture must see the first recovery countdown');
  assert.equal(await timeLabel.textContent(), '下波倒计时');
  assert.equal(await count.textContent(), '16 只');

  async function readHiddenTile() {
    await game.aimAt(hiddenTile);
    await page.clock.runFor(32);
    assert.equal(await hover.getAttribute('data-visibility'), 'unknown');
    assert.equal(await hover.textContent(), '未探索');
    return game.tilePixel(hiddenTile);
  }

  const fogBefore = await readHiddenTile();
  const broken = await watchWave(page, (state) => state.combat.some((wave) => wave.wallsDestroyed === 1),
    'The third actual wave should break the 50 HP wall');
  assert.equal(broken.hp, 4);
  assert.equal(broken.wave, 3);
  assert.deepEqual(broken.combat.map((wave) => wave.wallImpacts), [10, 16, 24]);
  assert.equal(await breach.textContent(), breachMessage);
  assert.ok(await breach.isVisible());
  assert.deepEqual(await readHiddenTile(), fogBefore, 'The offscreen warning and breach must not reveal unknown terrain');

  const notices = await page.evaluate(() => window.pressureSmokeNotices);
  const warnings = notices.filter(({ text, id }) => id === 'expedition-feedback' && text.match(warning));
  assert.ok(warnings.some(({ left, width }) => left + width < wall.col * TILE_SIZE),
    'A real wall impact must show an ordinary warning while offscreen');
  assert.ok(warnings.length < 10, 'Repeated impacts must not flood the HUD');
  for (let index = 1; index < warnings.length; index += 1) {
    assert.ok(warnings[index].at - warnings[index - 1].at >= 2_990, 'Warnings at one position must respect cooldown');
  }
  const breakthrough = notices.find(({ id, text }) => id === 'round-breach' && text === breachMessage);
  assert.ok(breakthrough && breakthrough.left + breakthrough.width < wall.col * TILE_SIZE);
  assert.ok(breakthrough.at - warnings.at(-1).at < 3_000, 'Destruction must bypass the ordinary alert cooldown');
  assert.equal(notices.filter(({ id, text }) => id === 'round-breach' && text === breachMessage).length, 1);

  await page.locator('#card-tower').click();
  assert.match(await feedback.textContent(), /放置防御塔/);
  await page.clock.runFor(1_000);
  assert.equal(await breach.textContent(), breachMessage, 'Another status update must not overwrite the breach');
  await game.holdKey('KeyR', () => page.clock.runFor(48));
  const reset = await readWave(page);
  assert.equal(reset.phase, 'preparing');
  assert.equal(reset.wave, 0);
  assert.deepEqual(reset.combat, []);
  assert.ok(await breach.isHidden());
  assert.equal(await count.textContent(), '10 只');

  return {
    wallImpacts: broken.combat.map((wave) => wave.wallImpacts),
    warnings: warnings.length,
    breakthrough: breakthrough.text,
    firstWarningObservedMs: warnings[0].at,
    breakthroughObservedMs: breakthrough.at,
  };
}

function readClock(page) {
  return page.evaluate(() => performance.now());
}

async function advanceRoundClock(page, startMs, goalMs) {
  let remaining = Math.ceil(goalMs - (await readClock(page) - startMs));
  while (remaining > 0) {
    const step = Math.min(12_000, remaining);
    await page.clock.runFor(step);
    remaining -= step;
  }
}

async function defendOutcomeRoute(page, game) {
  const south = (col) => ({ col, row: 94 });
  const producer = { col: 20, row: 91 };
  const towers = [south(25), south(24)];
  const walls = [south(26), south(23), south(22)];

  await placePressureCard(page, game, 'economy', producer);
  await game.walkVia({ col: 21, row: 92 }, south(21), south(25));
  await placePressureCard(page, game, 'wall', walls[0]);
  await game.walkTo(south(24), true);
  await placePressureCard(page, game, 'tower', towers[0]);
  await game.walkTo(south(23), true);
  await placePressureCard(page, game, 'tower', towers[1]);
  await game.walkTo(south(22), true);
  await placePressureCard(page, game, 'wall', walls[1]);
  await game.walkTo(south(21), true);
  await placePressureCard(page, game, 'wall', walls[2]);
  await game.walkTo({ col: 21, row: 92 }, true);
  await game.walkTo(GENERATED_SPAWN, true);
  await page.keyboard.press('Escape');
  return [producer, ...towers, ...walls, ECONOMY_PROTOTYPE.technologyCell];
}

export async function runPressureOutcomeSmoke(page, baseUrl, profile, speed, outcome) {
  const { layout } = playFixture(seed);
  const game = await openCombatGame(page, baseUrl, profile, speed, layout);
  const [normalPreparationMs, attackSeconds, firstNormalCount] = cases[profile].normal;
  const preparationMs = speed === 'normal' ? normalPreparationMs : 2_500;
  const firstCount = speed === 'normal' || profile !== 'baseline' ? firstNormalCount : 3;
  const currentUrl = page.url();
  const status = page.locator('#round-state');

  async function reset() {
    await game.holdKey('KeyR', () => page.clock.runFor(32));
    const state = await readWave(page);
    assert.equal(page.url(), currentUrl);
    assert.deepEqual(await game.position(), GENERATED_SPAWN);
    assert.equal(state.phase, 'preparing');
    assert.equal(state.seconds, Math.ceil(preparationMs / 1_000));
    assert.equal(state.difficulty, profile);
    assert.equal(state.hp, 4);
    assert.deepEqual(state.combat, []);
  }

  await reset();
  const startMs = await readClock(page);
  let blockers;
  if (outcome === 'won') {
    blockers = await defendOutcomeRoute(page, game);
  } else {
    await game.walkVia({ col: 21, row: 92 }, { col: 21, row: 94 });
    await game.walkTo({ col: 25, row: 94 });
  }

  await advanceRoundClock(page, startMs, preparationMs - 512);
  const firstAttack = await watchWave(page,
    (state) => state.combat.some((wave) => wave.waveId === 1),
    'The scheduled first wave must enter the world using the chosen timing', 1_200);
  if (outcome === 'lost') {
    assert.equal(firstAttack.phase, 'attacking');
    assert.equal(firstAttack.seconds, attackSeconds);
  }
  const first = combatWave(firstAttack, 1);
  assert.equal(first.planned, firstCount);
  assert.ok(Math.abs(first.startedAtMs - preparationMs) <= 96);

  let route;
  if (outcome === 'won') {
    // The route, placements, and departure offset are held fixed across difficulty profiles.
    await advanceRoundClock(page, startMs, preparationMs + 5_500);
    assert.ok(await page.locator('#research-tool').isEnabled());
    await page.locator('#research-tool').click();
    assert.equal(await page.locator('#tool-level').textContent(), 'Lv.2');
    route = findDiggablePath(blockers);
    await followRoute(page, game, route, {
      stopAt: { col: 19, row: 82 },
      onStop: () => placePressureCard(page, game, 'wall', { col: 19, row: 83 }),
    });
    assert.deepEqual(await game.position(), GENERATED_GOAL);
  }

  const terminal = await watchWave(page, (state) => state.phase === outcome,
    'The fixed route must end with ' + outcome, 75_000);
  const elapsedMs = Math.round(await readClock(page) - startMs);
  assert.equal(terminal.active, 0);
  assert.equal(terminal.pending, 0);
  assertCombatAccounting(terminal, true);
  const total = (key) => terminal.combat.reduce((sum, wave) => sum + wave[key], 0);
  if (outcome === 'won') {
    assert.match(await status.textContent(), /获胜/);
    assert.ok(terminal.hp > 0);
    assert.ok(total('towerKills') > 0);
  } else {
    assert.match(await status.textContent(), /战败|失败/);
    assert.equal(terminal.hp, 0);
    assert.equal(total('playerContacts'), 4);
    assert.equal(total('playerDamage'), 4);
    assert.equal(total('towerKills'), 0);
  }

  const terminalPosition = await game.position();
  await game.holdKey('KeyS', () => page.clock.runFor(700));
  await page.clock.runFor(2_500);
  assert.deepEqual(await game.position(), terminalPosition);
  assert.deepEqual(await readWave(page), terminal, 'The finished round must stop movement and combat accounting');
  await reset();

  return {
    profile, speed, outcome, wave: terminal.wave, hp: terminal.hp, elapsedMs, firstCount,
    firstWaveStartedAtMs: Math.round(first.startedAtMs),
    towerKills: total('towerKills'), wallImpacts: total('wallImpacts'), wallsDestroyed: total('wallsDestroyed'),
    buildingDamage: total('buildingDamage') + total('wallDamage'), playerDamage: total('playerDamage'),
    routeSteps: route ? route.length - 1 : null,
  };
}

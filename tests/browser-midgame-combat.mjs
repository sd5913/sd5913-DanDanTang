import assert from "node:assert/strict";
import { GENERATED_SPAWN } from "../src/generated-map.ts";
import { TILE_SIZE } from "../src/player.ts";
import { advanceUntil, openChallenge, readRound, startFirstWave } from "./browser-challenge.mjs";
import { playFixture } from "./browser-fix02.mjs";

const cell = (col, row) => ({ col, row });
const stageRoute515 = [
  GENERATED_SPAWN, cell(19, 86), cell(20, 86), cell(20, 85), cell(21, 85), cell(21, 84), cell(22, 84),
  cell(22, 82), cell(23, 82), cell(23, 81), cell(24, 81), cell(24, 80), cell(29, 80), cell(29, 78),
  cell(31, 78), cell(31, 76), cell(33, 76), cell(33, 63),
];
const towerSites515 = [25, 24, 23, 22].map((col) => cell(col, 93));
const now = (page) => page.evaluate(() => performance.now());

async function excavateRoute(page, run, layout, stops) {
  for (const [index, start] of stops.slice(0, -1).entries()) {
    const end = stops[index + 1];
    const axis = start.col === end.col ? "row" : "col";
    const direction = Math.sign(end[axis] - start[axis]);
    for (let value = start[axis] + direction; (end[axis] - value) * direction >= 0; value += direction) {
      const current = { ...start, [axis]: value };
      const tile = layout[current.row][current.col];
      assert.ok(/[.+S]/.test(tile), "The actual seed route must support the Lv.1 tool");
      if (tile !== "+") continue;
      await run.game.walkTo({ ...current, [axis]: value - direction }, true);
      await run.game.inspect(current);
      if ((await page.locator("#hover-cell").textContent()).includes("可挖地形")) await run.mine(current);
    }
    await run.game.walkTo(end, true);
  }
}

async function approachPalette(page, game) {
  const view = await game.view();
  return page.locator("#board canvas").evaluate((canvas, { view, tile }) => {
    const x = Math.max(0, Math.floor(((25 * tile) - view.left) * canvas.width / view.width));
    const right = Math.min(canvas.width, Math.ceil(((32 * tile) - view.left) * canvas.width / view.width));
    const y = Math.max(0, Math.floor(((93 * tile) - view.top) * canvas.height / view.height));
    const bottom = Math.min(canvas.height, Math.ceil(((95 * tile) - view.top) * canvas.height / view.height));
    const colors = { normal: 0, armored: 0, ring: 0 };
    if (right <= x || bottom <= y) return colors;
    const data = canvas.getContext("2d").getImageData(x, y, right - x, bottom - y).data;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r === 236 && g === 129 && b === 122) colors.normal += 1;
      if (r === 226 && g === 179 && b === 101) colors.armored += 1;
      if (r === 59 && g === 51 && b === 33) colors.ring += 1;
    }
    return colors;
  }, { view, tile: TILE_SIZE });
}

async function armorSmoke(page, baseUrl) {
  const seed = 515;
  const { layout } = playFixture(seed);
  const run = await openChallenge(page, baseUrl, seed, "w25", "armored");
  assert.equal(await page.locator("#midgame-experiment").inputValue(), "armored");
  await run.mineOpening();
  await run.draw("tower");
  await run.mineTo(9);
  for (const _site of towerSites515.slice(1)) await run.draw("tower");
  assert.equal(Number(await run.cash()), 0);
  for (const [index, site] of towerSites515.entries()) {
    await run.returnTo(cell(site.col, 94));
    if (site.col !== 22) await run.mine(site);
    await run.place("tower", site, { merge: index === towerSites515.length - 1 });
  }
  await run.game.inspect(towerSites515[0], "空地");
  await page.clock.runFor(32);
  assert.equal(await run.building.textContent(), "防御塔 (25, 93) · 1 HP · Lv.2");
  assert.match(await page.locator("#expedition-building-stats").textContent(), /伤害 5 .*间隔 300 ms/);
  await run.returnTo(GENERATED_SPAWN);
  const preStage = cell(33, 64);
  const routeHome = stageRoute515.slice(0, -1);
  await excavateRoute(page, run, layout, [...routeHome, preStage]);
  assert.equal(await page.locator("#round-stage").textContent(), "1 · 4 HP");
  if ((await readRound(page)).phase === "preparing") await startFirstWave(page, run.start);
  const opening = (await readRound(page)).combat[0];
  assert.equal(opening.enemyKinds.normal.planned, 8);
  assert.equal(opening.enemyKinds.armored.planned, 0);
  await run.mine(stageRoute515.at(-1));
  await run.game.walkTo(stageRoute515.at(-1), true);
  assert.deepEqual(await run.game.position(), stageRoute515.at(-1));
  assert.equal(await page.locator("#round-stage").textContent(), "2 · 7 HP");

  await run.game.walkVia(...routeHome.reverse());
  await run.returnTo(cell(21, 92));
  await run.game.settleView();
  const preparedAtMs = Math.round((await now(page)) - run.start);
  assert.equal((await readRound(page)).wave, 1, "Return before the next mixed wave at actual " + preparedAtMs + " ms");
  const secondsLeft = Number((await page.locator("#round-time").textContent()).match(/\d+/)?.[0]);
  await page.clock.runFor(Math.max(0, secondsLeft - 1) * 1_000);
  await advanceUntil(page, ({ combat }) => combat[1]?.planned === 16,
    "The natural second wave must use the newly reached stage", 2_000);

  const maxPixels = { normal: 0, armored: 0, ring: 0 };
  let mixed;
  for (let elapsed = 0; elapsed < 4_000; elapsed += 48) {
    const current = (await readRound(page)).combat[1];
    const colors = await approachPalette(page, run.game);
    maxPixels.normal = Math.max(maxPixels.normal, colors.normal);
    maxPixels.armored = Math.max(maxPixels.armored, colors.armored);
    maxPixels.ring = Math.max(maxPixels.ring, colors.ring);
    if (current.enemyKinds.normal.towerKills > 0 && current.enemyKinds.armored.towerKills > 0
      && maxPixels.normal > 0 && maxPixels.armored > 0 && maxPixels.ring > 0) {
      mixed = current;
      break;
    }
    await page.clock.runFor(48);
  }
  assert.ok(mixed, "Actual mixed wave must draw both enemy types and the paid tower must kill both. "
    + JSON.stringify({ maxPixels, wave: (await readRound(page)).combat[1] }));
  const { normal, armored } = mixed.enemyKinds;
  assert.equal(normal.planned, 12);
  assert.equal(armored.planned, 4);
  assert.equal(normal.averageTowerHitsOnKill, 2);
  assert.equal(armored.averageTowerHitsOnKill, 3);
  const economy = (await readRound(page)).economy.find(({ waveId }) => waveId === mixed.waveId);
  assert.equal(economy.cohortKillIncome, mixed.towerKills * 2);
  return {
    seed, record: "mixed", preparedAtMs, openingArmor: opening.enemyKinds.armored.planned,
    mixedWave: mixed.waveId, normal, armored, maxPixels, cohortKillIncome: economy.cohortKillIncome,
  };
}

async function densitySmoke(page, baseUrl) {
  const seed = 9;
  const run = await openChallenge(page, baseUrl, seed, "w35", "dense");
  assert.equal(await page.locator("#midgame-experiment").inputValue(), "dense");
  await run.mineOpening();
  await run.draw("wall");
  await run.returnTo(cell(23, 94));
  const gate = cell(24, 94);
  await run.place("wall", gate);
  await run.game.inspect(gate, "空地");
  await page.clock.runFor(32);
  assert.match(await run.building.textContent(), /35 HP/);
  await run.returnTo(GENERATED_SPAWN);
  await run.game.openLineTo(cell(19, 83), true);
  await run.game.walkTo(GENERATED_SPAWN, true);
  await startFirstWave(page, run.start);
  await page.clock.runFor(40_000);
  const round = await advanceUntil(page, ({ combat }) => combat[2]?.spawned >= 8 && combat[2].wallImpacts >= 2,
    "The actual third wave must release into the built southern wall", 14_000);
  const [one, two, third] = round.combat;
  assert.deepEqual([one.plannedSpawnIntervalMs, two.plannedSpawnIntervalMs, third.plannedSpawnIntervalMs], [200, 200, 150]);
  assert.deepEqual([one.wallImpacts, two.wallImpacts], [8, 16]);
  assert.equal(third.planned, 24);
  assert.ok(third.actualSpawnsPerSecond > two.actualSpawnsPerSecond + 0.5);
  assert.ok(third.actualSpawnsPerSecond <= 1_000 / 150 + 1e-6);
  assert.equal(third.spawned + third.pending + third.cancelledPending, third.planned);
  assert.ok(third.firstWallImpactAtMs > third.firstSpawnAtMs);
  await run.game.inspect(gate, "空地");
  await page.clock.runFor(32);
  const wallLabel = await run.building.textContent();
  assert.match(wallLabel, /城墙 .* [1-9] HP/);
  return {
    seed, record: "density", configured: [200, 200, 150],
    actual: [one.actualSpawnsPerSecond, two.actualSpawnsPerSecond, third.actualSpawnsPerSecond],
    thirdSpawned: third.spawned, thirdPending: third.pending, thirdWallImpacts: third.wallImpacts, wallLabel,
  };
}

export function runMidgameCombatSmoke(page, baseUrl, scenario) {
  assert.ok(scenario === "armor" || scenario === "density");
  return scenario === "armor" ? armorSmoke(page, baseUrl) : densitySmoke(page, baseUrl);
}

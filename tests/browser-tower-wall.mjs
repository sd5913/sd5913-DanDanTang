import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { evolvedTowerAttributes, PLAYTEST_TOWER_TUNING } from "../src/building-balance.ts";
import { PLAYTEST_PROFILE } from "../src/launch-config.ts";
import { TILE_SIZE } from "../src/player.ts";
import { readCardInventory } from "./browser-card-feedback.mjs";
import { openChallenge, readRound, startFirstWave } from "./browser-challenge.mjs";
import { OpeningRun } from "./challenge-opening.mjs";

const seed = 38;
const viewport = { width: 1280, height: 900 };
const cell = (col, row) => ({ col, row });
const label = ({ col, row }) => "(" + col + ", " + row + ")";
const expectedCards = ["wall", "tower", "tower", "tower", "tower"];
const colors = { beam: "#a4faff", fallback: "#ffc88b", burst: "#f9bd7a", reach: "rgba(164,250,255,0.65)",
  fallbackCircle: "rgba(255,200,139,0.65)", burstCircle: "rgba(140,233,255,0.6)" };

async function installCanvasWitness(page) {
  await page.evaluate((styles) => {
    // Observe Phaser's actual Canvas strokes without altering colors, paths, game state, or rules.
    const accepted = new Map(Object.entries(styles).map(([key, color]) => [color, key]));
    const paths = new WeakMap();
    const recorded = new Map();
    const canvas = document.querySelector("#board canvas");
    const context = canvas.getContext("2d");
    const beginPath = context.beginPath;
    const moveTo = context.moveTo;
    const lineTo = context.lineTo;
    const stroke = context.stroke;
    context.beginPath = function () {
      paths.set(this, []);
      return beginPath.call(this);
    };
    context.moveTo = function (x, y) {
      paths.get(this)?.push([x, y]);
      return moveTo.call(this, x, y);
    };
    context.lineTo = function (x, y) {
      paths.get(this)?.push([x, y]);
      return lineTo.call(this, x, y);
    };
    context.stroke = function (...args) {
      const kind = accepted.get(String(this.strokeStyle).replaceAll(" ", ""));
      const points = paths.get(this);
      if (kind && points?.length === 2) {
        const segments = recorded.get(kind) ?? new Map();
        const key = JSON.stringify(points);
        if (!segments.has(key)) segments.set(key, points);
        recorded.set(kind, segments);
      }
      return stroke.apply(this, args);
    };
    window.takeTowerWallCanvasStrokes = () => {
      const strokes = Object.fromEntries([...recorded].map(([style, segments]) => [style, [...segments.values()]]));
      recorded.clear();
      return strokes;
    };
  }, colors);
}

async function readCombat(page) {
  return page.locator("#defense-stats").evaluate(({ dataset }) => {
    const fields = ["spawned", "active", "visible", "removed", "shots", "wallImpacts", "towerKills"];
    return Object.fromEntries(fields.map((key) => [key, Number(dataset[key])]));
  });
}

async function readWall(page, run, target) {
  await run.game.inspect(target, "空地");
  await page.clock.runFor(16);
  return Number((await page.locator("#expedition-building-stats").textContent()).match(/耐久 (\d+)\/25 HP/)?.[1] ?? 0);
}

async function fundPaidFortification(page, baseUrl) {
  const run = await openChallenge(page, baseUrl, seed, "w25", "combined", { playtestUrl: "/" });
  const plan = new OpeningRun(seed, "challenge", "w25", "combined");
  const cost = plan.fundFacility();
  let applied = 0;
  const replayMining = async () => {
    for (const step of plan.miningActions.slice(applied)) {
      await run.returnTo(step.from);
      await run.mine(step.target, undefined, { untilMined: true });
    }
    applied = plan.miningActions.length;
  };
  await replayMining();
  await run.returnTo(plan.facility.from);
  await run.buildTechnology(plan.facility.target);
  let paid = cost;
  for (const [index, expected] of expectedCards.entries()) {
    const price = index < 3 ? 3 : 6;
    paid += 10 * price;
    assert.ok(plan.mineToIncome(paid, 0, Infinity, ({ col }) => col <= 22));
    await replayMining();
    assert.equal(await run.maker.textContent(), "制造卡牌（" + price + " 经济）");
    assert.equal(await run.draw(expected), expected);
    assert.equal(plan.draw(), expected);
  }
  assert.equal(await run.cash(), "0.0");
  assert.deepEqual(await readCardInventory(page), { wall: 1, tower: 4, economy: 0 });
  return run;
}

async function digSideAccess(page, run, throughCol = 25) {
  for (let col = 22; col <= throughCol; col += 1) {
    await run.returnTo(cell(col - 1, 93));
    const tile = cell(col, 93);
    await run.game.aimAt(tile);
    if (!(await page.locator("#hover-cell").textContent()).includes("空地")) {
      await run.mine(tile, undefined, { untilMined: true });
    }
  }
}

async function buildTower(page, run, kind, positions, builders) {
  for (const [index, target] of positions.entries()) {
    await run.returnTo(builders[index]);
    await run.place("tower", target);
  }
  await run.game.inspect(positions.at(-1), "空地");
  await run.clickBoard();
  const merge = page.locator("#merge-confirm");
  assert.ok(await merge.isEnabled());
  await merge.click();
  await page.clock.runFor(32);
  if (await merge.isVisible()) {
    await merge.click();
    await page.clock.runFor(32);
  }
  const name = kind === "burst" ? "Burst Tower Lv.2" : "Piercing Tower Lv.2";
  assert.match(await page.locator("#expedition-feedback").textContent(), new RegExp("^已合成 " + name));
  for (const tile of positions.slice(1)) run.occupied.delete(label(tile));
  const retained = positions[0];
  await run.game.inspect(retained, "空地");
  await page.clock.runFor(16);
  assert.equal(await run.building.textContent(), name + " " + label(retained) + " · 1 HP");
  return retained;
}

async function assertPrepared(page) {
  const phase = await readRound(page);
  assert.equal(phase.phase, "preparing", "The actual paid layout must finish before the first regular wave");
  assert.equal(phase.wave, 0);
  for (const selector of ["#expedition-debug", "#defense-panel", "#round-difficulty-controls"]) {
    assert.ok(await page.locator(selector).isHidden());
  }
  await installCanvasWitness(page);
}

function crossesVerticalGate(segment, wall) {
  const [[fromX, fromY], [toX, toY]] = segment;
  const left = wall.col * TILE_SIZE;
  const right = (wall.col + 1) * TILE_SIZE;
  if (!(fromX < left && toX > right)) return false;
  const yAt = (x) => fromY + (toY - fromY) * ((x - fromX) / (toX - fromX));
  const yLeft = yAt(left);
  const yRight = yAt(right);
  return Math.max(yLeft, yRight) > wall.row * TILE_SIZE && Math.min(yLeft, yRight) < (wall.row + 1) * TILE_SIZE;
}

async function followFirstAttack(page, witness, budgetMs = 3_200, beforeStart) {
  let previous = beforeStart ?? await readCombat(page);
  for (let elapsed = 0; elapsed < budgetMs; elapsed += 16) {
    if (elapsed > 0) await page.clock.runFor(16);
    const combat = await readCombat(page);
    const strokes = await page.evaluate(() => window.takeTowerWallCanvasStrokes());
    const evidence = witness({ elapsed, combat, previous, strokes });
    if (evidence) return evidence;
    previous = combat;
  }
  assert.fail("No expected fire before the deadline: " + JSON.stringify(previous));
}

function previewExtent(segments, origin, range) {
  const radius = range * TILE_SIZE;
  assert.ok(segments?.length, "The current hover must draw acquisition coverage");
  for (const point of segments.flat()) {
    assert.ok(Math.abs(Math.hypot(point[0] - origin[0], point[1] - origin[1]) - radius) < 0.001,
      "The range ring must use the exact configured radius");
  }
  assert.ok(segments.flat().some(([x]) => Math.abs(x - origin[0] - radius) < 0.001), "The eastern reach must be drawn");
}

async function runPlaytestWallSmoke(page, baseUrl, kind, { legacy = false, stage1 = false } = {}) {
  const run = await fundPaidFortification(page, baseUrl);
  await digSideAccess(page, run);
  const isPiercing = kind === "piercing";
  const positions = isPiercing ? [24, 25, 26, 27].map((col) => cell(col, 94))
    : [cell(24, 94), cell(23, 94), cell(22, 94), cell(22, 93)];
  const builders = isPiercing ? [25, 26, 27, 28].map((col) => cell(col, 94))
    : [cell(24, 93), cell(23, 93), cell(22, 93), cell(23, 93)];
  const tower = await buildTower(page, run, kind, positions, builders);
  const gate = cell(25, 94);
  await run.returnTo(cell(25, 93));
  await run.place("wall", gate);
  assert.equal(await readWall(page, run, gate), 25);
  await run.game.holdKey("KeyS", () => page.clock.runFor(256));
  assert.deepEqual(await run.game.position(), cell(25, 93), "The friendly wall must still block movement");
  await assertPrepared(page);

  await run.game.inspect(tower, "空地");
  await page.clock.runFor(32);
  const tuning = stage1 ? PLAYTEST_TOWER_TUNING : PLAYTEST_PROFILE.towerTuning;
  const attributes = evolvedTowerAttributes({ kind, axis: "horizontal" }, "ordinary", tuning);
  const fallbackRange = tuning.piercingFallbackRange ?? 3;
  const tooltip = await page.locator("#expedition-building-stats").textContent();
  const hover = await page.evaluate(() => window.takeTowerWallCanvasStrokes());
  if (!legacy) {
    assert.match(tooltip, new RegExp("射程 " + attributes.range + " 格"));
    const origin = [24.5 * TILE_SIZE, 94.5 * TILE_SIZE];
    if (isPiercing) {
      assert.match(tooltip, new RegExp("备用 " + fallbackRange + " 格"));
      assert.ok(hover.reach?.some((segment) => crossesVerticalGate(segment, gate)),
        "The cyan hover preview must extend through the wall");
      previewExtent(hover.fallbackCircle, origin, fallbackRange);
    } else {
      previewExtent(hover.burstCircle, origin, attributes.range);
    }
  }
  await run.game.inspect(gate, "空地");
  const beforeStart = await readCombat(page);
  await startFirstWave(page, run.start, { publicBuild: true });
  if (legacy) {
    const evidence = await followFirstAttack(page, ({ combat, elapsed }) => combat.wallImpacts >= 4 && { combat, elapsed });
    assert.equal(evidence.combat.shots, 0);
    assert.equal(await readWall(page, run, gate), 21);
    return { kind, seed, firstFourWallImpacts: evidence, wallHp: 21, tooltip };
  }
  const hit = await followFirstAttack(page, ({ elapsed, combat, previous, strokes }) => {
    const additionalHits = combat.shots - previous.shots;
    if (!additionalHits) return undefined;
    if (isPiercing) {
      const beam = strokes.beam?.find((segment) => crossesVerticalGate(segment, gate));
      return beam && { elapsed, additionalHits, combat, beam };
    }
    if (additionalHits < 2) return undefined;
    const ring = strokes.burst?.filter((points) => points.every(([x]) => x >= (gate.col + 1) * TILE_SIZE));
    return ring?.length && { elapsed, additionalHits, combat, drawnOutside: ring.length };
  }, 3_200, beforeStart);
  const wallHp = await readWall(page, run, gate);
  assert.equal(hit.combat.wallImpacts, 0, "An actual attack must land before the first wall collision");
  assert.equal(wallHp, 25, "The wall must still have the original 25 HP");
  const later = await followFirstAttack(page, ({ combat }) => (combat.wallImpacts > 0 || combat.removed === 8) && combat);
  if (later.wallImpacts > 0) assert.ok(await readWall(page, run, gate) < 25);
  else assert.equal(later.towerKills, 8);
  return { seed, kind, tower, gate, tooltip, hit, wallHp,
    subsequentImpacts: later.wallImpacts, wallHpAfter: await readWall(page, run, gate), cash: await run.cash() };
}

export const runPlaytestPiercingWallSmoke = (page, url) => runPlaytestWallSmoke(page, url, "piercing");
export const runPlaytestBurstWallSmoke = (page, url) => runPlaytestWallSmoke(page, url, "burst");

async function runPlaytestFallbackWallSmoke(page, baseUrl) {
  const run = await fundPaidFortification(page, baseUrl);
  await digSideAccess(page, run, 24);
  await run.returnTo(cell(26, 94));
  await run.mine(cell(26, 93), undefined, { untilMined: true });
  const positions = [24, 23, 22, 21].map((col) => cell(col, 93));
  const builders = positions.map(({ col }) => cell(col, 94));
  const tower = await buildTower(page, run, "piercing", positions, builders);
  const gate = cell(26, 94);
  const dirt = cell(25, 93);
  await run.returnTo(cell(25, 94));
  await run.place("wall", gate);
  assert.equal(await readWall(page, run, gate), 25);
  await run.game.inspect(dirt, "可挖地形", "HP 5/5");
  await assertPrepared(page);

  await startFirstWave(page, run.start, { publicBuild: true });
  const blocked = await followFirstAttack(page, ({ combat, elapsed }) => combat.wallImpacts >= 1 && { ...combat, elapsed });
  assert.equal(blocked.shots, 0, "Solid ground must still block the enemy approaching the friendly gate");
  const wallHpBeforeDig = await readWall(page, run, gate);
  assert.equal(wallHpBeforeDig, 24);
  await run.mine(dirt, undefined, { untilMined: true });

  const range = PLAYTEST_PROFILE.towerTuning.piercingFallbackRange;
  const hit = await followFirstAttack(page, ({ combat, strokes }) => {
    if (combat.shots === blocked.shots) return undefined;
    const acrossWall = strokes.fallback?.find((segment) => crossesVerticalGate(segment, gate));
    if (!acrossWall) return undefined;
    const [[fromX, fromY], [toX, toY]] = acrossWall;
    const distance = Math.hypot(toX - fromX, toY - fromY) / TILE_SIZE;
    if (distance <= 3 + 5 / TILE_SIZE) return undefined;
    assert.ok(distance <= range + 5 / TILE_SIZE + 0.001);
    assert.notEqual(fromY, toY, "A fallback shot must strike an off-axis moving enemy");
    return { combat, acrossWall, distance };
  }, 1_200);
  const wallHpAfterDig = await readWall(page, run, gate);
  assert.ok(wallHpAfterDig > 0 && wallHpAfterDig <= wallHpBeforeDig, "The same wall must survive the first fallback hit");
  await run.game.inspect(tower, "空地");
  await page.clock.runFor(16);
  assert.match(await page.locator("#expedition-building-stats").textContent(), new RegExp("备用 " + range + " 格"));
  return { seed, tower, gate, dirt, range, blocked, hit, wallHpBeforeDig, wallHpAfterDig };
}

async function runBrowser() {
  const old = process.argv.includes("--baseline");
  const stage1 = process.argv.includes("--stage1");
  const dist = old ? ".estd-private/p0-j-fix02-baseline/dist"
    : stage1 ? ".estd-private/p0-j-fix02-wall-only/dist" : "dist";
  const server = await preview({ mode: "production", logLevel: "warn",
    build: { outDir: dist },
    preview: { host: "127.0.0.1", port: 0, strictPort: true } });
  const address = server.httpServer.address();
  const url = "http://127.0.0.1:" + address.port;
  const browser = await chromium.launch({ channel: "msedge" });
  const cases = process.argv.includes("--fallback") ? [runPlaytestFallbackWallSmoke]
    : [runPlaytestPiercingWallSmoke, runPlaytestBurstWallSmoke];
  const results = [];
  try {
    for (const [index, verify] of cases.entries()) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      try {
        const outcome = old || stage1 ? await runPlaytestWallSmoke(page, url, ["piercing", "burst"][index], { legacy: old, stage1 })
          : await verify(page, url);
        assert.deepEqual(errors, []);
        results.push(outcome);
        console.log(JSON.stringify(outcome));
      } finally {
        await page.close();
      }
    }
    if (process.argv.includes("--record")) {
      const root = await realpath(".");
      const directory = join(root, ".estd-private");
      await mkdir(directory, { recursive: true });
      assert.equal(await realpath(directory), directory);
      const file = join(directory, "p0-j-fix02-edge-" + (old ? "legacy" : stage1 ? "wall-only" : process.argv.includes("--fallback") ? "fallback" : "playtest") + ".json");
      await writeFile(file, JSON.stringify({ version: browser.version(), viewport, results }, null, 2));
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runBrowser();

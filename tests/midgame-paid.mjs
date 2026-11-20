import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { towerAttributes } from "../src/building-balance.ts";
import { sameCell } from "../src/defense-simulation.ts";
import { toEconomyTenths } from "../src/expedition-economy.ts";
import { GENERATED_ENEMY_ENTRY } from "../src/generated-map.ts";
import { OpeningRun } from "./challenge-opening.mjs";

export const MIDGAME_SEEDS = [9, 12, 512, 515, 1091];
export const PAID_EXPERIMENTS = ["control", "dense", "armored", "tier", "kill-decay", "economy-combined", "combat-combined", "combined"];

const policies = {
  balanced: { openingDraws: 5, recoveryDraws: 4, order: ["wall", "tower", "economy"], reserveResearch: 1 },
  "tower-focus": { openingDraws: 6, recoveryDraws: 6, order: ["tower", "wall", "economy"], reserveResearch: 2, cluster: true },
  "economy-first": { openingDraws: 5, recoveryDraws: 5, order: ["economy", "wall", "tower"], reserveResearch: 1 },
  maze: { openingDraws: 5, recoveryDraws: 4, order: ["wall", "tower", "economy"], reserveResearch: 1, detour: true },
};
const cell = (col, row) => ({ col, row });
const gap = (a, b) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
const refuge = cell(18, 88);
const gate = cell(24, 94);
const detourAnchor = cell(21, 91);
const mazeTiles = [cell(23, 90), cell(24, 90), cell(25, 90), cell(26, 90), cell(27, 90),
  cell(27, 89), cell(28, 89), cell(29, 89), cell(29, 90), cell(29, 91), cell(29, 92)];
const stations = {
  wall: [gate, cell(23, 94), cell(22, 94), cell(21, 93), cell(20, 91)],
  tower: [cell(23, 93), cell(22, 92), cell(25, 91), cell(27, 90), cell(22, 88), cell(20, 89), cell(19, 87), cell(16, 85)],
  economy: [cell(17, 89), cell(19, 89), cell(21, 89), cell(17, 87), cell(19, 87), cell(21, 87), cell(16, 85), cell(18, 85)],
  technology: [cell(17, 90), cell(16, 88), cell(18, 86)],
};
const clusterTowers = [cell(23, 91), cell(23, 90), cell(22, 90), cell(22, 91), cell(25, 91),
  cell(25, 90), cell(26, 90), cell(26, 91), ...stations.tower];
const openingBudgetMs = 49_000;
const openingPlacementMs = 58_000;
const horizonMs = 900_000;
const protectIntake = ({ col, row }) => col <= 22 || row <= 86;

function path(map, from, finish, canPass = (position) => map.isWalkable(position)) {
  const queue = [{ position: from, parent: null }];
  const key = ({ col, row }) => row * map.columns + col;
  const visited = new Set([key(from)]);
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (finish(item.position)) {
      const steps = [];
      for (let current = item; current.parent; current = current.parent) steps.push(current.position);
      return steps.reverse();
    }
    const { col, row } = item.position;
    for (const target of [cell(col, row - 1), cell(col - 1, row), cell(col + 1, row), cell(col, row + 1)]) {
      if (!map.isInside(target) || visited.has(key(target)) || !canPass(target)) continue;
      visited.add(key(target));
      queue.push({ position: target, parent: item });
    }
  }
  return null;
}

function buy(run, limitMs, strategy) {
  const shortage = toEconomyTenths(run.economy.drawCost) - toEconomyTenths(run.economy.balance);
  if (shortage > 0 && run.economy.hasTechnology) {
    run.mineToIncome(toEconomyTenths(run.economy.totals.miningIncome) + shortage, 75, limitMs,
      strategy.detour ? protectIntake : undefined);
  }
  return !run.finished && run.now < limitMs ? run.draw() : undefined;
}

function buildingStance(run, target, limitMs) {
  const { map, player } = run;
  const tile = map.getCell(target);
  if (tile.buildingId !== null || (tile.terrain !== "empty" && tile.terrain !== "dirt")) return false;
  const dig = tile.terrain === "dirt";
  const options = [];
  for (let row = target.row - 1; row <= target.row + 1; row += 1) {
    for (let col = target.col - 1; col <= target.col + 1; col += 1) {
      const stance = cell(col, row);
      if (sameCell(stance, target) || !map.isWalkable(stance) || (dig && gap(stance, target) !== 1)) continue;
      options.push(stance);
    }
  }
  options.sort((a, b) => gap(player.cell, a) - gap(player.cell, b));
  for (const candidate of options) {
    const route = path(map, player.cell, (position) => sameCell(position, candidate));
    if (!route || run.now + route.length * 200 + (dig ? 1_500 : 0) >= limitMs) continue;
    if (dig && map.getDigFailure(candidate, target, run.economy.toolLevel)) continue;
    run.moveTo(candidate);
    if (run.finished) return false;
    if (dig) run.mine(target);
    return !run.finished && run.now < limitMs;
  }
  return false;
}

function deploy(run, strategy, used, limitMs) {
  for (const kind of strategy.order) {
    const sites = kind === "tower" && strategy.cluster ? clusterTowers : stations[kind];
    for (const target of sites) {
      if (run.finished || run.now >= limitMs || run.economy.cards[kind] === 0) break;
      const key = `${kind}:${target.col},${target.row}`;
      if (used.has(key) || !buildingStance(run, target, limitMs) || run.checkPlacement(kind, target)) continue;
      run.place(kind, target);
      used.add(key);
    }
  }
}

function walkOrDig(run, route, limitMs) {
  let moved = 0;
  for (const target of route) {
    if (run.finished || run.now + 1_500 >= limitMs) break;
    if (!run.map.isWalkable(target)) {
      if (run.map.getDigFailure(run.player.cell, target, run.economy.toolLevel)) break;
      run.mine(target);
    }
    if (run.finished) break;
    run.moveOne(target);
    moved += 1;
  }
  return moved;
}

function buildDetour(run, limitMs, original) {
  if (!run.map.getBuilding(gate) || !run.canMoveTo(mazeTiles[0]) || run.now + 7_000 > limitMs) return null;
  const startingDig = run.miningActions.length;
  run.moveTo(mazeTiles[0]);
  const complete = walkOrDig(run, mazeTiles.slice(1), limitMs) === mazeTiles.length - 1;
  const finishedPath = path(run.map, GENERATED_ENEMY_ENTRY, (position) => sameCell(position, detourAnchor));
  const towers = [...run.map.getBuildings()].filter(({ kind }) => kind === "tower");
  const towerCoverage = (route) => route?.filter((position) => towers.some(({ cell: tower, level }) =>
    Math.hypot(position.col - tower.col, position.row - tower.row)
    <= towerAttributes(run.map.buildingBalance, level, run.map.getBiome(tower)).range)).length ?? null;
  return {
    atMs: run.now, complete, originalSteps: original?.length ?? null, finalSteps: finishedPath?.length ?? null,
    originalCovered: towerCoverage(original), finalCovered: towerCoverage(finishedPath), actualPath: finishedPath,
    digs: run.miningActions.slice(startingDig).map(({ target }) => target),
  };
}

function arrangeRetreat(run) {
  if (run.finished || sameCell(run.player.cell, refuge) || !run.canMoveTo(refuge)) return;
  run.moveTo(refuge);
}

function rebuildFacility(run, limitMs, decisions) {
  if (run.economy.hasTechnology || run.economy.technologyFailure) return;
  for (const target of stations.technology) {
    if (!buildingStance(run, target, limitMs) || run.checkPlacement("technology", target)) continue;
    if (run.economy.buildTechnology(target)) {
      decisions.push({ action: "rebuild-facility", atMs: run.now, from: run.player.cell, target, cost: run.economy.technologyBuildCost });
      return;
    }
  }
}

function research(run, strategy, decisions) {
  if (run.economy.toolLevel === 2 || run.economy.balance < run.economy.researchCost
    + strategy.reserveResearch * run.economy.drawCost || !run.economy.researchTool()) return;
  decisions.push({ action: "research", atMs: run.now, cost: run.economy.researchCost });
}

function advanceTier(run, limitMs, decisions) {
  const start = run.player.cell;
  const route = path(run.map, start, (position) => position.row <= 63, (position) => {
    const { terrain, buildingId, terrainLevel } = run.map.getCell(position);
    return buildingId === null && (terrain === "empty" || (terrain === "dirt" && terrainLevel <= run.economy.toolLevel));
  });
  if (!route) return;
  const moved = walkOrDig(run, route, limitMs);
  if (moved) decisions.push({ action: "tier-travel", atMs: run.now, from: start, to: run.player.cell, steps: moved });
}

function nearbyLegalSlots(run) {
  let possible = 0;
  const { col, row } = run.player.cell;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if ((dx || dy) && !run.checkPlacement("technology", cell(col + dx, row + dy))) possible += 1;
    }
  }
  return possible;
}

function defenseCoverage(run) {
  const { map, simulation } = run;
  const towers = [...map.getBuildings()].filter(({ kind }) => kind === "tower").map(({ cell, level }) => ({
    cell, range: towerAttributes(map.buildingBalance, level, map.getBiome(cell)).range,
  }));
  const accessible = [GENERATED_ENEMY_ENTRY];
  const key = ({ col, row }) => row * map.columns + col;
  const seen = new Set([key(GENERATED_ENEMY_ENTRY)]);
  let uncovered = 0;
  for (const point of accessible) {
    if (!towers.some(({ cell: tower, range }) => Math.hypot(point.col - tower.col, point.row - tower.row) <= range)) {
      uncovered += 1;
    }
    for (const adjacent of map.getWalkableNeighbors(point)) {
      const index = key(adjacent);
      if (seen.has(index)) continue;
      seen.add(index);
      accessible.push(adjacent);
    }
  }
  return {
    reachableFromEntry: accessible.length, uncovered, playerReachableWithoutBreaching: seen.has(key(run.player.cell)),
    remainingEnemies: [...simulation.enemies].map(({ waveId, kind, cell, unreachable }) => ({ waveId, kind, cell, unreachable })),
  };
}

function signature(actions) {
  return createHash("sha256").update(JSON.stringify(actions)).digest("hex");
}

export function runMidgamePaid({ seed, policy, experiment }) {
  const strategy = policies[policy];
  const run = new OpeningRun(seed, "challenge", "w25", experiment);
  const deployed = new Set();
  const decisions = [];
  const retreatHistory = [];
  assert.equal(run.effectiveSeed, seed);
  assert.equal(run.initial.totals.balance, 0);
  assert.equal(run.initial.technologyHp, null);
  assert.ok(Object.values(run.initial.cards).every((count) => count === 0));
  assert.equal(run.initial.toolLevel, 1);
  run.fundFacility(75);
  for (let count = 0; count < strategy.openingDraws && run.now < openingBudgetMs; count += 1) {
    if (!buy(run, openingBudgetMs, strategy)) break;
  }
  const originalPath = strategy.detour
    ? path(run.map, GENERATED_ENEMY_ENTRY, (position) => sameCell(position, detourAnchor)) : null;
  deploy(run, strategy, deployed, strategy.detour ? openingPlacementMs - 8_000 : openingPlacementMs);
  let detour = strategy.detour ? buildDetour(run, openingPlacementMs, originalPath) : null;
  arrangeRetreat(run);
  const prepared = run.now;

  const recovery = [];
  let handledWave = 0;
  while (!run.finished && run.now < horizonMs) {
    if (run.round.phase === "recovering" && run.round.wave > handledWave) {
      handledWave = run.round.wave;
      recovery.push({ wave: handledWave, timeMs: run.now, legalNearbySlots: nearbyLegalSlots(run),
        defenseCoverage: defenseCoverage(run), ...run.economicState() });
      if (handledWave === 10) break;
      const deadline = run.now + run.round.remainingMs - 1_500;
      if (run.player.cell.row < 83 && run.round.stage > 0) arrangeRetreat(run);
      rebuildFacility(run, deadline, decisions);
      research(run, strategy, decisions);
      if (!run.finished && run.round.wave >= 4 && run.economy.toolLevel === 2 && run.round.stage === 0) {
        advanceTier(run, deadline - 7_000, decisions);
        arrangeRetreat(run);
      } else {
        const craftingLimit = Math.min(run.now + 10_000, deadline - 3_000);
        for (let count = 0; count < strategy.recoveryDraws && !run.finished && run.now < craftingLimit; count += 1) {
          if (!buy(run, craftingLimit, strategy)) break;
        }
        deploy(run, strategy, deployed, deadline);
        if (strategy.detour && !detour?.complete) detour = buildDetour(run, deadline, originalPath) ?? detour;
        if (run.player.cell.row > 83) arrangeRetreat(run);
      }
      retreatHistory.push({ wave: handledWave, atMs: run.now, cell: run.player.cell, stage: run.round.stage });
    }
    run.tick();
  }
  const snapshot = run.snapshot();
  const outcomes = snapshot.waves.map(({ atMs, order, playerCell, economy }, index) => {
    const wave = index + 1;
    const combat = snapshot.combat.find(({ waveId }) => waveId === wave);
    const ledger = snapshot.economyHistory.find(({ waveId }) => waveId === wave);
    const end = snapshot.waveEnds.find(({ waveId }) => waveId === wave) ?? null;
    return { wave, atMs, order, playerCell, economy, combat, ledger, end };
  });
  const focusWaves = Object.fromEntries([3, 6, 8, 10].map((wave) => [wave, outcomes.find((item) => item.wave === wave) ?? null]));
  const outcome = run.finished ? run.round.phase : handledWave === 10 ? "held-wave-10" : "time-limit";
  const totals = snapshot.finish.totals;
  const credits = ["productionIncome", "killIncome", "miningIncome"].reduce((sum, key) => sum + toEconomyTenths(totals[key]), 0);
  const charges = ["technologySpend", "researchSpend", "cardSpend"].reduce((sum, key) => sum + toEconomyTenths(totals[key]), 0);
  assert.equal(toEconomyTenths(totals.balance), credits - charges);
  assert.equal(totals.cardsMade, snapshot.draws.filter(({ card }) => card !== null).length);
  return {
    seed, effectiveSeed: run.effectiveSeed, fingerprint: run.fingerprint, policy, experiment,
    outcome, wave: run.round.wave, stage: run.round.stage, elapsedMs: snapshot.elapsedMs,
    start: snapshot.start, finish: snapshot.finish, prepared, initialOre: snapshot.initialStarterDirt,
    facility: snapshot.facility, mining: snapshot.miningActions, draws: snapshot.draws,
    construction: snapshot.construction, detour, recovery, retreatHistory, decisions, waves: outcomes, focusWaves,
    finalLegalNearbySlots: nearbyLegalSlots(run), finalDefenseCoverage: defenseCoverage(run), combatEvents: snapshot.combatEvents,
    matchedOpening: signature({
      facility: snapshot.facility, mining: snapshot.miningActions.filter(({ finishedAtMs }) => finishedAtMs < 60_000),
      draws: snapshot.draws.filter(({ atMs }) => atMs < 60_000),
      construction: snapshot.construction.filter(({ atMs }) => atMs < 60_000),
    }),
  };
}

export function runMidgamePaidMatrix() {
  return {
    fixture: "actual generated levels, zero stock, real inputs and normal Challenge timers",
    rows: MIDGAME_SEEDS.flatMap((seed) => Object.keys(policies).flatMap((policy) =>
      PAID_EXPERIMENTS.map((experiment) => runMidgamePaid({ seed, policy, experiment })))),
  };
}

const command = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (command) console.log(JSON.stringify(runMidgamePaidMatrix(), null, 2));

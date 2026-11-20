import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BUILDING_BALANCE_PROFILES } from "../src/building-balance.ts";
import { DIFFICULTY_PROFILES } from "../src/expedition-difficulty.ts";
import { ECONOMY_PROTOTYPE, toEconomyTenths } from "../src/expedition-economy.ts";
import { GENERATED_GOAL } from "../src/generated-map.ts";
import { OpeningRun } from "./challenge-opening.mjs";

export const BALANCE_SEEDS = Object.freeze([9, 12, 512, 1091, 0, 0xffff_ffff]);
export const BALANCE_STRATEGIES = Object.freeze(["defense-first", "economy-first", "research-first", "wall-only"]);
export const BALANCE_CLOCKS = Object.freeze(["normal", "idle-accelerated"]);
const frameMs = 25;
const pauseMs = 125;
const firstWaveMs = DIFFICULTY_PROFILES.challenge.normal.preparingMs;
const fundingDeadlineMs = 160_000;
const horizonMs = 240_000;
const defenseCard = (kind) => kind === "wall" || kind === "tower";
const cell = (col, row) => ({ col, row });
const refuge = cell(19, 85);
const wallSlots = [
  { from: cell(23, 94), target: cell(24, 94) },
  { from: cell(22, 94), target: cell(23, 94) },
];
const towerSlots = [
  { from: cell(22, 93), target: cell(23, 93) },
  { from: cell(22, 93), target: cell(22, 92) },
];
const producerSlot = { from: cell(19, 92), target: cell(20, 91) };
const replacementSlot = { from: cell(19, 86), target: cell(18, 86) };

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function wait(run, accelerated, condition, limitMs) {
  while (!condition() && !run.finished && run.now < limitMs) run.idleUntil(limitMs, accelerated);
}

function walk(run, target) {
  if (run.finished || !run.canMoveTo(target)) return false;
  run.moveTo(target);
  return !run.finished;
}

function fund(run, cost, deadlineMs) {
  const shortage = toEconomyTenths(cost) - toEconomyTenths(run.economy.balance);
  if (shortage <= 0) return true;
  const miningTarget = toEconomyTenths(run.economy.totals.miningIncome) + shortage;
  run.mineToIncome(miningTarget, pauseMs, deadlineMs);
  return !run.finished && run.economy.balance >= cost;
}

function buy(run, decisions) {
  if (!fund(run, ECONOMY_PROTOTYPE.drawCost, firstWaveMs) || run.now >= firstWaveMs) {
    decisions.push({ action: "craft", atMs: run.now, result: "not-funded-in-preparation" });
    return undefined;
  }
  return run.draw();
}

function place(run, kind, slot, decisions, limitMs = firstWaveMs) {
  if (!slot || run.now >= limitMs || !walk(run, slot.from)) {
    decisions.push({ action: "place", kind, target: slot?.target, atMs: run.now, result: "site-not-reached" });
    return undefined;
  }

  const terrain = run.map.getCell(slot.target)?.terrain;
  if (terrain === "dirt" && run.now + 625 <= limitMs
    && !run.map.getDigFailure(run.player.cell, slot.target, run.economy.toolLevel)) {
    run.mine(slot.target);
  }
  if (run.finished || run.now >= limitMs) return undefined;
  const rejection = run.checkPlacement(kind, slot.target);
  if (rejection) {
    decisions.push({ action: "place", kind, target: slot.target, atMs: run.now, result: rejection });
    return undefined;
  }
  return run.place(kind, slot.target);
}

function prepare(run, strategy, decisions) {
  run.fundFacility(pauseMs);
  if (strategy === "research-first") return;
  if (strategy === "wall-only") {
    for (let attempts = 0; attempts < 10 && !run.finished; attempts += 1) {
      const card = buy(run, decisions);
      if (!card) break;
      if (card === "wall") {
        place(run, "wall", wallSlots[0], decisions);
        break;
      }
    }
    return;
  }
  if (strategy === "economy-first") {
    for (let attempts = 0; attempts < 7 && !run.finished; attempts += 1) {
      const card = buy(run, decisions);
      if (!card) break;
      if (card === "economy") {
        place(run, "economy", producerSlot, decisions);
        break;
      }
    }
    placeFirstDefense(run, decisions, ["wall", "tower"]);
    return;
  }

  const used = { wall: 0, tower: 0 };
  for (let attempts = 0, acquired = 0; attempts < 6 && acquired < 2 && !run.finished; attempts += 1) {
    const card = buy(run, decisions);
    if (!card) break;
    if (!defenseCard(card)) continue;
    acquired += 1;
    if (place(run, card, (card === "wall" ? wallSlots : towerSlots)[used[card]], decisions)) used[card] += 1;
  }
}

function placeFirstDefense(run, decisions, priorities) {
  let kind = priorities.find((item) => run.economy.cards[item] > 0);
  for (let attempts = 0; !kind && attempts < 3 && !run.finished; attempts += 1) {
    const card = buy(run, decisions);
    if (!card) break;
    if (defenseCard(card)) kind = card;
  }
  if (kind) place(run, kind, kind === "wall" ? wallSlots[0] : towerSlots[0], decisions);
}

function research(run, decisions, limitMs) {
  if (!run.economy.hasTechnology || !fund(run, run.economy.researchCost, limitMs) || run.finished) {
    decisions.push({ action: "research", atMs: run.now, result: run.economy.hasTechnology ? "not-funded" : "facility-absent" });
    return null;
  }
  const result = run.economy.researchTool();
  decisions.push({ action: "research", atMs: run.now, cost: run.economy.researchCost,
    result: result ? "acquired" : "rejected" });
  return result ? run.now : null;
}

function replaceFacility(run, decisions) {
  if (run.economy.hasTechnology || run.finished) return;
  const cost = run.economy.technologyBuildCost;
  if (!fund(run, cost, fundingDeadlineMs) || !walk(run, replacementSlot.from)) {
    decisions.push({ action: "replace-facility", atMs: run.now, result: "replacement-not-funded-or-reached" });
    return;
  }
  const rejection = run.checkPlacement("technology", replacementSlot.target);
  const building = rejection ? undefined : run.economy.buildTechnology(replacementSlot.target);
  decisions.push({ action: "replace-facility", atMs: run.now, target: replacementSlot.target,
    result: building ? "built" : rejection ?? "rejected", ...(building ? { cost } : {}) });
}

function diggableRoute(map, start) {
  const key = ({ col, row }) => row * map.columns + col;
  const queue = [{ position: start, parent: null }];
  const seen = new Set([key(start)]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (map.isGoal(current.position)) {
      const route = [];
      for (let node = current; node.parent; node = node.parent) route.push(node.position);
      return route.reverse();
    }
    const { col, row } = current.position;
    for (const target of [cell(col, row - 1), cell(col - 1, row), cell(col + 1, row), cell(col, row + 1)]) {
      if (!map.isInside(target) || seen.has(key(target))) continue;
      const tile = map.getCell(target);
      if (tile.buildingId !== null || (tile.terrain !== "empty" && tile.terrain !== "dirt")) continue;
      seen.add(key(target));
      queue.push({ position: target, parent: current });
    }
  }
  return [];
}

function advanceNorth(run, decisions) {
  if (run.finished || run.economy.toolLevel !== 2) return;
  const route = diggableRoute(run.map, run.player.cell);
  decisions.push({ action: "advance-north", atMs: run.now, target: GENERATED_GOAL, route });
  for (const target of route) {
    if (run.finished || run.now + 1_100 > horizonMs) break;
    if (!run.map.isWalkable(target)) {
      const reason = run.map.getDigFailure(run.player.cell, target, run.economy.toolLevel);
      if (reason) {
        decisions.push({ action: "route-blocked", atMs: run.now, target, result: reason });
        break;
      }
      run.mine(target);
    }
    if (!run.finished) run.moveOne(target);
  }
}

function prepareHash(run, strategy, decisions) {
  return hash({
    seed: run.seed, strategy, pauseMs, facility: run.facility,
    mining: run.miningActions.filter(({ finishedAtMs }) => finishedAtMs < firstWaveMs),
    crafts: run.draws.filter(({ atMs }) => atMs < firstWaveMs),
    structures: run.construction.filter(({ atMs }) => atMs < firstWaveMs).map(({ atMs, kind, from, target }) => ({ atMs, kind, from, target })),
    intentionalActions: decisions.filter(({ atMs }) => atMs < firstWaveMs),
  });
}

function waveRecord(snapshot, wave, index) {
  const waveId = index + 1;
  const events = snapshot.combatEvents.filter((event) => event.waveId === waveId);
  const firstDefenseContact = events.find(({ type }) => type === "wallImpact" || type === "buildingHit") ?? null;
  const firstCombat = events.find(({ type }) => type !== "towerKill") ?? null;
  const wallImpacts = events.filter(({ type }) => type === "wallImpact");
  const closed = snapshot.waveEnds.find((wave) => wave.waveId === waveId);
  const current = snapshot.combat[index];
  return {
    waveId, ...wave,
    settled: closed ?? null,
    combat: current,
    economyPeriod: snapshot.economyHistory.find((record) => record.waveId === waveId),
    firstDefenseContact, firstCombat, wallImpacts,
    wallBreaks: wallImpacts.filter(({ destroyed }) => destroyed),
    constructionsBeforeNextWave: snapshot.construction.filter(({ atMs }) =>
      atMs >= wave.atMs && atMs < (snapshot.waves[index + 1]?.atMs ?? Infinity)),
  };
}

export function replayChallengeBalance({ seed, strategy, balance, clock = "normal" }) {
  assert.ok(BALANCE_STRATEGIES.includes(strategy));
  assert.ok(Object.hasOwn(BUILDING_BALANCE_PROFILES, balance));
  assert.ok(BALANCE_CLOCKS.includes(clock));
  const run = new OpeningRun(seed, "challenge", balance);
  assert.equal(run.effectiveSeed, seed);
  const accelerated = clock === "idle-accelerated";
  const decisions = [];
  prepare(run, strategy, decisions);
  // Hold the original intake choke for the wall-only opening before excavating a second route.
  let researchAtMs = strategy === "wall-only" ? null : research(run, decisions, firstWaveMs);
  if (!run.finished && strategy === "research-first" && researchAtMs !== null) {
    placeFirstDefense(run, decisions, ["wall", "tower"]);
  }
  if (!run.finished && (researchAtMs === null || strategy === "wall-only")) {
    walk(run, refuge);
    wait(run, accelerated, () => run.waveEnds.length > 0, fundingDeadlineMs);
  }
  if (!run.finished && researchAtMs === null) {
    replaceFacility(run, decisions);
    researchAtMs = research(run, decisions, fundingDeadlineMs);
  }
  if (!run.finished) advanceNorth(run, decisions);
  wait(run, accelerated, () => false, horizonMs);
  const openingDigest = prepareHash(run, strategy, decisions);

  const snapshot = run.snapshot();
  const firstDefenseBuilt = snapshot.construction.find(({ kind }) => defenseCard(kind)) ?? null;
  const firstWallBreak = snapshot.combatEvents.find(({ type, destroyed }) => type === "wallImpact" && destroyed) ?? null;
  return {
    ...snapshot, strategy, balance, clock, openingDigest, decisions,
    instructions: { pauseMs, fundingDeadlineMs, horizonMs, prepMs: firstWaveMs },
    firstDefenseBuilt, researchAtMs, firstWallBreak,
    result: run.finished ? snapshot.phase : "horizon",
    horizonReason: run.finished ? null : run.economy.toolLevel < 2 ? "research-not-completed" : "northern-goal-not-reached",
    clockSteps: { ...run.clock },
    waves: snapshot.waves.map((wave, index) => waveRecord(snapshot, wave, index)),
  };
}

export function replayCraftAfterRelocation(clock = "normal") {
  const run = new OpeningRun(1091, "challenge", "w25");
  const facilityCost = run.fundFacility();
  const craftCost = toEconomyTenths(ECONOMY_PROTOTYPE.drawCost);
  const cards = [];
  for (const count of [1, 2]) {
    run.mineToIncome(facilityCost + count * craftCost);
    cards.push(run.draw());
  }
  run.mineToIncome(2 * facilityCost + 4 * craftCost);
  run.moveTo(refuge);
  wait(run, clock === "idle-accelerated", () => !run.economy.hasTechnology, 65_000);
  assert.ok(!run.finished);
  const destroyed = run.combatEvents.find(({ type, buildingKind, destroyed }) =>
    type === "buildingHit" && buildingKind === "technology" && destroyed);
  assert.ok(destroyed, "A real wave must destroy the first facility");

  const beforeDenial = run.economy.totals;
  assert.equal(run.draw(), undefined);
  assert.deepEqual(run.economy.totals, beforeDenial);
  run.moveTo(replacementSlot.from);
  assert.equal(run.checkPlacement("technology", replacementSlot.target), undefined);
  const replacement = run.economy.buildTechnology(replacementSlot.target);
  assert.ok(replacement);
  const rebuiltAtMs = run.now;
  cards.push(run.draw(), run.draw());
  const snapshot = run.snapshot();
  return { ...snapshot, cards, destroyed, replacement, rebuiltAtMs, clock, clockSteps: { ...run.clock } };
}

export function runChallengeBalanceMatrix() {
  const runs = [];
  for (const seed of BALANCE_SEEDS) {
    for (const strategy of BALANCE_STRATEGIES) {
      for (const balance of Object.keys(BUILDING_BALANCE_PROFILES)) {
        for (const clock of BALANCE_CLOCKS) runs.push(replayChallengeBalance({ seed, strategy, balance, clock }));
      }
    }
  }
  return {
    schemaVersion: 1, clockMode: "Normal game timeline; accelerated runner batches only action-free empty combat spans.",
    seeds: BALANCE_SEEDS, strategies: BALANCE_STRATEGIES, balanceProfiles: BUILDING_BALANCE_PROFILES,
    timings: { frameMs, pauseMs, fundingDeadlineMs, horizonMs }, runs,
  };
}

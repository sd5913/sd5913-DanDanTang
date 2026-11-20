import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { towerAttributes } from "../src/building-balance.ts";
import { ECONOMY_PROTOTYPE, toEconomyTenths } from "../src/expedition-economy.ts";
import { GENERATED_ENEMY_ENTRY } from "../src/generated-map.ts";
import { OpeningRun } from "./challenge-opening.mjs";

const seed = 515;
const balance = "w25";
const waveLimit = 3;
const deadlineMs = 300_000;
const cell = (col, row) => ({ col, row });
const layouts = {
  dispersed: [25, 21, 23, 28],
  merged: [25, 26, 27, 28],
};

function coverage(map) {
  const towers = [...map.getBuildings()].filter(({ kind }) => kind === "tower").map((tower) => ({
    site: tower.cell, range: towerAttributes(map.buildingBalance, tower.level, map.getBiome(tower.cell)).range,
  }));
  const open = [GENERATED_ENEMY_ENTRY];
  const key = ({ col, row }) => row * map.columns + col;
  const visited = new Set([key(GENERATED_ENEMY_ENTRY)]);
  let covered = 0;
  for (const site of open) {
    if (towers.some(({ site: tower, range }) => Math.hypot(site.col - tower.col, site.row - tower.row) <= range)) covered += 1;
    for (const next of map.getWalkableNeighbors(site)) {
      const index = key(next);
      if (visited.has(index)) continue;
      visited.add(index);
      open.push(next);
    }
  }
  return { reachableTiles: open.length, coveredTiles: covered, towers };
}

function buildAndDefend(strategy, accelerated) {
  const run = new OpeningRun(seed, "challenge", balance);
  const facilityCost = run.fundFacility();
  const cardCost = toEconomyTenths(ECONOMY_PROTOTYPE.drawCost);
  for (let count = 1; count <= 4; count += 1) {
    assert.ok(run.mineToIncome(facilityCost + count * cardCost));
    assert.equal(run.draw(), "tower");
  }
  run.moveTo(cell(21, 92));
  const deploymentStart = run.now;
  const preparation = {
    start: run.initial, facility: run.facility, mining: run.miningActions.slice(),
    draws: run.draws.slice(), funded: run.economicState(), deploymentStart,
  };

  // Walk the same open row and use fixed placement slots so neither formation starts early.
  const tiles = layouts[strategy].map((col) => cell(col, 91));
  for (const [index, tile] of tiles.entries()) {
    run.moveTo(cell(tile.col, 92));
    const slot = deploymentStart + 1_200 * (index + 1);
    assert.ok(run.now <= slot);
    while (run.now < slot) run.idleUntil(slot, accelerated);
    run.place("tower", tile);
  }
  run.moveTo(run.map.spawn);
  assert.equal(run.round.phase, "preparing");
  const deployment = {
    atMs: run.now, construction: run.construction.slice(),
    synthesisCount: run.construction.filter(({ level }) => level === 2).length,
    releasedTiles: tiles.filter((tile) => run.map.isWalkable(tile)), coverage: coverage(run.map),
    buildings: run.economicState().buildings, cards: run.economy.cards,
  };

  const recoveryDraws = [];
  while (!run.finished && run.waveEnds.length < waveLimit && run.now < deadlineMs) {
    const ended = run.waveEnds.length;
    run.idleUntil(deadlineMs, accelerated);
    if (run.waveEnds.length > ended && run.waveEnds.length < waveLimit) {
      run.draw();
      recoveryDraws.push({ waveId: run.round.wave, ...run.draws.at(-1) });
    }
  }
  assert.ok(run.finished || run.waveEnds.length === waveLimit);

  const snapshot = run.snapshot();
  const waves = snapshot.waves.map(({ order, atMs, economy: opening }, index) => {
    const waveId = index + 1;
    const closing = snapshot.waveEnds.find((wave) => wave.waveId === waveId) ?? snapshot.finish;
    const combat = snapshot.combat.find((wave) => wave.waveId === waveId);
    const ledger = snapshot.economyHistory.find((wave) => wave.waveId === waveId);
    const shots = snapshot.combatEvents.filter((event) => event.waveId === waveId && event.type === "towerShot");
    const damageByEnemy = new Map();
    for (const { enemyId, damage } of shots) {
      assert.ok(Number.isSafeInteger(damage) && damage > 0);
      damageByEnemy.set(enemyId, (damageByEnemy.get(enemyId) ?? 0) + damage);
    }
    assert.ok([...damageByEnemy.values()].every((damage) => damage <= order.enemyHp));
    return {
      waveId, atMs, order, combat, ledger,
      openingCards: opening.cards, closingCards: closing.cards, closingBalance: closing.totals.balance,
      openingTowerLevels: opening.buildings.filter(({ kind }) => kind === "tower").map(({ level }) => level),
      closingTowerLevels: closing.buildings.filter(({ kind }) => kind === "tower").map(({ level }) => level),
      closingPlayerHp: closing.playerHp,
      shots: shots.length,
      appliedTowerDamage: shots.reduce((sum, { damage }) => sum + damage, 0),
      firstTowerShotAtMs: shots[0]?.atMs ?? null, lastTowerShotAtMs: shots.at(-1)?.atMs ?? null,
    };
  });
  return {
    effectiveSeed: snapshot.effectiveSeed, fingerprint: snapshot.fingerprint, preparation, deployment, recoveryDraws,
    outcome: run.finished ? snapshot.phase : "three-waves", elapsedMs: snapshot.elapsedMs, waves, finish: snapshot.finish,
  };
}

export function runChallengeTowerBalance({ accelerated = false } = {}) {
  const dispersed = buildAndDefend("dispersed", accelerated);
  const merged = buildAndDefend("merged", accelerated);
  assert.deepEqual(dispersed.preparation, merged.preparation);
  assert.equal(dispersed.fingerprint, merged.fingerprint);
  assert.deepEqual(dispersed.deployment.construction.map(({ atMs }) => atMs),
    merged.deployment.construction.map(({ atMs }) => atMs));
  assert.equal(dispersed.deployment.atMs, merged.deployment.atMs);
  return { seed, balance, dispersed, merged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runChallengeTowerBalance({ accelerated: process.argv.includes("--accelerated") }), null, 2));
}

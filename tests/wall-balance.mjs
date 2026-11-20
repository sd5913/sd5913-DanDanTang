import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BUILDING_BALANCE_PROFILES } from '../src/building-balance.ts';
import { placementFailure } from '../src/build-placement.ts';
import { DefenseSimulation, sameCell } from '../src/defense-simulation.ts';
import { ECONOMY_PROTOTYPE, ExpeditionEconomy, toEconomyTenths } from '../src/expedition-economy.ts';
import { ExpeditionRound } from '../src/expedition-round.ts';
import { ExplorationFog } from '../src/fog.ts';
import { MiningSession } from '../src/mining.ts';
import { cellCenter, Player } from '../src/player.ts';
import { TerrainMap } from '../src/terrain.ts';
import { WaveEconomyHistory } from '../src/wave-economy-history.ts';

const seed = 7;
const stepMs = 25;
const cell = (col, localRow) => ({ col, row: localRow + 64 });
const key = ({ col, row }) => row * 24 + col;
const entry = cell(20, 7);
const goal = cell(2, 24);
const spawn = cell(4, 23);
const assembly = cell(2, 25);
const wallCell = cell(8, 7);
const bypassCell = cell(7, 16);
const technologyCell = cell(3, 23);

const strategies = {
  'wall-only': { draws: ['wall'] },
  'wall-and-tower': { draws: ['wall', 'tower'], support: 'tower' },
  'wall-and-producer': { draws: ['wall', 'tower', 'economy'], support: 'economy' },
  'long-wall': { draws: ['wall'], long: true },
  'long-bypass': { draws: ['wall'], long: true, bypass: true },
};

function controlledLayout({ long, bypass }) {
  const rows = Array.from({ length: 96 }, () => Array(24).fill('#'));

  function rectangle(minCol, minRow, maxCol, maxRow, marker = '.') {
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) rows[row + 64][col] = marker;
    }
  }

  rectangle(2, 20, 6, 26);
  rectangle(2, 27, 13, 30, '+');
  rectangle(6, 7, 6, 20);
  rectangle(7, 8, 7, 8);
  if (long) {
    rectangle(6, 7, 9, 7);
    rectangle(9, 7, 9, 16);
    rectangle(9, 16, 20, 16);
    rectangle(20, 7, 20, 16);
    if (bypass) rectangle(6, 16, 9, 16);
  } else {
    rectangle(6, 7, 20, 7);
  }
  rows[spawn.row][spawn.col] = 'S';
  rows[goal.row][goal.col] = 'G';
  return rows.map((row) => row.join(''));
}

function search(map, start) {
  const queue = [{ cell: start }];
  const visited = new Map([[key(start), queue[0]]]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const neighbor of map.getWalkableNeighbors(current.cell)) {
      if (visited.has(key(neighbor))) continue;
      const item = { cell: neighbor, previous: current };
      visited.set(key(neighbor), item);
      queue.push(item);
    }
  }
  return { queue, visited };
}

function pathTo(node) {
  const route = [];
  for (let current = node; current?.previous; current = current.previous) route.push(current.cell);
  return route.reverse();
}

export function replayWallBalance(buildingBalance, strategy) {
  const rules = strategies[strategy];
  assert.ok(rules);
  const map = new TerrainMap(controlledLayout(rules), { buildingBalance });
  const economy = new ExpeditionEconomy(map, seed, undefined, 'challenge');
  const round = new ExpeditionRound(false, 'challenge');
  const history = new WaveEconomyHistory(economy.totals);
  const player = new Player(spawn);
  const fog = new ExplorationFog(map.columns, map.rows);
  const mining = new MiningSession(map);
  const actions = [];
  const impacts = [];
  const bypasses = new Map();
  const losses = [];
  const waves = [];
  let firstContactAtMs = null;
  let now = 0;

  const simulation = new DefenseSimulation(map, entry, goal, (event, metadata) => {
    history.creditKill(metadata.waveId, economy.handleEvent(event));
    const stamp = { atMs: metadata.timeMs, waveId: metadata.waveId, enemyId: event.enemyId };
    if (event.type === 'wallImpact') {
      impacts.push({ ...stamp, wallId: event.wallId, damage: event.damage, hp: event.hp, destroyed: event.destroyed });
      if (event.destroyed) losses.push({ ...stamp, kind: 'wall', cell: metadata.cell });
    }
    if (event.type === 'buildingHit' && event.destroyed) {
      losses.push({ ...stamp, kind: event.buildingKind, cell: event.cell });
    }
    if (event.type === 'wallImpact' || event.type === 'buildingHit' || event.type === 'playerHit') {
      firstContactAtMs ??= metadata.timeMs;
    }
    if (event.type === 'playerHit') {
      const before = round.playerHp;
      round.hitPlayer(event.damage);
      simulation.recordPlayerDamage(metadata.waveId, before - round.playerHp, metadata.timeMs);
      if (round.phase === 'lost') simulation.clearBattle();
    }
  }, true);

  function wallHp() {
    return map.getBuilding(wallCell)?.hp ?? 0;
  }

  function boundary() {
    return { atMs: now, wallHp: wallHp(), playerHp: round.playerHp,
      population: simulation.spawnCounts, economy: economy.totals, cards: economy.cards };
  }

  function tick(move) {
    assert.notEqual(round.phase, 'lost');
    now += stepMs;
    if (move) player.move(move.col, move.row, stepMs, map);
    const phase = round.phase;
    const { spawned, removed, pending } = simulation.spawnCounts;
    const active = spawned - removed;
    const order = round.update(stepMs, player.cell.row, active, pending);
    if (order) {
      const waveId = round.wave;
      waves.push({ waveId, order, opening: boundary() });
      history.startWave(waveId, economy.totals);
      assert.equal(simulation.requestWave(waveId, order), order.count);
    }
    if (phase === 'attacking' && round.phase === 'recovering') {
      simulation.finishAttackPhase(round.wave, active === 0 && pending === 0 ? 'resolved' : 'time-limit');
      waves.at(-1).attackEnd = boundary();
    }
    economy.advance(stepMs);
    simulation.step(stepMs, player);
    if (rules.bypass && wallHp() > 0) {
      for (const enemy of simulation.enemies) {
        if (sameCell(enemy.cell, bypassCell) && !bypasses.has(enemy.id)) {
          bypasses.set(enemy.id, { enemyId: enemy.id, waveId: enemy.waveId, atMs: now, cell: bypassCell });
        }
      }
    }
    if (round.phase === 'lost') waves.at(-1).attackEnd ??= boundary();
  }

  function walk(target) {
    const finish = search(map, player.cell).visited.get(key(target));
    assert.ok(finish, 'The scripted building or excavation stance must be reachable');
    for (const next of pathTo(finish)) {
      const direction = { col: next.col - player.cell.col, row: next.row - player.cell.row };
      for (let elapsed = 0; elapsed < 200; elapsed += stepMs) tick(direction);
      assert.deepEqual(player.position, cellCenter(next));
    }
    actions.push({ kind: 'walk', target, atMs: now });
  }

  function mineOne() {
    let work;
    for (const { cell: from } of search(map, player.cell).queue) {
      for (const [dc, dr] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
        const target = { col: from.col + dc, row: from.row + dr };
        if (target.row >= 91 && map.getDigFailure(from, target, 1) === undefined) {
          work = { from, target };
          break;
        }
      }
      if (work) break;
    }
    assert.ok(work, 'Controlled rear ore pocket must finance this strategy');
    walk(work.from);
    const { from, target } = work;
    const started = now;
    function credit(strike) {
      if (strike?.result.effective) economy.creditMiningDamage(strike.result.damage);
    }
    credit(mining.begin(from, target, now));
    while (!map.isWalkable(target)) {
      assert.ok(now - started < 1_000);
      tick();
      credit(mining.update(from, now, target));
    }
    mining.stop();
    actions.push({ kind: 'mine', target, from, atMs: now });
  }

  function earn(price) {
    while (toEconomyTenths(economy.balance) < toEconomyTenths(price)) mineOne();
  }

  function place(kind, target, stance) {
    walk(stance);
    fog.reveal(player.cell, []);
    const failure = placementFailure(map, target, {
      playerPosition: player.position,
      roundEnded: round.phase === 'lost',
      visible: fog.visibility(target) === 'visible',
      reserved: sameCell(target, entry) || sameCell(target, goal),
      enemyOccupies: (position) => simulation.occupies(position),
      cardCount: kind === 'technology' ? undefined : economy.cards[kind],
    });
    assert.equal(failure, undefined, 'Scripted construction must use the real legal placement rules');
    const building = kind === 'technology' ? economy.buildTechnology(target) : economy.placeCard(kind, target);
    assert.ok(building);
    actions.push({ kind: 'place', building: kind, target, atMs: now });
    return building;
  }

  assert.equal(economy.balance, 0);
  assert.deepEqual(economy.cards, { wall: 0, tower: 0, economy: 0 });
  assert.equal(economy.hasTechnology, false);
  earn(economy.technologyBuildCost);
  place('technology', technologyCell, spawn);
  for (const expected of rules.draws) {
    earn(ECONOMY_PROTOTYPE.drawCost);
    const card = economy.drawCard();
    assert.equal(card, expected);
    actions.push({ kind: 'draw', card, atMs: now });
  }
  const wall = place('wall', wallCell, cell(7, 7));
  if (rules.support === 'tower') place('tower', cell(7, 8), cell(6, 8));
  if (rules.support === 'economy') place('economy', cell(4, 22), spawn);
  walk(assembly);
  assert.ok(now < 60_000, 'All paid construction must finish before the first normal wave');
  const opening = boundary();
  const inputHash = createHash('sha256').update(JSON.stringify(actions)).digest('hex');

  while (round.phase !== 'lost' && !(round.wave === 3 && round.phase === 'recovering')) {
    assert.ok(now < 240_000, 'The early-wave observation must have a finite endpoint');
    tick();
  }
  const final = boundary();
  const waveEconomy = history.snapshot(economy.totals);
  return {
    seed, buildingBalance, strategy, inputHash, setupFinishedAtMs: opening.atMs,
    initialWallHp: wall.maxHp, firstContactAtMs, firstBreach: impacts.find(({ destroyed }) => destroyed) ?? null,
    opening, final, outcome: round.phase === 'lost' ? 'lost' : 'survived-three-waves',
    waves: waves.map((wave) => ({ ...wave, combat: simulation.getWaveMetrics(wave.waveId),
      economy: waveEconomy.find((period) => period.waveId === wave.waveId) })),
    impacts, bypasses: [...bypasses.values()], losses,
  };
}

export function runWallBalanceExperiment() {
  return Object.keys(BUILDING_BALANCE_PROFILES)
    .flatMap((profile) => Object.keys(strategies).map((strategy) => replayWallBalance(profile, strategy)));
}

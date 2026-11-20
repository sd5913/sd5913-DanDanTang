import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BIOME_PROTOTYPE } from "../src/biome-effects.ts";
import { DefenseSimulation } from "../src/defense-simulation.ts";
import { generateExpeditionBiomes } from "../src/expedition-biomes.ts";
import { ECONOMY_PROTOTYPE, ExpeditionEconomy } from "../src/expedition-economy.ts";
import { ExpeditionRound } from "../src/expedition-round.ts";
import { addExpeditionApproach, addExpeditionTiers, PLAY_GENERATOR_VERSION } from "../src/expedition-terrain.ts";
import { DEFAULT_MAP_SEED, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, generateExpeditionWorld } from "../src/generated-map.ts";
import { MINING_CONFIG } from "../src/mining-config.ts";
import { cellCenter, Player } from "../src/player.ts";
import { TerrainMap } from "../src/terrain.ts";

const seed = 12;
const cell = (col, row) => ({ col, row });

function createPlayModel(mapSeed = seed) {
  const world = generateExpeditionWorld(mapSeed);
  const landscape = generateExpeditionBiomes(world.layout, world.effectiveSeed);
  const layout = addExpeditionApproach(addExpeditionTiers(landscape.layout));
  const map = new TerrainMap(layout, { biomes: landscape.biomes });
  const economy = new ExpeditionEconomy(map, world.effectiveSeed);
  const player = new Player(map.spawn);
  return { world, map, economy, player };
}

function travelOneCell({ map, economy, player }, target, allowDigging = false) {
  const from = player.cell;
  const dx = target.col - from.col;
  const dy = target.row - from.row;
  assert.equal(Math.abs(dx) + Math.abs(dy), 1, "test path must stay orthogonally adjacent");
  if (!map.isWalkable(target)) {
    assert.ok(allowDigging, `unexpected blocked cell (${target.col}, ${target.row})`);
    const terrain = map.getCell(target);
    assert.equal(terrain.terrain, "dirt");
    const hits = Math.ceil(terrain.hp / MINING_CONFIG.damage);
    for (let hit = 0; hit < hits; hit += 1) {
      assert.equal(map.applyDigDamage(from, target, MINING_CONFIG.damage, economy.toolLevel).effective, true);
    }
    assert.ok(map.isWalkable(target));
  }

  const center = cellCenter(target);
  for (let step = 0; step < 30; step += 1) {
    if (Math.abs(player.position.x - center.x) <= 2 && Math.abs(player.position.y - center.y) <= 2) break;
    player.move(dx, dy, 10, map);
  }
  assert.deepEqual(player.cell, target);
  assert.ok(Math.abs(player.position.x - center.x) <= 2 && Math.abs(player.position.y - center.y) <= 2,
    "player collision box must fit inside the destination before turning");
}

function travelLine(game, target, allowDigging = false) {
  const { col, row } = game.player.cell;
  const dx = Math.sign(target.col - col);
  const dy = Math.sign(target.row - row);
  assert.ok(dx === 0 || dy === 0);
  const steps = Math.abs(target.col - col) + Math.abs(target.row - row);
  for (let step = 1; step <= steps; step += 1) {
    travelOneCell(game, cell(col + dx * step, row + dy * step), allowDigging);
  }
}

function reachableFromSpawn(map, includeDirt) {
  const key = ({ col, row }) => row * map.columns + col;
  const positions = [map.spawn];
  const seen = new Set([key(map.spawn)]);
  for (const { col, row } of positions) {
    for (const next of [cell(col + 1, row), cell(col - 1, row), cell(col, row + 1), cell(col, row - 1)]) {
      const terrain = map.getCell(next);
      if (!terrain || terrain.buildingId !== null || seen.has(key(next))) continue;
      if (terrain.terrain !== "empty" && !(includeDirt && terrain.terrain === "dirt")) continue;
      seen.add(key(next));
      positions.push(next);
    }
  }
  return positions;
}

test("66 seeded play maps connect the southern approach at startup and still require northward excavation", () => {
  const seeds = [...Array.from({ length: 64 }, (_, value) => value), DEFAULT_MAP_SEED, 0xffff_ffff];
  for (const mapSeed of seeds) {
    const game = createPlayModel(mapSeed);
    const { map } = game;
    const walk = reachableFromSpawn(map, false);
    assert.ok(walk.some(({ col, row }) => col === GENERATED_ENEMY_ENTRY.col && row === GENERATED_ENEMY_ENTRY.row),
      `entry must connect through the open southern approach in seed ${mapSeed}`);
    assert.ok(!walk.some((position) => map.isGoal(position)), `seed ${mapSeed} must still require digging`);
    assert.ok(reachableFromSpawn(map, true).some((position) => map.isGoal(position)),
      `seed ${mapSeed} must still have a diggable route to the goal`);

    if (mapSeed === 0 || mapSeed === 0xffff_ffff) {
      travelLine(game, cell(21, 92));
      travelLine(game, cell(21, 94));
      travelLine(game, GENERATED_ENEMY_ENTRY);
    }
  }
});

test("seed 12 play terrain accepts an across-biome synthesis using the oldest plain producer's real timer", () => {
  const game = createPlayModel();
  const { map, economy } = game;
  const anchor = cell(19, 77);
  const ordinary = [78, 79, 80].map((row) => cell(19, row));
  assert.deepEqual([anchor, ...ordinary].map((position) => map.getBiome(position)), ["plain", "ordinary", "ordinary", "ordinary"]);
  assert.ok(ordinary.every((position) => map.getCell(position).terrain === "dirt"));
  travelLine(game, anchor, true);
  travelLine(game, cell(19, 81));
  assert.equal(economy.toolLevel, 1);

  const producer = economy.placeCard("economy", anchor);
  assert.ok(producer);
  assert.equal(economy.cards.economy, 0);
  const interval = BIOME_PROTOTYPE.plainProductionMs;
  for (let draw = 0; economy.cards.economy < ordinary.length && draw < 24; draw += 1) {
    if (economy.balance < ECONOMY_PROTOTYPE.drawCost) economy.advance(interval * ECONOMY_PROTOTYPE.drawCost);
    assert.ok(economy.drawCard(), "the anchor's real production funds manufacturing");
  }
  assert.equal(economy.cards.economy, ordinary.length);

  economy.advance(interval - 1);
  const before = economy.balance;
  for (const [i, position] of ordinary.entries()) {
    const result = economy.placeCard("economy", position);
    assert.ok(result);
    if (i === 2) {
      assert.deepEqual(result, { ...producer, level: 2 });
      assert.equal(result.cell, producer.cell);
      assert.equal(map.getBiome(result.cell), "plain");
    }
  }
  assert.equal(economy.cards.economy, 0);
  assert.ok(ordinary.every((position) => map.isWalkable(position)));
  assert.equal([...map.getBuildings()].filter((building) => building.kind === "economy").length, 1);
  economy.advance(1);
  assert.equal(economy.balance, before + ECONOMY_PROTOTYPE.productionAmount, "the retained partial plain timer pays at 3,000 ms");
  economy.advance(interval - 1);
  assert.equal(economy.balance, before + ECONOMY_PROTOTYPE.productionAmount);
  economy.advance(1);
  assert.equal(economy.balance, before + 2 * ECONOMY_PROTOTYPE.productionAmount, "the upgraded producer still uses the plain interval");
});

function terrainSignature(map) {
  const digest = createHash("sha256");
  for (let row = 0; row < map.rows; row += 1) {
    for (let col = 0; col < map.columns; col += 1) {
      const position = cell(col, row);
      const { terrain, terrainLevel, hp, maxHp } = map.getCell(position);
      digest.update(`${terrain}/${terrainLevel}/${hp}/${maxHp}/${map.getBiome(position)}\n`);
    }
  }
  return digest.digest("hex");
}

function createReplay() {
  const game = createPlayModel();
  const round = new ExpeditionRound(true);
  const events = [];
  const simulation = new DefenseSimulation(game.map, GENERATED_ENEMY_ENTRY, GENERATED_GOAL, (event) => {
    events.push(event.type);
    game.economy.handleEvent(event);
    if (event.type === "playerHit") round.hitPlayer(event.damage);
  }, true);
  return { ...game, round, simulation, events };
}

function snapshot({ world, map, economy, player, round, simulation }, manufactured) {
  return {
    seed: [world.requestedSeed, world.effectiveSeed, PLAY_GENERATOR_VERSION],
    terrain: terrainSignature(map),
    player: player.cell,
    buildings: [...map.getBuildings()].map(({ kind, cell, level, hp, maxHp }) => ({ kind, cell, level, hp, maxHp })),
    economy: { balance: economy.balance, cards: economy.cards, tool: economy.toolLevel, manufactured },
    round: { phase: round.phase, wave: round.wave, stage: round.stage, pressure: round.pressure,
      remainingMs: round.remainingMs, playerHp: round.playerHp },
    spawn: simulation.spawnCounts,
    counters: { ...simulation.counters },
  };
}

function executeReplay(game) {
  const { map, economy, player, round, simulation, events } = game;
  assert.ok(economy.placeCard("economy", cell(18, 92)));
  travelLine(game, cell(21, 92));
  travelLine(game, cell(21, 94));
  travelLine(game, cell(27, 94));
  const towerCell = cell(27, 93);
  assert.equal(map.getCell(towerCell).terrain, "dirt");
  travelOneCell(game, towerCell, true);
  travelOneCell(game, cell(27, 94));
  travelLine(game, cell(23, 94));
  assert.ok(economy.placeCard("tower", towerCell));

  for (let elapsed = 0; elapsed < 5_200; elapsed += 50) {
    const active = [...simulation.enemies].length;
    const order = round.update(50, player.cell.row, active, simulation.spawnCounts.pending);
    if (order) simulation.requestSpawn(order.count, order.wallDamage, { hp: order.enemyHp, contactDamage: order.contactDamage });
    economy.advance(50);
    simulation.step(50, player.cell);
  }
  assert.equal(round.wave, 1);
  assert.equal(round.phase, "recovering");
  assert.equal(simulation.spawnCounts.spawned, 3);
  assert.equal(simulation.counters.towerKills, 3);
  assert.equal(round.playerHp, 4);
  const manufactured = economy.drawCard();
  assert.ok(manufactured);
  assert.ok(economy.researchTool());

  travelLine(game, cell(21, 94));
  travelLine(game, cell(21, 92));
  travelLine(game, cell(19, 92));
  travelLine(game, cell(19, 63), true);
  assert.ok(map.isWalkable(cell(19, 63)));
  round.update(1, player.cell.row, 0, 0);
  assert.equal(round.stage, 1);
  return { snapshot: snapshot(game, manufactured), events: [...events] };
}

test("the same seed replays generated terrain, trades, research, and a real wave after a round reset", () => {
  const fresh = createReplay();
  const initial = snapshot(fresh);
  const first = executeReplay(fresh);
  assert.notEqual(first.snapshot.terrain, initial.terrain);

  fresh.map.reset();
  fresh.player.reset(fresh.map.spawn);
  fresh.economy.reset();
  fresh.simulation.reset();
  fresh.round.reset();
  fresh.events.length = 0;
  assert.deepEqual(snapshot(fresh), initial);
  assert.deepEqual(executeReplay(fresh), first);
  assert.deepEqual(executeReplay(createReplay()), first);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAYER_HALF_SIZE, TILE_SIZE, Player, cellCenter, worldToCell } from '../src/player.ts';

function mapWithWalls(walls = []) {
  return {
    isWalkable({ col, row }) {
      return col >= 0 && col < 5 && row >= 0 && row < 5
        && !walls.some((wall) => wall.col === col && wall.row === row);
    },
  };
}

function holdDirection(player, horizontal, vertical, map, frames = 30) {
  for (let frame = 0; frame < frames; frame += 1) {
    player.move(horizontal, vertical, 50, map);
  }
}

test('world coordinates use half-open cells, including outside the map', () => {
  assert.deepEqual(worldToCell(TILE_SIZE, TILE_SIZE - 0.1), { col: 1, row: 0 });
  assert.deepEqual(worldToCell(-0.1, 0), { col: -1, row: 0 });
  const cell = { col: 3, row: 4 };
  const { x, y } = cellCenter(cell);
  assert.deepEqual(worldToCell(x, y), cell);
});

test('movement is continuous and diagonals have the same speed as cardinal movement', () => {
  const spawn = { col: 1, row: 1 };
  const origin = cellCenter(spawn);
  const map = mapWithWalls();
  const cardinal = new Player(spawn);
  const diagonal = new Player(spawn);
  cardinal.move(1, 0, 16, map);
  diagonal.move(1, -1, 16, map);

  const distance = cardinal.position.x - origin.x;
  assert.ok(distance > 0 && distance < TILE_SIZE);
  assert.equal(cardinal.position.y, origin.y);
  assert.ok(diagonal.position.x > origin.x && diagonal.position.y < origin.y);
  assert.ok(Math.abs(Math.hypot(diagonal.position.x - origin.x, diagonal.position.y - origin.y) - distance) < 1e-9);
});

test('map bounds block the entire player body on all sides', () => {
  const player = new Player({ col: 2, row: 2 });
  const map = mapWithWalls();
  const farEdge = 5 * TILE_SIZE - PLAYER_HALF_SIZE;

  holdDirection(player, -1, 0, map);
  assert.equal(player.position.x, PLAYER_HALF_SIZE);
  holdDirection(player, 0, -1, map);
  assert.equal(player.position.y, PLAYER_HALF_SIZE);
  holdDirection(player, 1, 0, map);
  assert.equal(player.position.x, farEdge);
  holdDirection(player, 0, 1, map);
  assert.equal(player.position.y, farEdge);
});

test('the player slides along a wall and can pass its corner at exact edge contact', () => {
  const player = new Player({ col: 1, row: 2 });
  const map = mapWithWalls([{ col: 2, row: 2 }]);
  const wallEdge = 2 * TILE_SIZE - PLAYER_HALF_SIZE;

  holdDirection(player, 1, 0, map, 10);
  assert.equal(player.position.x, wallEdge);
  holdDirection(player, 0, -1, map, 2);
  assert.equal(player.position.y, 2 * TILE_SIZE);
  player.move(1, -1, 50, map);
  assert.equal(player.position.x, wallEdge);
  assert.ok(player.position.y < 2 * TILE_SIZE);

  player.reset({ col: 1, row: 2 });
  holdDirection(player, 1, 0, map, 1);
  // Reach the exact north edge of the wall with the bottom of the player's body.
  holdDirection(player, 0, -1, map, 3);
  player.move(0, -1, 1_000 / 120, map);
  assert.equal(player.position.y + PLAYER_HALF_SIZE, 2 * TILE_SIZE);
  holdDirection(player, 1, 0, map, 2);
  assert.deepEqual(player.cell, { col: 2, row: 1 });
});

test('diagonal movement cannot slip between two solid cells at a corner', () => {
  const player = new Player({ col: 1, row: 1 });
  const map = mapWithWalls([{ col: 2, row: 1 }, { col: 1, row: 2 }]);
  const wallEdge = 2 * TILE_SIZE - PLAYER_HALF_SIZE;

  holdDirection(player, 1, 1, map);
  assert.deepEqual(player.position, { x: wallEdge, y: wallEdge });
  assert.deepEqual(player.cell, { col: 1, row: 1 });
});

test('a long frame cannot cross a wall and reopening its tile affects movement immediately', () => {
  const spawn = { col: 1, row: 1 };
  const player = new Player(spawn);
  const walls = [{ col: 2, row: 1 }];
  const map = mapWithWalls(walls);

  player.move(1, 0, 10_000, map);
  assert.equal(player.position.x, 2 * TILE_SIZE - PLAYER_HALF_SIZE);
  assert.deepEqual(player.cell, spawn);

  walls.pop();
  player.move(1, 0, 50, map);
  assert.ok(player.position.x + PLAYER_HALF_SIZE > 2 * TILE_SIZE);
  player.move(1, 0, 50, map);
  assert.deepEqual(player.cell, { col: 2, row: 1 });

  player.reset(spawn);
  assert.deepEqual(player.position, cellCenter(spawn));
  assert.deepEqual(player.cell, spawn);
});

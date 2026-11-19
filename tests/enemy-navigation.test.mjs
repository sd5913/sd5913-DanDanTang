import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnemyNavigation } from '../src/enemy-navigation.ts';
import { LONG_MAP_LAYOUT } from '../src/long-map.ts';
import { TerrainMap } from '../src/terrain.ts';

function layout(rows) {
  return {
    columns: rows[0].length,
    rows: rows.length,
    revision: 0,
    isWalkable({ col, row }) {
      return ['.', 'S', 'T'].includes(rows[row]?.[col]);
    },
    getBuilding({ col, row }) {
      const marker = rows[row]?.[col];
      if (marker === 'W') return { kind: 'wall', id: `wall-${col},${row}` };
      if (marker === 'B') return { kind: 'tower', id: `tower-${col},${row}` };
      return undefined;
    },
  };
}

function follow(nav, start, target, limit = 40) {
  const steps = [];
  let cell = start;
  for (let count = 0; count < limit; count += 1) {
    const action = nav.next(cell, target);
    if (action.kind !== 'move') return { steps, action };
    assert.equal(Math.abs(cell.col - action.cell.col) + Math.abs(cell.row - action.cell.row), 1);
    assert.notDeepEqual(action.cell, target);
    steps.push(action.cell);
    cell = action.cell;
  }
  assert.fail('Route did not reach a terminal action within the fixture');
}

test('AI-02 takes a longer open route before considering a direct wall', () => {
  const map = layout([
    '#########',
    '#.......#',
    '#S..W..T#',
    '#########',
  ]);
  const nav = new EnemyNavigation(map);
  const target = { col: 7, row: 2 };
  const route = follow(nav, { col: 1, row: 2 }, target);
  assert.deepEqual(route.action, { kind: 'arrived' });
  assert.ok(route.steps.some((cell) => cell.row === 1));
  assert.ok(route.steps.every((cell) => map.isWalkable(cell)));
  assert.equal(nav.searchCount, 1, 'Open paths need only one shared field');
  assert.equal(follow(nav, { col: 2, row: 1 }, target).action.kind, 'arrived');
  assert.equal(nav.searchCount, 1);
});

test('AI-03 identifies a wall with a complete route behind it and stops on the approach tile', () => {
  const nav = new EnemyNavigation(layout([
    '#########',
    '#S..W..T#',
    '#########',
  ]));
  const start = { col: 1, row: 1 };
  const target = { col: 7, row: 1 };
  const wall = { col: 4, row: 1 };
  const route = follow(nav, start, target);
  assert.deepEqual(route.steps, [{ col: 2, row: 1 }, { col: 3, row: 1 }]);
  assert.deepEqual(route.action, { kind: 'wall', cell: wall, wallId: 'wall-4,1' });
  assert.equal(nav.searchCount, 2);
  assert.deepEqual(follow(nav, start, target), route);
  assert.equal(nav.searchCount, 2);
});

test('weighted fallback prefers fewer breaches over shorter routes, including an adjacent wall destination', () => {
  const nav = new EnemyNavigation(layout([
    '##########',
    '#...W....#',
    '#S.W.W.#T#',
    '##########',
  ]));
  const route = follow(nav, { col: 1, row: 2 }, { col: 8, row: 2 });
  assert.deepEqual(route.action, { kind: 'wall', cell: { col: 4, row: 1 }, wallId: 'wall-4,1' });

  const adjacent = new EnemyNavigation(layout(['#S.WT#']));
  assert.deepEqual(follow(adjacent, { col: 1, row: 0 }, { col: 4, row: 0 }).action, {
    kind: 'wall', cell: { col: 3, row: 0 }, wallId: 'wall-3,0',
  });
});

test('AI-05 refuses walls whose removal would still leave rock, dirt, or a tower blocking access', () => {
  for (const obstacle of ['#', 'D', 'B']) {
    const nav = new EnemyNavigation(layout([`#S.W${obstacle}.T#`]));
    const start = { col: 1, row: 0 };
    const target = { col: 6, row: 0 };
    for (let enemy = 0; enemy < 250; enemy += 1) {
      assert.deepEqual(nav.next(start, target), { kind: 'unreachable' });
    }
    assert.equal(nav.searchCount, 2, 'Unreachable results are shared across units');
  }
});

test('AI-01 and AI-06 update routes across a chunk seam only when topology changes', () => {
  const map = new TerrainMap(LONG_MAP_LAYOUT);
  const nav = new EnemyNavigation(map);
  const start = { col: 11, row: 64 };
  const target = { col: 11, row: 60 };
  const seam = { col: 11, row: 63 };
  assert.equal(nav.next(start, target).kind, 'unreachable');
  const initialSearches = nav.searchCount;

  assert.equal(map.applyDigDamage(start, seam, 1).cleared, false);
  assert.equal(nav.next(start, target).kind, 'unreachable');
  assert.equal(nav.searchCount, initialSearches);

  assert.equal(map.applyDigDamage(start, seam, 100).cleared, true);
  assert.deepEqual(nav.next(start, target), { kind: 'move', cell: seam });
  const route = follow(nav, start, target);
  assert.deepEqual(route.steps, [seam, { col: 11, row: 62 }, { col: 11, row: 61 }]);
  assert.deepEqual(route.action, { kind: 'arrived' });
  assert.equal(nav.searchCount, initialSearches + 1);

  const wall = map.placeBuilding('wall', seam, 2);
  assert.ok(wall);
  assert.deepEqual(nav.next(start, target), { kind: 'wall', cell: seam, wallId: wall.id });
  const blockedSearches = nav.searchCount;
  assert.equal(map.impactWall(seam, wall.id, 1).destroyed, false);
  assert.deepEqual(nav.next(start, target), { kind: 'wall', cell: seam, wallId: wall.id });
  assert.equal(nav.searchCount, blockedSearches);

  assert.equal(map.impactWall(seam, wall.id, 1).destroyed, true);
  assert.deepEqual(nav.next(start, target), { kind: 'move', cell: seam });
  const replacement = map.placeBuilding('wall', seam);
  assert.ok(replacement);
  assert.notEqual(replacement.id, wall.id);
  assert.deepEqual(nav.next(start, target), { kind: 'wall', cell: seam, wallId: replacement.id });
});

test('AI-06 changes attack positions with a moved objective while bounding cached fields', () => {
  const nav = new EnemyNavigation(layout(['..........']));
  const start = { col: 1, row: 0 };
  const closestTarget = { col: 2, row: 0 };
  assert.deepEqual(nav.next(start, closestTarget), { kind: 'arrived' });
  for (let col = 3; col <= 6; col += 1) {
    const target = { col, row: 0 };
    assert.deepEqual(nav.next(start, target), { kind: 'move', cell: { col: 2, row: 0 } });
  }
  assert.equal(nav.searchCount, 5);
  assert.deepEqual(nav.next(start, closestTarget), { kind: 'arrived' });
  assert.equal(nav.searchCount, 6, 'The oldest target field was evicted');
  assert.deepEqual(nav.next({ col: -1, row: 0 }, closestTarget), { kind: 'unreachable' });
  assert.deepEqual(nav.next(start, { col: 10, row: 0 }), { kind: 'unreachable' });
  assert.equal(nav.searchCount, 6);
});

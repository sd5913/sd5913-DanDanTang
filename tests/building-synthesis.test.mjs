import assert from "node:assert/strict";
import test from "node:test";
import { BUILDING_SYNTHESIS_CONFIG, BuildingStore } from "../src/buildings.ts";

const shapeRows = [
  ["####"], ["#", "#", "#", "#"],
  ["##", "##"],
  ["###", ".#."], [".#.", "###"], ["#.", "##", "#."], [".#", "##", ".#"],
  ["#.", "#.", "##"], ["###", "#.."], ["##", ".#", ".#"], ["..#", "###"],
  [".#", ".#", "##"], ["###", "..#"], ["##", "#.", "#."], ["#..", "###"],
  [".##", "##."], ["#.", "##", ".#"],
  ["##.", ".##"], [".#", "##", "#."],
];

function points(shape) {
  return shape.flatMap((line, row) => Array.from(line, (marker, col) =>
    marker === "#" ? { col: col + 5, row: row + 30 } : null).filter(Boolean));
}

function point(col, row) {
  return { col, row };
}

test("all 19 oriented tetrominoes synthesize from every possible placement root", () => {
  assert.equal(BUILDING_SYNTHESIS_CONFIG.autoMerge, true);
  assert.equal(new Set(shapeRows.map((shape) => shape.join("/"))).size, 19);
  for (const shape of shapeRows) {
    for (const root of points(shape)) {
      const store = new BuildingStore(24);
      const group = points(shape).filter((cell) => cell.col !== root.col || cell.row !== root.row);
      const before = [...group, root].map((cell) => store.place("tower", cell, 11));
      const title = `${shape.join("/")} rooted at (${root.col}, ${root.row})`;
      assert.equal([...store.values()].length, 4, `raw placement must stay separate for ${title}`);
      const upgraded = store.synthesize(root);
      assert.deepEqual(upgraded, { ...before[0], level: 2 }, title);
      assert.equal(upgraded.cell, before[0].cell, "incumbent cell identity must be preserved");
      assert.deepEqual([...store.values()], [upgraded], title);
      for (const { cell } of before.slice(1)) assert.equal(store.get(cell), undefined, title);
    }
  }
});

test("synthesis compares every rooted candidate by its sorted sequence of build orders", () => {
  const store = new BuildingStore(24);
  const west = store.place("wall", point(7, 8), 4);
  const south = store.place("wall", point(8, 9), 5);
  const east = store.place("wall", point(9, 8), 6);
  const north = store.place("wall", point(8, 7), 7);
  const root = store.place("wall", point(8, 8), 8);
  const upgraded = store.synthesize(root.cell);
  assert.deepEqual(upgraded, { ...west, level: 2 });
  assert.equal(store.get(north.cell), north);
  for (const { cell } of [south, east, root]) assert.equal(store.get(cell), undefined);
  assert.deepEqual([...store.values()], [upgraded, north]);
});

test("only an orthogonally connected same-kind level-1 group containing the root can synthesize", () => {
  const diagonal = new BuildingStore(24);
  const diagonalCells = [1, 2, 3, 4].map((x) => diagonal.place("wall", point(x, x), 5));
  assert.equal(diagonal.synthesize(diagonalCells[3].cell), undefined);
  assert.deepEqual([...diagonal.values()], diagonalCells);

  const mixed = new BuildingStore(24);
  const mixedCells = [1, 2, 3, 4].map((x) => mixed.place(x === 4 ? "tower" : "wall", point(x, 1), 5));
  assert.equal(mixed.synthesize(mixedCells[3].cell), undefined);
  assert.equal(mixed.synthesize(mixedCells[0].cell), undefined);
  assert.deepEqual([...mixed.values()], mixedCells);

  const levels = new BuildingStore(24);
  for (const x of [1, 2, 3, 4]) levels.place("wall", point(x, 1), 5);
  const upgraded = levels.synthesize(point(4, 1));
  for (const x of [2, 3, 4]) levels.place("wall", point(x, 1), 5);
  const before = [...levels.values()];
  assert.equal(levels.synthesize(upgraded.cell), undefined);
  assert.equal(levels.synthesize(point(4, 1)), undefined);
  assert.deepEqual([...levels.values()], before);
});

test("a rooted request ignores separate groups, and a manual root can be an older building", () => {
  const store = new BuildingStore(24);
  const separate = [1, 2, 3, 4].map((x) => store.place("tower", point(x, 1), 5));
  const root = store.place("tower", point(10, 10), 5);
  assert.equal(store.synthesize(root.cell), undefined);
  assert.deepEqual([...store.values()], [...separate, root]);
  const upgraded = store.synthesize(separate[1].cell);
  assert.deepEqual(upgraded, { ...separate[0], level: 2 });
  assert.deepEqual([...store.values()], [upgraded, root]);
});

test("world columns never wrap across the index boundary during synthesis", () => {
  const store = new BuildingStore(4);
  const before = [point(0, 1), point(1, 1), point(2, 1), point(3, 0)]
    .map((cell) => store.place("wall", cell, 5));
  assert.equal(store.synthesize(point(3, 0)), undefined);
  assert.equal(store.synthesize(point(0, 1)), undefined);
  assert.equal(store.synthesize(point(4, 0)), undefined);
  assert.equal(store.synthesize(point(-1, 1)), undefined);
  assert.deepEqual([...store.values()], before);
});

test("upgraded wall keeps its damage and ID, and released building IDs stay stale on reuse", () => {
  const store = new BuildingStore(24);
  const first = store.place("wall", point(5, 5), 50);
  assert.equal(store.impactWall(first.cell, first.id, 17).hp, 33);
  const consumed = [6, 7, 8].map((x) => store.place("wall", point(x, 5), 80));
  const upgraded = store.synthesize(consumed[2].cell);
  assert.deepEqual(upgraded, { ...first, level: 2, hp: 33 });
  assert.ok(Object.isFrozen(upgraded));
  assert.equal(first.hp, 50);
  assert.equal(upgraded.cell, first.cell);
  assert.equal(store.impactWall(upgraded.cell, first.id, 2).hp, 31);
  assert.equal(store.get(upgraded.cell).level, 2);

  for (const old of consumed) {
    assert.equal(store.get(old.cell), undefined);
    const next = store.place("wall", old.cell, 20);
    assert.notEqual(next.id, old.id);
    assert.ok(next.buildOrder > old.buildOrder);
    assert.equal(store.impactWall(old.cell, old.id, 1), undefined);
    assert.equal(store.remove(old.cell, old.id), undefined);
    assert.equal(store.get(old.cell), next);
  }
});

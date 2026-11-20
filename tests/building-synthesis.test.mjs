import assert from "node:assert/strict";
import test from "node:test";
import { BUILDING_SYNTHESIS_CONFIG, BuildingStore } from "../src/buildings.ts";
import { CHUNK_ROWS, TerrainMap } from "../src/terrain.ts";

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

function emptyLayout() {
  return ["S...........", ...Array(CHUNK_ROWS * 2 - 1).fill("............")];
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

test("MERGE-01–04: every rooted tetromino previews and produces the corresponding tower evolution", () => {
  for (const [index, shape] of shapeRows.entries()) {
    const expected = index === 0 ? { kind: "piercing", axis: "horizontal" }
      : index === 1 ? { kind: "piercing", axis: "vertical" }
      : { kind: "burst" };
    for (const root of points(shape)) {
      const map = new TerrainMap(emptyLayout(), { towerEvolution: true });
      const ordered = [...points(shape).filter((cell) => cell.col !== root.col || cell.row !== root.row), root];
      for (const cell of ordered.slice(0, 3)) {
        assert.equal(map.previewBuildingSynthesis("tower", cell), undefined);
        assert.equal(map.placeBuilding("tower", cell).level, 1);
      }

      const label = `${shape.join("/")} rooted at (${root.col}, ${root.row})`;
      const preview = map.previewBuildingSynthesis("tower", root);
      const incumbent = map.getBuilding(ordered[0]);
      assert.deepEqual(preview, { retained: ordered[0], released: ordered.slice(1), evolution: expected }, label);
      const upgraded = map.placeBuilding("tower", root);
      assert.deepEqual(upgraded, { ...incumbent, level: 2, evolution: expected }, label);
      assert.equal(upgraded.cell, incumbent.cell, label);
      assert.ok(Object.isFrozen(upgraded.evolution), label);
      assert.deepEqual([...map.getBuildings()], [upgraded], label);
      assert.ok(preview.released.every((cell) => map.isWalkable(cell)), label);
    }
  }
});

test("MERGE-05–06: a five-tower group uses its oldest rooted candidate across the chunk seam", () => {
  const west = point(5, 31);
  const nearWest = point(6, 31);
  const east = point(8, 31);
  const south = point(7, 32);
  const root = point(7, 31);
  const cases = [
    { order: [west, nearWest, east, south], evolution: { kind: "piercing", axis: "horizontal" } },
    { order: [south, west, nearWest, east], evolution: { kind: "burst" } },
  ];
  for (const { order, evolution } of cases) {
    const map = new TerrainMap(emptyLayout(), { towerEvolution: true });
    for (const cell of order) assert.equal(map.placeBuilding("tower", cell, 3).level, 1);
    const incumbent = map.getBuilding(order[0]);
    assert.equal(map.damageBuilding(incumbent.cell, incumbent.id, 1).hp, 2);
    const before = [...map.getBuildings()];
    const revision = map.revision;
    const preview = map.previewBuildingSynthesis("tower", root);
    assert.deepEqual(preview, { retained: order[0], released: [...order.slice(1, 3), root], evolution });
    assert.deepEqual([...map.getBuildings()], before);
    assert.equal(map.revision, revision);

    const upgraded = map.placeBuilding("tower", root);
    assert.deepEqual(upgraded, { ...incumbent, hp: 2, level: 2, evolution });
    assert.equal(upgraded.cell, incumbent.cell);
    assert.equal(map.getCell(incumbent.cell).buildingId, incumbent.id);
    assert.equal(map.getBuilding(order[3]), before[3]);
    assert.equal(map.revision, revision + 1);
    assert.ok(preview.released.every((cell) => map.isWalkable(cell)));
    const replacement = map.placeBuilding("tower", root);
    assert.equal(replacement.buildOrder, 6, "preview did not allocate an ID");
  }
});

test("MERGE-07: opt-in tower evolution leaves other kinds and historical synthesis unchanged", () => {
  for (const kind of ["wall", "tower", "economy", "technology"]) {
    const legacy = new TerrainMap(emptyLayout());
    const enabled = new TerrainMap(emptyLayout(), { towerEvolution: true });
    for (const col of [1, 2, 3]) {
      legacy.placeBuilding(kind, point(col, 1));
      enabled.placeBuilding(kind, point(col, 1));
    }
    const root = point(4, 1);
    const preview = legacy.previewBuildingSynthesis(kind, root);
    assert.equal(preview.evolution, undefined);
    const basicUpgrade = legacy.placeBuilding(kind, root);
    assert.equal(basicUpgrade.level, 2);
    assert.equal(basicUpgrade.evolution, undefined);
    if (kind !== "tower") {
      assert.deepEqual(enabled.previewBuildingSynthesis(kind, root), preview);
      assert.deepEqual(enabled.placeBuilding(kind, root), basicUpgrade);
    }
  }
});

test("placement preview ignores occupied, solid, out-of-bounds and manual-only targets", () => {
  const layout = emptyLayout();
  layout[1] = "....+.......";
  const map = new TerrainMap(layout, { towerEvolution: true });
  const manual = new TerrainMap(emptyLayout(), { autoMerge: false, towerEvolution: true });
  for (const col of [1, 2, 3]) {
    map.placeBuilding("tower", point(col, 1));
    manual.placeBuilding("tower", point(col, 1));
  }
  assert.equal(map.previewBuildingSynthesis("tower", point(3, 1)), undefined);
  assert.equal(map.previewBuildingSynthesis("tower", point(4, 1)), undefined);
  assert.equal(map.previewBuildingSynthesis("tower", point(-1, 1)), undefined);
  assert.equal(map.previewBuildingSynthesis("wall", point(0, 1)), undefined);
  assert.equal(manual.previewBuildingSynthesis("tower", point(4, 1)), undefined);
  assert.equal(manual.placeBuilding("tower", point(4, 1)).level, 1);
  assert.deepEqual(manual.synthesizeBuilding(point(4, 1)).evolution, { kind: "piercing", axis: "horizontal" });
});

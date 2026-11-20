import assert from "node:assert/strict";
import test from "node:test";
import { ExplorationFog } from "../src/fog.ts";

const cell = (col, row) => ({ col, row });

test("unknown cells stay hidden outside the player's eight-tile circular radius", () => {
  const fog = new ExplorationFog(40, 96);
  const player = cell(19, 48);
  assert.equal(fog.visibility(player), "unknown");
  const revision = fog.revision;
  fog.reveal(player);
  assert.equal(fog.revision, revision + 1);
  for (const point of [player, cell(27, 48), cell(19, 40), cell(22, 55)]) {
    assert.equal(fog.visibility(point), "visible");
  }
  for (const point of [cell(28, 48), cell(19, 57), cell(25, 54)]) {
    assert.equal(fog.visibility(point), "unknown");
  }
});

test("moving across a seam dims prior cells, retains memory, and restores visibility upon return", () => {
  const fog = new ExplorationFog(40, 96);
  const south = cell(19, 65);
  const middle = cell(19, 60);
  const north = cell(19, 40);
  fog.reveal(south);
  assert.equal(fog.visibility(cell(19, 63)), "visible");
  fog.reveal(middle);
  assert.equal(fog.visibility(south), "visible");
  fog.reveal(north);
  assert.equal(fog.visibility(south), "explored");
  assert.equal(fog.visibility(middle), "explored");
  assert.equal(fog.visibility(north), "visible");
  fog.reveal(south);
  assert.equal(fog.visibility(south), "visible");
  assert.equal(fog.visibility(north), "explored");
  assert.equal(fog.visibility(cell(38, 31)), "unknown");
});

test("offscreen towers reveal their local cells and removal never erases explored memory", () => {
  const fog = new ExplorationFog(40, 96);
  const player = cell(19, 92);
  const remote = { cell: cell(14, 4), radius: 3 };
  const overlap = { cell: cell(21, 92), radius: 1 };
  const pinpoint = { cell: cell(2, 31), radius: 0 };
  fog.reveal(player, [remote, overlap, pinpoint]);
  assert.equal(fog.visibility(remote.cell), "visible");
  assert.equal(fog.visibility(cell(17, 4)), "visible");
  assert.equal(fog.visibility(cell(18, 4)), "unknown");
  assert.equal(fog.visibility(overlap.cell), "visible");
  assert.equal(fog.visibility(pinpoint.cell), "visible");
  assert.equal(fog.visibility(cell(3, 31)), "unknown");

  fog.reveal(player, [pinpoint]);
  assert.equal(fog.visibility(remote.cell), "explored");
  assert.equal(fog.visibility(overlap.cell), "visible", "The player still sees the lost tower's spot");
  assert.equal(fog.visibility(pinpoint.cell), "visible");
  fog.reveal(cell(18, 65));
  assert.equal(fog.visibility(remote.cell), "explored");
  assert.equal(fog.visibility(overlap.cell), "explored");
  assert.equal(fog.visibility(pinpoint.cell), "explored");
});

test("map edges and invalid sources cannot reveal another row's cells", () => {
  const fog = new ExplorationFog(40, 96);
  assert.throws(() => new ExplorationFog(0, 96), RangeError);
  assert.throws(() => new ExplorationFog(40, 4.5), RangeError);

  fog.reveal(cell(0, 0), [
    { cell: cell(40, 0), radius: 8 }, { cell: cell(20, 40), radius: -1 },
    { cell: cell(32, 64), radius: Infinity }, { cell: cell(6.5, 50), radius: 8 },
  ]);
  for (const boundary of [cell(0, 0), cell(8, 0), cell(0, 8)]) {
    assert.equal(fog.visibility(boundary), "visible");
  }
  for (const point of [cell(-1, 1), cell(40, 0), cell(0, 96), cell(1.5, 2), cell(NaN, 0),
    cell(39, 0), cell(20, 40), cell(32, 64), cell(6, 50)]) {
    assert.equal(fog.visibility(point), "unknown");
  }
});

test("round reset clears both remembered and visible cells and allows a fresh reveal", () => {
  const fog = new ExplorationFog(40, 96);
  const old = cell(19, 92);
  const current = cell(19, 70);
  const remote = { cell: cell(27, 21), radius: 1 };
  fog.reveal(old);
  fog.reveal(current, [remote]);
  assert.equal(fog.visibility(old), "explored");
  assert.equal(fog.visibility(current), "visible");
  assert.equal(fog.visibility(remote.cell), "visible");
  const revision = fog.revision;
  fog.reset();
  assert.equal(fog.revision, revision + 1);
  for (const point of [old, current, remote.cell]) assert.equal(fog.visibility(point), "unknown");
  fog.reveal(old);
  assert.equal(fog.visibility(old), "visible");
  assert.equal(fog.visibility(current), "unknown");
});

import assert from "node:assert/strict";
import test from "node:test";
import { runTowerSpaceComparison } from "./tower-space-comparison.mjs";

const { runs, budgets } = runTowerSpaceComparison();
const mainRuns = runs.filter(({ extension }) => extension === "extend");
const bySetup = (space, setup, extension = "extend") => runs.find((run) => (
  run.space === space && run.setup === setup && run.extension === extension
));

test("FIX01-D matches layout, enemy cohorts and paid inventory for the initial and follow-up comparisons", () => {
  assert.equal(runs.length, 14);
  assert.deepEqual(budgets, { first: 25, extension: 18 });
  for (const space of ["open", "limited"]) {
    const common = bySetup(space, "dispersed");
    for (const setup of ["dispersed", "piercing", "burst"]) {
      const run = bySetup(space, setup);
      const hold = bySetup(space, setup, "hold");
      assert.deepEqual(run.geometry, common.geometry);
      assert.deepEqual([run.initialPrice, run.extensionPrice], [[3, 3, 3, 6], [6, 6, 6]]);
      assert.equal(run.prePaidBudget, 43);
      assert.equal(run.economy.technologySpend, 10);
      assert.equal(run.economy.cardSpend, 33);
      assert.equal(run.economy.cardsMade, 7);
      assert.equal(run.initialPlaced.length, 4);
      assert.deepEqual(run.initialPlaced, hold.initialPlaced);
      assert.deepEqual(run.combat[0], hold.combat[0]);
      assert.equal(hold.undeployedCards, 3);
      assert.deepEqual(run.combat.map(({ enemies, armored }) => [enemies, armored]), [[8, 0], [16, 4], [24, 6]]);
    }
  }
});

test("FIX01-D exercises three reoccupied released tiles and tests two legal alternatives to preserving a crowded dispersed layout", () => {
  for (const setup of ["dispersed", "piercing", "burst"]) {
    assert.equal(bySetup("open", setup).followUpPlaced.length, 3);
  }
  const limited = bySetup("limited", "dispersed");
  assert.equal(limited.followUpPlaced.length, 1);
  assert.equal(limited.undeployedCards, 2);
  assert.equal(limited.unusedReason, "would-force-merge");
  assert.ok(limited.remainingLegalSites.length > 0);
  for (const space of ["open", "limited"]) {
    for (const setup of ["piercing", "burst"]) {
      const run = bySetup(space, setup);
      assert.equal(run.initialPlaced[3].released.length, 3);
      assert.equal(run.reusedReleased, 3);
      assert.equal(run.undeployedCards, 0);
      assert.ok(run.followUpPlaced.every(({ revisionBefore, revisionAfter }) => revisionAfter > revisionBefore));
    }
  }
  const adapted = bySetup("limited", "dispersed", "allow-merge");
  assert.equal(adapted.undeployedCards, 0);
  assert.ok(adapted.followUpPlaced.some(({ released }) => released.length === 3));
  const excavated = bySetup("limited", "dispersed", "excavate");
  assert.equal(excavated.undeployedCards, 0);
  assert.deepEqual(excavated.followUpExcavation, [{ site: { col: 7, row: 10 }, income: 0.5 }]);
  assert.ok(excavated.followUpPlaced.every(({ evolution }) => evolution === null));
});

test("FIX01-D the same cached route gains a shortcut after legal synthesis and loses it after rebuilding", () => {
  for (const run of mainRuns) {
    assert.ok(run.afterMerge.searches > run.beforeMerge.searches);
    assert.ok(run.nextAfter.searches > run.nextBefore.searches);
    if (run.setup === "dispersed") {
      assert.equal(run.beforeMerge.steps, run.afterMerge.steps);
      continue;
    }
    const released = new Set(run.initialPlaced[3].released.map(({ col, row }) => `${col},${row}`));
    const usesReleased = ({ cells }) => cells.some(({ col, row }) => released.has(`${col},${row}`));
    assert.ok(run.afterMerge.steps < run.beforeMerge.steps);
    assert.ok(usesReleased(run.afterMerge));
    assert.ok(!usesReleased(run.beforeMerge));
    assert.ok(!usesReleased(run.nextAfter));
    assert.equal(run.nextAfter.steps, run.beforeMerge.steps);
  }
});

test("FIX01-D compares fire coverage, damage, contact losses and the benefit of paid extension across living waves", () => {
  for (const run of mainRuns) {
    const hold = bySetup(run.space, run.setup, "hold");
    assert.ok(run.combat[1].damage > hold.combat[1].damage);
    assert.ok(run.combat[1].coverageTiles > 0);
    assert.ok(run.combat[1].navigationSearches > 0);
    assert.equal(run.combat[1].towersBefore.length, run.combat[0].towersBefore.length
      + run.followUpPlaced.length - run.combat[0].destroyedBuildings.length);
    assert.ok(run.combat.some(({ wallHits, wallDamage }) => wallHits > 0 && wallDamage > 0));
    assert.ok(run.combat.some(({ destroyedBuildings }) => destroyedBuildings.some(({ kind }) => kind === "tower")));
    assert.ok(run.combat.every(({ wallHpBefore, wallHpAfter, wallDamage }) => wallHpBefore - wallHpAfter === wallDamage));
  }
});

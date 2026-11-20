import assert from "node:assert/strict";
import test from "node:test";
import { BUILDING_BALANCE_PROFILES } from "../src/building-balance.ts";
import { DIFFICULTY_PROFILES } from "../src/expedition-difficulty.ts";
import { ECONOMY_PROTOTYPE, toEconomyTenths } from "../src/expedition-economy.ts";
import {
  BALANCE_CLOCKS, BALANCE_SEEDS, BALANCE_STRATEGIES, replayCraftAfterRelocation, runChallengeBalanceMatrix,
} from "./challenge-balance.mjs";

const matrix = runChallengeBalanceMatrix();
const all = matrix.runs;
const normal = all.filter(({ clock }) => clock === "normal");
const ten = toEconomyTenths;
const canonical = ({ clock, clockSteps, ...observations }) => observations;
const income = (totals) => ten(totals.miningIncome) + ten(totals.productionIncome) + ten(totals.killIncome);
const costs = (totals) => ten(totals.cardSpend) + ten(totals.researchSpend) + ten(totals.technologySpend);

test("FIX03 Challenge compares six genuine seeds and the same four opening inputs across durability variants", () => {
  assert.deepEqual(BALANCE_SEEDS, [9, 12, 512, 1091, 0, 4_294_967_295]);
  assert.equal(all.length, 192);
  assert.equal(new Set(all.map(({ seed, strategy, balance, clock }) => [seed, strategy, balance, clock].join("/"))).size, 192);
  assert.deepEqual(BALANCE_CLOCKS, ["normal", "idle-accelerated"]);
  for (const seed of BALANCE_SEEDS) {
    for (const strategy of BALANCE_STRATEGIES) {
      const runs = normal.filter((item) => item.seed === seed && item.strategy === strategy);
      assert.equal(runs.length, 4);
      assert.equal(new Set(runs.map(({ openingDigest }) => openingDigest)).size, 1);
      assert.equal(new Set(runs.map(({ fingerprint }) => fingerprint)).size, 1);
      for (const run of runs) {
        assert.equal(run.effectiveSeed, run.seed);
        assert.equal(run.start.totals.balance, 0);
        assert.deepEqual(run.start.buildings, []);
        assert.deepEqual(run.start.cards, { wall: 0, tower: 0, economy: 0 });
        assert.equal(run.start.toolLevel, 1);
        assert.ok(run.firstTenAtMs > 0 && run.firstTenAtMs <= run.facility.atMs);
        assert.equal(run.facility.cost, 10);
        assert.equal(run.facility.balanceBefore - run.facility.balanceAfter, 10);
        assert.equal(run.waves[0].atMs, 60_000);
        assert.equal(run.waves[0].order.count, 8);
        assert.equal(run.waves[0].order.enemyHp, 4);
        for (const placed of run.construction) {
          assert.equal(placed.maxHp, placed.kind === "wall" ? BUILDING_BALANCE_PROFILES[run.balance].wallHp : 1);
        }
      }
    }
  }
});

test("FIX03 idle batching preserves every active step outcome and all game timestamps", () => {
  let totalSaved = 0;
  for (const run of normal) {
    const fast = all.find((item) => item.seed === run.seed && item.strategy === run.strategy && item.balance === run.balance
      && item.clock === "idle-accelerated");
    assert.deepEqual(canonical(fast), canonical(run));
    assert.equal(fast.clockSteps.advancedFrames, run.clockSteps.advancedFrames);
    assert.ok(fast.clockSteps.stepped <= run.clockSteps.stepped);
    totalSaved += run.clockSteps.stepped - fast.clockSteps.stepped;
  }
  assert.ok(totalSaved > 0, "at least one actual inactive countdown must have been batched");
});

test("FIX03 Challenge records actual early build choices, clashes, breaches and northern wins or losses", () => {
  const research = normal.filter(({ strategy }) => strategy === "research-first");
  assert.ok(research.every(({ researchAtMs, draws }) => researchAtMs > 0 && draws.every(({ atMs }) => atMs >= researchAtMs)));
  const economy = normal.filter(({ strategy }) => strategy === "economy-first");
  assert.ok(economy.every(({ construction }) => construction[0].kind === "economy"));
  const pure = normal.filter(({ strategy }) => strategy === "wall-only");
  assert.ok(pure.every(({ construction }) => construction.every(({ kind }) => kind === "wall")));
  assert.ok(pure.some(({ firstDefenseBuilt }) => firstDefenseBuilt === null), "late natural draws must remain observable");
  for (const run of pure.filter(({ seed }) => seed === 9)) {
    const wave = run.waves[0];
    assert.equal(wave.combat.wallImpacts, 8);
    assert.equal(wave.settled.buildings.find(({ kind }) => kind === "wall").hp,
      BUILDING_BALANCE_PROFILES[run.balance].wallHp - 8);
    assert.ok(run.researchAtMs === null || run.researchAtMs > wave.settled.atMs);
  }
  assert.ok(normal.some(({ result }) => result === "won"));
  assert.ok(normal.some(({ result }) => result === "lost"));
  for (const run of normal) {
    if (run.result === "won") {
      assert.equal(run.finish.toolLevel, 2);
      assert.ok(run.finish.playerHp > 0);
      assert.ok(run.playerCell.row < 9);
    } else if (run.result === "lost") {
      assert.equal(run.finish.playerHp, 0);
      assert.ok(run.combatEvents.some(({ type }) => type === "playerHit"));
    } else {
      assert.equal(run.result, "horizon");
      assert.ok(run.horizonReason);
    }
    const wallBreaks = run.waves.flatMap(({ wallBreaks }) => wallBreaks);
    assert.deepEqual(run.firstWallBreak, wallBreaks[0] ?? null);
    for (const { combat, wallImpacts, wallBreaks } of run.waves) {
      assert.equal(combat.cancelledPending + combat.pending + combat.spawned, combat.planned);
      assert.equal(combat.wallImpacts, wallImpacts.length);
      assert.equal(combat.wallsDestroyed, wallBreaks.length);
      assert.equal(combat.wallDamage, wallImpacts.reduce((damage, event) => damage + event.damage, 0));
      assert.equal(new Set(wallImpacts.map(({ enemyId }) => enemyId)).size, wallImpacts.length);
    }
  }
});

test("FIX03 retains the original Challenge economy and reconciles every paid craft and wave ledger", () => {
  const config = DIFFICULTY_PROFILES.challenge.economy;
  assert.equal(config.technologyBuildCost, 10);
  assert.equal(config.researchCost, 20);
  assert.equal(config.miningIncomeTenthsPerHp, 1);
  assert.equal(config.guaranteedDefenseDraw, 3);
  assert.equal(ECONOMY_PROTOTYPE.drawCost, 3);
  assert.equal(ECONOMY_PROTOTYPE.towerKillReward, 2);
  for (const run of normal) {
    assert.equal(ten(run.finish.totals.balance), income(run.finish.totals) - costs(run.finish.totals));
    assert.equal(run.finish.totals.cardSpend, run.draws.filter(({ card }) => card !== null).length * 3);
    for (const period of run.economyHistory) {
      assert.equal(ten(period.net), income(period) - costs(period));
      assert.equal(ten(period.balance), ten(period.openingBalance) + ten(period.net));
    }
    for (const wave of run.waves) {
      assert.equal(wave.economyPeriod.cohortKillIncome, wave.combat.towerKills * ECONOMY_PROTOTYPE.towerKillReward);
    }
  }
});

test("FIX03 a natural enemy destroys technology between crafts and paid relocation preserves the seed 1091 guarantee", () => {
  const run = replayCraftAfterRelocation();
  const fast = replayCraftAfterRelocation("idle-accelerated");
  assert.deepEqual(canonical(run), canonical(fast));
  assert.deepEqual(run.cards, ["economy", "economy", "tower", "economy"]);
  assert.equal(run.destroyed.waveId, 1);
  assert.ok(run.rebuiltAtMs > run.destroyed.atMs);
  assert.notDeepEqual(run.replacement.cell, run.destroyed.cell);
  assert.equal(run.draws[2].reason, "technology-destroyed");
  assert.equal(run.draws[2].card, null);
  assert.equal(run.draws[2].balanceBefore, run.draws[2].balanceAfter);
  assert.equal(run.finish.totals.miningIncome, 32);
  assert.equal(run.finish.totals.technologySpend, 20);
  assert.equal(run.finish.totals.cardSpend, 12);
  assert.equal(run.finish.totals.balance, 0);
});

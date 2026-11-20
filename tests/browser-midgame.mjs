import assert from "node:assert/strict";
import { readCardInventory } from "./browser-card-feedback.mjs";
import { openChallenge, runChallengeLossSmoke, runChallengeVictorySmoke } from "./browser-challenge.mjs";

export async function runMidgameProfilesSmoke(page, baseUrl) {
  const seed = 12;
  const run = await openChallenge(page, baseUrl, seed);
  const selector = page.locator("#midgame-experiment");
  const price = () => run.maker.textContent();
  assert.equal(await selector.inputValue(), "control");
  assert.equal(new URL(page.url()).searchParams.get("midgame"), null);
  const profiles = await selector.locator("option").evaluateAll((options) => options.map(({ value }) => value));
  assert.deepEqual(profiles, [
    "control", "dense", "dense-burst", "armored", "tier", "kill-decay", "economy-combined", "combat-combined", "combined",
  ]);

  await page.clock.resume();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("midgame") === "combined"),
    selector.selectOption("combined"),
  ]);
  await page.waitForFunction(() => document.getElementById("round-state").dataset.phase === "preparing");
  assert.equal(new URL(page.url()).searchParams.get("seed"), String(seed));
  assert.equal(await selector.inputValue(), "combined");
  assert.equal(await page.locator("#challenge-balance").inputValue(), "w25");
  assert.equal(await run.cash(), "0.0");
  assert.equal(await price(), "制造卡牌（3 经济）");
  assert.deepEqual(await readCardInventory(page), { wall: 0, tower: 0, economy: 0 });

  const legacyUrl = new URL("/?mode=play&difficulty=b&seed=12&midgame=combined", baseUrl);
  await page.goto(legacyUrl.href);
  await page.waitForFunction(() => document.getElementById("round-state").dataset.phase === "preparing");
  assert.ok(await selector.isHidden());
  assert.equal(await price(), "制造卡牌（3 经济）");
  assert.equal(await run.cash(), "8");
  assert.deepEqual(await readCardInventory(page), { wall: 4, tower: 2, economy: 1 });
  return { seed, profiles, sameSeedSwitch: true, legacyProfileUnchanged: true };
}

export function runCombinedVictorySmoke(page, baseUrl) {
  return runChallengeVictorySmoke(page, baseUrl, "control", "combined");
}

export function runCombinedLossSmoke(page, baseUrl) {
  return runChallengeLossSmoke(page, baseUrl, "combined");
}

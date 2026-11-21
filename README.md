# Excavation Survival Tower Defense

Excavation Survival Tower Defense (ESTD) is a top-down browser prototype for course playtesters and players who enjoy shaping enemy routes. Dig through a seeded 40 × 96 map, use the terrain to build a defense, and advance north while enemies enter from the south.

I wanted each route you dig to matter for both exploration and defense. A passage that gives you more room to build can also give enemies a way in.

## Play locally

Use Node.js 22.18 or later in the 22.x series, or Node.js 24 or later, with npm. Run these commands from the project directory.

```sh
npm ci
npm run dev
```

Open the address printed by Vite to start the current Playtest Build. Add `?seed=12` for a repeatable map. In Windows PowerShell, substitute `npm.cmd` if the shell blocks `npm.ps1`.

| Input | Action |
| --- | --- |
| WASD | Move. |
| Hold left mouse button | Dig an adjacent tile. After clearing it, keep holding and use WASD to continue in that direction. |
| Select a building card, then click the map | Place on a visible, empty tile in the eight surrounding cells. Hold Shift to keep placing the same card while it is in stock. Press Esc to cancel. |
| Click a ready building, then choose **合成** (Merge) | Inspect the result and merge when you are next to any of the four participating buildings. |
| E or **启动撤离装置** | Activate the evacuation device from its tile or an orthogonally adjacent tile. |
| R or **重试当前种子** | Restart with the current world seed. |
| **新开一局** | Start with a different world seed. |
| G | Toggle the grid. |

## Current Playtest Build

I chose Challenge, W25, and Combined for one provisional playtest build. Opening the game starts this configuration with standard timing and fog of war. The map includes seeded regions, terrain tiers, construction and building synthesis, card crafting, tool research, and enemy waves. Research the level-two tool and dig to the northern goal. Activate the evacuation device, then keep yourself and its 6 HP alive until both final batches have spawned and cleared. The 12 and 20 enemies enter from the south and use the passages you excavated. Starting the evacuation stops new ordinary waves while enemies already in play continue acting.

You start with a level-one tool and no currency, cards, or structures. Each point of actual terrain damage earns 0.1 currency. Select **建造科技设施** and place it on a legal neighboring tile for 10 currency. Level-two tool research costs 20. At least one of the first three paid crafts yields a wall or tower. The first wave brings eight enemies after 60 seconds. Rebuilding a lost facility preserves research completed during the run.

Walls start at 25 HP and consume enemies that collide with them. Towers, economy buildings, and technology facilities have 1 HP. An enemy that destroys one stays in play. Enemies that lose sight of the player target reachable buildings first. If that target is lost and there are no other reachable buildings, the enemy can take an open detour to the player.

Four orthogonally connected level-one walls, towers, or producers of the same kind become ready to merge. They keep working separately until you choose Merge. The upgrade uses the oldest building’s position and frees the other three tiles. The freed space briefly highlights so you can rebuild with the cards in your inventory. A level-two wall has 50 HP and carries forward lost HP. A level-two producer doubles its output per cycle. Towers retain their cooldown, and producers retain time spent on their current cycle.

I chose to let the shape of four connected towers determine what they become. A straight row or column makes a Piercing Tower with a fixed firing axis. Every other connected shape makes a Burst Tower. Select a ready group to preview the upgrade, the retained tile, and the three tiles that will open. The route warning compares a visible enemy’s approach or a known entrance sample. It flags a shorter or newly passable route and shows when fog or a target change prevents a comparison. The straight mark distinguishes Piercing from the ring used for Burst. Hover over a visible tower to inspect its current attributes.

| Candidate tower | Attack | Interval | Base range |
| --- | --- | ---: | ---: |
| Piercing Tower Lv.2 | Deals 5 damage each to up to four enemies whose bodies touch the beam along one side of its fixed axis. With no valid beam target, it can deal 2 damage to one nearby enemy. Both modes share the same cooldown. | 750 ms | 7 tiles on the axis, 4 for fallback |
| Burst Tower Lv.2 | Deals 4 damage to its target and 2 to nearby enemies within 2 tiles of the impact. | 650 ms | 5 tiles |

Friendly walls stop enemies but allow Piercing and Burst attacks, including the Piercing fallback and Burst splash. Undug soil, rock, and other structures still block these shots. Attacks can cross open water, and units still need a dry route. Hover over a tower to see its range. The Piercing preview shows the clear beam in blue and its fallback radius in amber. The fallback and Burst circles show the distance limit, and each shot still needs a clear line. Highland adds 2 tiles to the main range of either evolved tower. Both have 1 HP. Each final batch uses the current Combined enemy rules and has its own diminishing kill reward count. These values are provisional for playtesting.

The midgame rules target 200, 150, then 100 ms between releases as waves advance, subject to space at the southern entrance. After the second depth stage is reached, 25% of planned slots are gold, ringed 14 HP enemies, rounded to the nearest enemy. Card crafts 1–3 cost 3, crafts 4–8 cost 6, and later crafts cost 9. Each spawn wave awards 2 for its first eight tower kills and 1 for each subsequent kill from that wave.

Development and browser regression checks have been run on Windows with desktop Microsoft Edge. Play uses a keyboard and mouse, and the current in-game interface is in Simplified Chinese. Other platforms, browsers, and touch controls have yet to be validated. Difficulty balance still awaits human playtesting.

## Build and test

```sh
npm test
npm run typecheck
npm run build
npm run test:browser -- --playtest
npm run test:browser
npm run preview
```

The build writes the player distribution to `dist/`. Use `--playtest` to test this production output in a locally installed Edge. The historical browser suite builds its own temporary diagnostic artifact. Use `--normal-round` for standard-timing regression, or `--challenge`, `--building-balance`, `--contacts`, and `--midgame` for targeted suites. The tower evolution suite is available with `--tower-evolution`. The standalone test scripts `tests/browser-stress.mjs` and `tests/browser-midgame-perf.mjs` measure short load and sustained defense. Run `node tests/tower-specialization.mjs` for the matched radius and cooldown experiments and `node tests/tower-space-comparison.mjs` for the equal-cost construction comparison. Run `node tests/merge-timing.mjs` to compare automatic, early, and delayed merges. Use `node tests/browser-merge-performance.mjs --record` to measure selection and route previews under load in Edge. The historical tower load test remains available through `node tests/browser-tower-evolution-perf.mjs`. Run `node tests/browser-tower-targeting.mjs --record` for the targeting comparison and fogged performance in Edge. Run `node tests/tower-wall-matrix.mjs` for the matched wall, range, and economy comparisons. Run `node tests/browser-tower-wall-controlled.mjs --record` for the controlled Edge wall, range, and fog performance checks. Run `node tests/endgame-replay.mjs` for the paid strategy matrix. Pass `--random-seed=<seed>` to repeat its fifth seed.

For development diagnostics, start the dev server and use `?diagnostics=1&mode=play`. This opens the historical difficulty, building, and midgame selectors. Add `&debug=1` to access tools such as **玩家受击记录**. In this diagnostic environment, `&evolution=1` enables shape-based towers with the original combat values. Add `&merge=manual` to test the current interaction in the diagnostic build. Add `&evacuation=1&targeting=1&wallSynergy=1` to exercise the evacuation, body-aware targeting, and friendly-wall behavior in a diagnostic run. Historical immediate merges, arrival wins, and tower targeting remain available to regression tests. The player distribution accepts a world seed and uses its fixed playtest rules for every round.

## Project records

- [Weekly progress reports](docs/progress/README.md)
- [Credits, licenses, and AI disclosure](docs/CREDITS.md)

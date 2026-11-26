# Excavation Survival Tower Defense

Excavation Survival Tower Defense (ESTD) is a top-down desktop browser game prototype for course playtesters and players who enjoy planning defenses around terrain. In each run, dig through a seeded 40 × 96 map, earn resources, build defenses, and push north while enemies enter from the south.

I wanted each route you dig to matter for both exploration and defense. A passage that gives you room to build or speeds up your advance can also give enemies a way in.

## Play locally

Use Node.js 22.18 or later in the 22.x series, or Node.js 24 or later, with npm. Run these commands from the project directory.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite to start the course Playtest Build. Add `?seed=12` for a repeatable map. In Windows PowerShell, substitute `npm.cmd` if the shell blocks `npm.ps1`. To serve the production build locally, run `npm run build` and then `npm run preview`. A hosted course build is not documented.

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

## Current course Playtest Build

I chose Challenge, W25, and Combined for a single course playtest configuration, with standard timing and fog of war. This is the P0-J-FIX02 gameplay baseline, `f4321b8`.

Research the level-two tool and dig to the northern goal. Activate the evacuation device, then keep both yourself and the 6 HP device alive until all 32 final enemies have spawned and resolved. They enter from the south in batches of 12 and 20 and follow passages you excavated. Starting evacuation stops new ordinary waves. Ordinary enemies already in play continue acting.

You start with a level-one tool and no currency, cards, or structures. Each point of actual terrain damage earns 0.1 currency. Select **建造科技设施** and place it on a legal neighboring tile for 10 currency. Level-two tool research costs 20. At least one of the first three paid crafts yields a wall or tower. The first wave brings eight enemies after 60 seconds. Rebuilding a lost facility preserves research completed during the run.

Walls start at 25 HP. An enemy, including an armored one, deals a single impact to a wall and is removed immediately. Towers, economy buildings, and technology facilities have 1 HP. An enemy that destroys one stays in play. Enemies that lose sight of the player target reachable buildings first. If that target is lost and there are no other reachable buildings, the enemy can take an open detour to the player.

Four orthogonally connected level-one walls, towers, or producers of the same kind become ready to merge. They keep working separately until you choose Merge. The upgrade uses the oldest building’s position and frees the other three tiles. The freed space briefly highlights so you can rebuild with the cards in your inventory. A level-two wall has 50 HP and carries forward lost HP. A level-two producer doubles its output per cycle. Towers retain their cooldown, and producers retain time spent on their current cycle.

I chose to let the shape of four connected towers determine what they become. A straight row or column makes a Piercing Tower with a fixed firing axis. Every other connected shape makes a Burst Tower. Select a ready group to preview the upgrade, the retained tile, and the three tiles that will open. The route warning compares a visible enemy’s approach or a known entrance sample. It flags a shorter or newly passable route and shows when fog or a target change prevents a comparison. The straight mark distinguishes Piercing from the ring used for Burst. Hover over a visible tower to inspect its current attributes.

| Candidate tower | Attack | Interval | Base range |
| --- | --- | ---: | ---: |
| Piercing Tower Lv.2 | Deals 5 damage each to up to four enemies whose bodies touch the beam along one side of its fixed axis. With no valid beam target, it can deal 2 damage to one nearby enemy. Both modes share the same cooldown. | 750 ms | 7 tiles on the axis, 4 for fallback |
| Burst Tower Lv.2 | Deals 4 damage to its target and 2 to nearby enemies within 2 tiles of the impact. | 650 ms | 5 tiles |

Friendly walls stop enemies but allow Piercing and Burst attacks, including the Piercing fallback and Burst splash. Undug soil, rock, and other structures still block these shots. Attacks can cross open water, and units still need a dry route. Hover over a tower to see its range. The Piercing preview shows the clear beam in blue and its fallback radius in amber. The fallback and Burst circles show the distance limit, and each shot still needs a clear line. Highland adds 2 tiles to the main range of either evolved tower. Both have 1 HP. These values are provisional for playtesting.

Combined targets 200, 150, then 100 ms between releases as waves advance. An occupied southern entrance delays the next spawn. From the second depth stage, about a quarter of planned enemies are gold-ringed armored units with 14 HP, with the count rounded to the nearest whole enemy. Card crafts 1–3 cost 3, crafts 4–8 cost 6, and later crafts cost 9. Within each spawning wave or final batch, the first eight tower kills pay 2 currency each and later kills pay 1. Wall impacts earn no kill reward.

Recorded browser checks cover desktop Microsoft Edge on Windows. Play uses a keyboard and mouse, and the interface is in Simplified Chinese. Other browsers, platforms, and touch controls remain unverified. Difficulty and long-session balance still await human playtesting.

## Recent private experiment

I tested an armored wall charge in a separate P0-K prototype. Armored enemies briefly stop on contact with a wall, and tower damage can weaken the eventual impact. Automated checks support the candidate. The course build uses the P0-J-FIX02 rules above, and the timing and balance of the candidate still need human playtesting. [P0-K weekly report](docs/progress/2026-W48.md)

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

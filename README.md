# Excavation Survival Tower Defense

Excavation Survival Tower Defense (ESTD) is a top-down browser prototype for course playtesters and players who enjoy shaping enemy routes. Dig through a seeded 40 × 96 map, use the terrain to build a defense, and advance north while enemies enter from the south.

I wanted each route you dig to matter for both exploration and defense. A passage that gives you more room to build can also give enemies a way in.

## Play locally

Use Node.js 22.18 or later in the 22.x series, or Node.js 24 or later, with npm. Run these commands from the project directory.

```sh
npm ci
npm run dev
```

Open the address printed by Vite and append `?mode=play`. Use `?mode=play&seed=12` for a repeatable map. In Windows PowerShell, substitute `npm.cmd` if the shell blocks `npm.ps1`.

| Input | Action |
| --- | --- |
| WASD | Move. |
| Hold left mouse button | Dig an adjacent tile. After clearing it, keep holding and use WASD to continue in that direction. |
| Select a building card, then click the map | Place on a visible, empty tile in the eight surrounding cells. Press Esc to cancel selection. |
| R / New Round | Reset the same seed / start with a different seed. |
| G | Toggle the grid. |

## Current prototype

The main play mode includes seeded terrain, fog of war, enemy waves, construction and building synthesis, card crafting, tool research, and win and loss states. Research the level-two tool and reach the northern goal to win.

Baseline starts with building cards and economy. A brings waves forward, and B also raises enemy durability. I approved a separate Challenge mode to see how players would earn and place their first defense under time pressure.

Challenge starts with a level-one tool and no currency, cards, or structures. Each point of terrain damage actually applied earns 0.1 currency. Select **建造科技设施** and place it on a legal neighboring tile for 10 currency. With a facility, a card costs 3 and level-two tool research costs 20. At least one of the first three paid crafts yields a wall or tower. The first Challenge wave brings eight enemies after 60 seconds. If you lose the facility, you can pay to rebuild on another legal tile and keep research completed during that run.

Walls retain numeric durability and consume enemies that collide with them. Towers, economy buildings, and technology facilities have 1 HP. An enemy that destroys one stays in play. Baseline, A, and B still start with a technology facility and use their original starting resources and research price.

Development and browser regression checks have been run on Windows with desktop Microsoft Edge. Play uses a keyboard and mouse, and the current in-game interface is in Simplified Chinese. Other platforms, browsers, and touch controls have yet to be validated. Difficulty balance still awaits human playtesting.

## Build and test

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
npm run preview
```

The build writes to `dist/`. Browser tests use a locally installed Edge and require a build first. Use `npm run test:browser -- --normal-round` to include standard-timing round coverage, `npm run test:browser -- --challenge` for the Challenge scenarios, or `npm run test:browser -- --contacts` for player and building contact.

In play mode, add `&debug=1` to the URL and expand **玩家受击记录** to copy contact details, including world position, HP before and after the hit, and the red dot's camera and fog visibility.

## Project records

- [Weekly progress reports](docs/progress/README.md)
- [Credits, licenses, and AI disclosure](docs/CREDITS.md)

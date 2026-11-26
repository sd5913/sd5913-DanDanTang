# Credits

## Human contributions

| Recorded alias | Verified role or contribution |
| --- | --- |
| `Zaysennn` | Project owner and maintainer. Sets the design scope, records gameplay observations, and maintains prototype checkpoints. |
| `GAO-FM` | Initial README commit `8711147`. |
| `ChiSang` | Submitted the v0.2 design document in `a327a9f`. |
| `xiaomingtongxuegao` | Expanded the README in `a55e107`. |

Historical contributions are listed by the aliases and activities recorded in Git.

## Third-party code and libraries

Versions are from the project lockfile. EventEmitter3 is a Phaser dependency.

| Component | Role | License and upstream notice |
| --- | --- | --- |
| Phaser 3.90.0 | Game framework and canvas rendering | [MIT](https://github.com/phaserjs/phaser/blob/v3.90.0/LICENSE.md) |
| EventEmitter3 5.0.4 | Runtime event emitter | [MIT](https://github.com/primus/eventemitter3/blob/5.0.4/LICENSE) |
| Vite 8.3.8 | Development server and build tools | [MIT and bundled notices](https://github.com/vitejs/vite/blob/main/packages/vite/LICENSE.md) |
| TypeScript 5.9.3 | Type checking | [Apache-2.0](https://github.com/microsoft/TypeScript/blob/v5.9.3/LICENSE.txt) |
| Playwright Core 1.65.1 | Desktop browser test automation | [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) |

Retain the applicable copyright and license notices when redistributing third-party code or bundles, including any relevant Apache NOTICE material. The local prototype build does not generate a standalone third-party notices file. The project has no declared repository-wide license.

## Game assets and data

The prototype draws its terrain, units, buildings, and fog with code and Phaser. The project supplies its fixed test layouts, procedural map rules, seeds, and gameplay data. The current game uses system fonts and ships no custom font files or game audio.

## Development tools

Node.js and npm run local development and tests. Git records changes. Microsoft Edge is the browser used by the automated desktop regression suite.

## AI Usage and Disclosure

I used ChatGPT to discuss design options, plan development, and draft documentation. I used Codex to help implement gameplay and interface changes, investigate bugs, and write and run automated tests, including the private P0-K candidate checks. I also used Codex to compare course commits, design records, and validation evidence when revising the weekly history. I set the project scope and chose the design changes to carry forward. Recorded automated results and human playtesting have separate evidence in the progress reports.

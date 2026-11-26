# Weekly Progress

I use these reports to record the design choices, implementations, and tests behind the desktop browser prototype. The original index dates the early retrospectives to 20 November 2026. I revised their evidence and links on 26 November 2026. Dates and ISO weeks use Hong Kong time. A dated design, a Git checkpoint, a scheduled review, and a test record establish different milestones.

| ISO week | Dates in 2026 | Focus and evidence |
| --- | --- | --- |
| [2026-W43](2026-W43.md) | 19–25 October | Concept exploration. The reported start and early ideas come from recollection. |
| [2026-W44](2026-W44.md) | 26 October–1 November | GDD v0.2 dated 31 October. Excavation, numeric walls, building cards, and the initial prototype plan. |
| [2026-W45](2026-W45.md) | 2–8 November | First working interaction scheduled in the course template. Team delivery and review remain unverified. |
| [2026-W46](2026-W46.md) | 9–15 November | Integrated experience scheduled in the course template. Team delivery and review remain unverified. |
| [2026-W47](2026-W47.md) | 16–22 November | Inspectable prototype checkpoints on 19–21 November. Challenge, manual merging, evacuation, and evolved tower targeting. |
| [2026-W48](2026-W48.md) | 23–29 November | P0-K developed and tested as a private candidate on 26 November. Course integration and human balance review pending. |

## Development at a glance

| Stage | What changed and where it stands |
| --- | --- |
| Concept and core design | I moved from a survival and building loop toward one shared excavated map for player and enemies. GDD v0.2 dated the grid design, northern progression, and the numeric wall rule. The first concept date comes from recollection. [W43](2026-W43.md) · [W44](2026-W44.md) |
| Greybox and expedition | I expanded the 24 × 32 test room through fixed 24 × 96 corridors to a seeded 40 × 96 expedition. The course history shows terrain HP, movement, enemy routes, tool research, terrain tiers, biomes, and fog. [W47 implementation and records](2026-W47.md) |
| Construction and pressure | I combined nearby construction, paid cards, run-wide research, and connected building upgrades with a zero-resource Challenge. I kept one player entry while testing pace, wall durability, armored units, and income in separate comparisons. [W47 Challenge and tower decisions](2026-W47.md) |
| Tower specializations and evacuation | I made the tower shape determine Piercing or Burst, gave the player control over merge timing, and used a defended extraction to close the run. The course gameplay is at P0-J-FIX02 (`f4321b8`). [W47 evacuation and targeting](2026-W47.md#evacuation-and-targeting) |
| Armored wall charge | The separate P0-K candidate passed automated checks. The 900 ms timing and balance await human playtesting, and the course build still uses P0-J-FIX02. P0-K-FIX01 remains a proposal. [W48 candidate and its limits](2026-W48.md) |

## Ideas without dated implementation milestones

I considered regional outposts and loot, fishing, more mining tools and explosives, larger maps, and more ways to build or defend. The implemented map dimensions and region effects are recorded above. The larger scope and additional systems remain ideas to explore.

Recorded contributor attribution and AI assistance are in the consolidated credits. [Project credits](../CREDITS.md)

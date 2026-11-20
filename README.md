# Excavation Survival Tower Defense — Playable Prototype

[Weekly iterations and dated review cards](https://github.com/orgs/sd5913/projects/1/views/1)

The full match entry point is **`?mode=play`**. On first entry a seed is generated. Use **`?mode=play&seed=12`** to reproduce the playtest map described in this document.

The default map is **40 columns × 96 rows**, composed of three consecutive 32-row sections. There is roughly an 8 × 8 connected building area at the southern end; the further north you go, the more you have to dig on your own. Ordinary terrain contains irregular small hollows, fissures, rock clusters and short rock ridges. Coordinates are written as `(column, row)`, with the top-left corner at `(0, 0)`. In terrain debug mode, entering the green target area at the northern end displays **P0-A test complete**.

FIX02 generates a random 32-bit seed when none is specified and appends it to the address bar. Clicking "New Game" uses a different seed; pressing `R` restores this match's initial map and durability. Copying the current address, or using a parameter such as `?seed=12`, reproduces the initial layout under the same generator version. Seeds range from 0 to 4294967295. Invalid parameters fall back to the default seed.

The header shows the seed actually in use, the generator version and the fallback layout state. When terrain validation fails, the actual seed of the default layout and the originally requested seed are both displayed.

| Address parameter | Map |
| --- | --- |
| `?mode=play` | Full match, with random terrain, fog, building, technology and win/loss conditions |
| none | FIX02 default map |
| `?mode=defense` | FIX02 default map with the defense debug panel |
| `?map=fix01` | Original FIX01 dense long map, 24 × 96 |
| `?mode=defense&map=fix01` | Original FIX01 defense lane, 24 × 96 |
| `?map=regression` | Original A2 regression long map, 24 × 96 |
| `?map=single` | Original A1 single map, 24 × 32 |

## Getting started and testing

Node.js 22.18+ (22.x) or 24+ is required. Run the following commands in this directory and open the local address shown in the terminal output.

```powershell
npm.cmd ci --cache .npm-cache
npm.cmd run dev
```

| Input | Action |
| --- | --- |
| WASD | Continuous movement; hitting a wall slides along a passable direction |
| Hold left mouse button | Dig the adjacent ordinary terrain above, below, left or right; once a tile is emptied you can keep aiming at the next one |
| R | Restore terrain and all durability, return to the spawn point, and clear this round's completion state |
| G | Toggle the grid display |

Ordinary terrain starts at 5 HP and loses 1 HP per hit. When the tool is ready, pressing down lands a hit immediately, and afterwards you can attack again every 125 ms. Releasing the button or switching targets keeps that cooldown running. While on cooldown, holding down on a valid target lands the hit as soon as it expires. Holding continuously for about 0.5 seconds while the tool is ready empties a tile. Hovering shows the tile type, its coordinates and the remaining durability of ordinary terrain; damaged terrain gradually darkens. Once HP reaches zero, that tile becomes immediately passable.

Digging locks onto a target once it starts. After emptying a tile you can keep holding the left button, aim at the next adjacent dirt tile, and continue digging as soon as the cooldown expires. When the next tile is temporarily out of reach, hold the left button and walk to an adjacent position to dig it. Releasing the left button, leaving the canvas, walking out of digging range before the tile is emptied, losing window focus, switching tabs, or resetting all end the current dig; durability already deducted is kept until this round is reset.

FIX02 spawns at `(19, 92)`. First walk through the southern building area, then start digging north from the dirt layer at `(19, 83)`, or pick your own route from the side. The boundary between section 63/64 and section 31/32 marks a section edge. The camera shows about 18 tiles horizontally and adjusts its vertical range to the window's height and width. Returning to a previously dug position lets you inspect the retained durability and empty-space state.

## Full match

1. At the southern spawn you start with 8 economy, 4 wall cards, 2 tower cards, 1 economy building card and one technology facility. Click a building card, then click a visible unoccupied empty tile. When four same-type tier-1 buildings connect up/down/left/right they merge automatically; the position built first is kept and the other three tiles are released.
2. Enemies enter from the southern entrance at `(30, 94)`. Normal mode gives you 2 minutes of preparation time and 1 minute of rest between attacks. Cover the enemy approach with towers and lay down walls. A tower kill awards 2 economy, and economy buildings keep producing. Wall numbers show remaining durability.
3. The technology facility can spend 3 economy to randomly produce a building card, or 10 economy to research the Lv.2 tool. Advanced dirt layers require the Lv.2 tool. If the technology facility is destroyed by an attack, it can be rebuilt on the same spot to resume production, and the tool level already researched is kept until the end of this match.
4. The map has plains, highlands and lakes, whose positions vary with the seed. Fog opens within the line of sight of the player and towers. Plains economy buildings produce faster; highlands economy buildings produce slower but give defense towers longer range and larger sight radius. Water cannot be crossed or dug open, so route around the shoreline.
5. Going deep to the north raises the enemy stats of subsequent waves, and lingering for a long time increases the number of subsequent waves. Reaching the green target area at the northern end with the Lv.2 tool wins the match. If the player's HP reaches zero the match is lost, and the ending stops and cleans up combat.

`R` restarts the same seed, restoring all terrain, buildings, cards, technology, fog and match state. Clicking "New Game" switches to a different seed. Copy the address to share this match's starting layout. The default match layout is generator v3.

You can append `&speed=test` to the address to use a shortened prototype clock, append `&fog=off` to view the whole map, or append `&debug=1` to open the spawn and simultaneous-spawn stress test. Player HP, contact damage and wave pacing are all **PROTOTYPE_ONLY** debug values.

## P0-B Defense Greybox

Append `?mode=defense` to the local address. Hover an empty tile and press **B** to place a wall, **T** to place a test tower, or **X** to demolish. Choose the enemy count and the wall impact damage, then click "Spawn at South End". Enemies enter one by one from the fixed spawn point with an interval of at least 200 ms. While the spawn point is still occupied, the remaining enemies wait in a queue. The panel keeps a running tally of requests this round, actual spawns, pending spawns, alive, visible in camera and removed. Both placed walls and towers block movement.

In FIX02 the spawn point `(30, 94)` sits in a small hollow at the southern end, separated from the building area. Once you dig east to open it up, you can place a test tower on nearby empty ground and verify that both enemies and buildings move correctly with the camera. Enemies still only move along the roads you have opened.

To reproduce the original wall-impact and detour scenario, open `?mode=defense&map=fix01`. Walk north from `(11, 92)` and dig open `(11, 89)`. Build a wall at `(11, 87)` and each enemy can hit it once and disappear. After opening `(12, 87)`, enemies prefer to detour around the wall using the empty tile. A test tower can be placed at `(12, 90)` and automatically attacks enemies within its range. Numbers show the wall's remaining HP, and tower kills and wall impacts are counted separately.

The greybox uses the northern test-building marker as its default target. After enabling "Player contact test", a straight orthogonal line within the test sight radius can trigger player priority and contact events. Walls start at 50 HP, and the test tower and spawn batch are verification parameters. The 50, 100 and 250 unit tiers are used only for stress observation. R restores the map, buildings and enemies.

```powershell
npm.cmd test                    # Map durability, digging timing and movement tests
npm.cmd run typecheck           # TypeScript type checking
npm.cmd run build               # Type checking and generation of dist/
npm.cmd run preview             # Local preview of dist/
npm.cmd run test:browser        # Verify the production build with installed Edge; build first
npm.cmd run test:browser -- --normal-round # Also test a full clear with standard wave duration
npm.cmd run test:browser -- --dev # Verify the dev server with installed Edge
node tests/browser-stress.mjs   # Measure frame interval, active enemies and pathfinding of the production build with installed Edge
```

The Edge tests temporarily start Vite on a loopback address and verify old-map regressions, the FIX02 camera, map sectioning, a full match clear and a defeat through real keyboard/mouse input and canvas pixels. Setting `P0A_SCREENSHOT` or `FIX02_SCREENSHOT` specifies the local output path for the corresponding scenario screenshot. Multi-seed map constraints, terrain distribution, the spawn queue and pure simulation checks for 50, 100 and 250 units are included in `npm.cmd test`.

## Directory and modules

| File | Responsibility |
| --- | --- |
| `index.html`, `src/style.css` | Canvas container, control hints, debug panels and typography |
| `src/main.ts`, `src/scene.ts` | Phaser bootstrap, scene input and module coordination |
| `src/generated-map.ts` | Seeds, section templates and progressability validation of the default map |
| `src/test-map.ts`, `src/long-map.ts`, `src/dense-long-map.ts`, `src/terrain.ts` | Fixed layouts, section terrain state, world-tile/section-tile conversion, durability and passability queries |
| `src/mining-config.ts`, `src/mining.ts` | Test parameters, target locking and attacks settled by actual elapsed time |
| `src/player.ts` | World coordinate conversion, continuous movement, player collision and reset |
| `src/buildings.ts`, `src/enemy-navigation.ts` | Independent building occupancy, wall settlement and paths reused by target and topology version |
| `src/defense-map.ts`, `src/defense-simulation.ts`, `src/defense-debug.ts` | Defense map, off-screen independent simulation and the visual debug entry point |
| `src/expedition-round.ts`, `src/expedition-controls.ts` | Waves, attack pressure, win/loss and the match control panel |
| `src/expedition-economy.ts`, `src/expedition-terrain.ts` | Card draws, resource income, research, advanced dirt layers and the southern approach |
| `src/expedition-biomes.ts`, `src/biome-effects.ts`, `src/fog.ts` | Seeded biomes, biome income and exploration sight radius |
| `src/renderer.ts`, `src/hud.ts` | Terrain textures, grid, the player and debug feedback |
| `tests/terrain.test.mjs`, `tests/mining.test.mjs`, `tests/player.test.mjs` | Terrain, digging timing, collision and reset tests |
| `tests/browser-smoke.mjs` | Regression tests using real Edge keyboard/mouse input and the canvas |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | Dependencies, scripts, type checking and generated-directory ignore rules |

Terrain and collision both read `TerrainMap`. Each valid attack first updates the tile data, then redraws the target tile and refreshes the related debug info. Rendering only prepares canvas textures for the sections covered by the camera. When re-entering a section, the picture is generated from the terrain state retained in the data layer.

## Map interface for P0-B reuse

In `src/terrain.ts`, `TerrainMap` implements a `TerrainReader` that is independent of Phaser and pixel dimensions. Future callers can accept a `TerrainReader` and read the map through the following interface.

| Interface | Behavior |
| --- | --- |
| `columns`, `rows` | Map dimensions |
| `isInside({ col, row })` | Checks whether integer coordinates fall inside the map |
| `getCell({ col, row })` | Returns immutable tile data, or `undefined` when out of bounds |
| `isWalkable({ col, row })` | Returns `true` for empty ground with no building; entities, blocking buildings and out-of-bounds tiles return `false` |
| `getWalkableNeighbors({ col, row })` | Returns adjacent passable tiles ordered north, east, south, west; passing out-of-bounds coordinates yields an empty list |
| `revision` | Increments when terrain is cleared, building blocking changes or the map is reset; it can be used to invalidate path caches |

`TerrainCell` provides `terrain`, `hp`, `maxHp`, `terrainLevel` and `buildingId`. Empty ground has durability `0/0`, and rock has `null` for both durability fields. `TerrainMap.applyDigDamage(from, target, damage)` uniformly validates and applies damage, and `reset()` restores the fixed layout and initial durability. Terrain that only lost durability is still an entity, and the passability `revision` keeps its original value.

---

# 《掘进式生存塔防》可玩原型

完整对局入口为 **`?mode=play`**。首次进入会生成种子。使用 **`?mode=play&seed=12`** 可重现本文的试玩地图。

默认地图为 **40 列 × 96 行**，由三个 32 行的连续段组成。南端有约 8 × 8 格的连通建设空间，越往北越需要自行开挖。普通地形会出现不规则小空洞、裂隙、岩组和短岩脊。坐标写成 `(列, 行)`，左上角为 `(0, 0)`。地形调试模式下，进入北端绿色目标区会显示 **P0-A 测试完成**。

FIX02 未指定种子时随机生成一个 32 位种子，并把它加入地址栏。点击「新开一局」会使用不同的种子；按 `R` 会恢复本局初始地图和耐久。复制当前地址，或使用 `?seed=12` 一类参数，即可在相同生成器版本下重现初始布局。种子可取 0 至 4294967295。无效参数会使用默认种子。

页眉显示实际使用的种子、生成器版本及备用布局状态。地形校验失败时，会显示默认布局的实际种子和原请求种子。

| 地址参数 | 地图 |
| --- | --- |
| `?mode=play` | 完整对局，支持随机地貌、迷雾、建造、科技和胜负 |
| 无 | FIX02 默认地图 |
| `?mode=defense` | FIX02 默认地图与防御调试面板 |
| `?map=fix01` | 原 FIX01 密集长图，24 × 96 |
| `?mode=defense&map=fix01` | 原 FIX01 防御通道，24 × 96 |
| `?map=regression` | 原 A2 回归长图，24 × 96 |
| `?map=single` | 原 A1 单图，24 × 32 |

## 启动和测试

需要 Node.js 22.18+（22.x）或 24+。在本目录运行以下命令，按终端输出的本地地址打开网页。

```powershell
npm.cmd ci --cache .npm-cache
npm.cmd run dev
```

| 输入 | 操作 |
| --- | --- |
| WASD | 连续移动，遇到墙壁会沿可通行方向滑动 |
| 按住鼠标左键 | 瞄准相邻土格开始挖掘，挖通后按住 WASD 可沿移动方向连续挖掘 |
| R | 恢复地形和全部耐久、回到出生点，并清除本轮完成状态 |
| G | 切换网格显示 |

普通地形初始为 5 HP，每次命中扣 1 HP。工具就绪时按下立即命中，此后每隔 125 ms 可再攻击一次。松手或切换目标会保留这段冷却。冷却期间按住合法目标，到期即可命中。工具就绪时连续按住约 0.5 秒可挖空一格。悬停可查看格子类型、坐标和普通地形的剩余耐久，受损地形会逐步变暗。HP 归零后，该格立即可通行。

挖掘开始后会锁定目标。挖通后保持左键，按住 WASD 即可沿移动方向挖下一块相邻土格。斜向移动时，挖掘跟随最近按下的有效方向键。没有移动方向时，也可以继续用鼠标瞄准下一格。松开左键、离开画布、在挖空前走出挖掘距离、窗口失焦、切换标签页或重置都会结束本次挖掘，已扣除的耐久保留至本轮重置。

FIX02 从 `(19, 92)` 出生。先走过南端建设区，从 `(19, 83)` 的土层开始朝北挖掘，或从侧边选择自己的路线。第 63/64 行和第 31/32 行之间是段界。镜头横向约显示 18 格，并随窗口高宽调整纵向范围。返回先前挖掘的位置可检查保留的耐久和空地状态。

## 完整对局

1. 南端出生时有 8 经济、4 张城墙卡、2 张塔卡、1 张经济建筑卡和一座科技设施。选择建筑卡，走到目标空地上下左右或斜角相邻的一格再放置。悬停时，画布描边和面板文字会显示能否建造。按 Esc 退出建筑选择。四座同类一级建筑按上下左右相连时自动合成，最早建成的位置保留，其他三格释放。
2. 敌人从南端入口 `(30, 94)` 进入。普通模式有 2 分钟准备时间，进攻后休整 1 分钟。让塔覆盖来路并安排城墙，塔击杀给 2 经济，经济建筑持续生产。城墙数字显示耐久。
3. 科技设施可以花 3 经济随机制造建筑卡。卡栏短暂显示获得的卡种、数量和库存变化，并保留本局各类获得总数。花 10 经济可研发 Lv.2 工具。科技设施被摧毁后，走近原址可重建，已研发的工具等级保留至本局结束。
4. 地图有平原、高山和湖泊，位置随种子变化。迷雾在玩家和塔的视野内打开。平原的经济建筑产出较快，高山的经济建筑较慢但防御塔射程和视野更大。水域无法穿越或挖开，可沿岸绕行。
5. 南部初级区的土层可用 Lv.1 工具挖掘。第 61–65 行是两级土混合的过渡区，向北进入第 0–60 行的高级主体，二级土占其中可挖土的多数，仍有一级土口袋。二级土有 8 HP，需要 Lv.2 工具。带着 Lv.2 工具挖到北端绿色目标区即获胜。
6. 深入北方会提升后续波次的敌人属性，长时间停留会增加后续波次的数量。玩家生命归零即战败，结局会停止并清理战斗。

`R` 重开同种子对局，恢复全部地形、建筑、卡牌、科技、迷雾及对局状态。点击「新开一局」会换一个种子。复制地址分享本局起始布局。完整对局使用生成器 v4。可挖等级与地貌独立生成，种子分享时也请核对页眉版本。

可在地址追加 `&speed=test` 使用缩短的原型时钟，追加 `&fog=off` 查看全图地形，或追加 `&debug=1` 打开出兵和同时生成压力测试。玩家生命、接触伤害和波次节奏均为 **PROTOTYPE_ONLY** 调试数值。

## P0-B 防御灰盒

在本地地址末尾加 `?mode=defense`。悬停空地后按 **B** 放城墙、**T** 放测试塔、**X** 拆除。选择敌人数量和撞墙伤害，再点「南端生成」。敌人从固定出兵点逐只进入，间隔至少 200 ms。出兵点仍被占用时，其余敌人在队列中等待。面板累计显示本轮请求、实际生成、待生成、存活、镜头内可见和已移除数量。放置的墙和塔都阻挡通行。

FIX02 的出兵点 `(30, 94)` 位于与建设区隔开的南端小空洞。向东挖通后可在附近空地放测试塔，验证敌人与建筑都随镜头正确移动。敌人仍只沿已开通的道路移动。

要复现原来的撞墙与绕路剧本，打开 `?mode=defense&map=fix01`。从 `(11, 92)` 向北走，挖开 `(11, 89)`。在 `(11, 87)` 建墙后，敌人可各撞击一次并消失。挖通 `(12, 87)` 后，敌人优先用空地绕过墙。测试塔可放在 `(12, 90)`，自动攻击射程内的敌人。数字显示墙的剩余 HP，塔击杀和撞墙分别统计。

灰盒默认使用北端测试建筑标记作目标。勾选「玩家接触测试」后，正交直线内测试视距可触发玩家优先和接触事件。城墙初始 50 HP，测试塔和出生批次均为验证参数。50、100、250 只档位用于压力观察。R 恢复地图、建筑和敌人。

```powershell
npm.cmd test                    # 地图耐久、挖掘计时与移动测试
npm.cmd run typecheck           # TypeScript 类型检查
npm.cmd run build               # 类型检查并生成 dist/
npm.cmd run preview             # 本地预览 dist/
npm.cmd run test:browser        # 用已安装的 Edge 验证生产构建，需先 build
npm.cmd run test:browser -- --normal-round # 加测标准波次时长下的完整通关
npm.cmd run test:browser -- --dev # 用已安装的 Edge 验证开发服务器
node tests/browser-stress.mjs   # 用已安装的 Edge 测量生产构建的帧间隔、活跃敌人与寻路
```

Edge 测试会临时启动回环地址上的 Vite，通过真实键鼠和画布像素验证旧图回归、抽卡反馈、近身建造、地层过渡、迷雾、完整对局通关与战败。设置 `P0A_SCREENSHOT` 或 `FIX02_SCREENSHOT` 可指定对应场景截图的本地输出路径。多种子地图约束、地形分布、出生队列和 50、100、250 单位的纯模拟检查包含在 `npm.cmd test` 中。

## 目录和模块

| 文件 | 职责 |
| --- | --- |
| `index.html`、`src/style.css` | 画布容器、操作提示、调试面板和排版 |
| `src/main.ts`、`src/scene.ts` | Phaser 启动、场景输入和模块协调 |
| `src/generated-map.ts` | 种子、分段模板及默认地图的可推进性验证 |
| `src/test-map.ts`、`src/long-map.ts`、`src/dense-long-map.ts`、`src/terrain.ts` | 固定布局、分段地形状态、世界格与段内格互换、耐久与通行查询 |
| `src/mining-config.ts`、`src/mining.ts` | 测试参数、目标锁定和按实际经过时间结算攻击 |
| `src/player.ts` | 世界坐标转换、连续移动、玩家碰撞与重置 |
| `src/buildings.ts`、`src/enemy-navigation.ts` | 独立建筑占用、墙结算和按目标及拓扑版本复用的路径 |
| `src/defense-map.ts`、`src/defense-simulation.ts`、`src/defense-debug.ts` | 防御地图、离屏独立模拟和可视调试入口 |
| `src/expedition-round.ts`、`src/expedition-controls.ts` | 波次、进攻压力、胜负和对局操作面板 |
| `src/expedition-economy.ts`、`src/expedition-terrain.ts` | 抽卡、资源收益、研究、高级土层和南端来路 |
| `src/expedition-biomes.ts`、`src/biome-effects.ts`、`src/fog.ts` | 种子地貌、地貌收益和探索视野 |
| `src/renderer.ts`、`src/hud.ts` | 地形纹理、网格、玩家与调试反馈 |
| `tests/terrain.test.mjs`、`tests/mining.test.mjs`、`tests/player.test.mjs` | 地形、挖掘计时、碰撞和重置测试 |
| `tests/browser-smoke.mjs` | Edge 实际键鼠及画布回归测试 |
| `package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore` | 依赖、脚本、类型检查与生成目录忽略规则 |

地形和碰撞共同读取 `TerrainMap`。每次有效攻击先更新格子数据，再重画目标格及刷新相关调试信息。渲染只为镜头覆盖的段准备画布纹理。重新进入一段时，画面从保留在数据层的地形状态生成。

## 供 P0-B 复用的地图接口

在 `src/terrain.ts` 中，`TerrainMap` 实现了与 Phaser 和像素尺寸无关的 `TerrainReader`。未来的调用方可以接收 `TerrainReader`，通过以下接口读取地图。

| 接口 | 行为 |
| --- | --- |
| `columns`、`rows` | 地图尺寸 |
| `isInside({ col, row })` | 检查整数坐标是否落在图内 |
| `getCell({ col, row })` | 返回不可变格子数据，越界时返回 `undefined` |
| `isWalkable({ col, row })` | 无建筑的空地返回 `true`，实体、阻挡建筑和越界格返回 `false` |
| `getWalkableNeighbors({ col, row })` | 返回按北、东、南、西顺序排列的相邻通行格，传入越界坐标会得到空列表 |
| `revision` | 地形清除、建筑阻挡改变或地图重置时递增，可用于使路径缓存失效 |

`TerrainCell` 提供 `terrain`、`hp`、`maxHp`、`terrainLevel` 和 `buildingId`。空地的耐久为 `0/0`，岩石的两个耐久字段均为 `null`。`TerrainMap.applyDigDamage(from, target, damage)` 统一校验并应用伤害，`reset()` 恢复固定布局和初始耐久。只损失耐久的地形仍是实体，通行 `revision` 保持原值。

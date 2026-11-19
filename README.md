# 《掘进式生存塔防》技术灰盒

默认地图为 24 列 × 96 行，由三个 32 行的连续段组成。每段约七成可挖土格，岩石集中成组。玩家从南端安全空地逐步挖向北端绿色目标区。坐标写成 `(列, 行)`，左上角为 `(0, 0)`。进入目标区后，调试面板显示 **P0-A 测试完成**。`?map=single` 保留 24 × 32 单图，`?map=regression` 保留原 A2 长图回归布局。

## 启动和测试

需要 Node.js 22.18+（22.x）或 24+。在本目录运行以下命令，按终端输出的本地地址打开网页。

```powershell
npm.cmd ci --cache .npm-cache
npm.cmd run dev
```

| 输入 | 操作 |
| --- | --- |
| WASD | 连续移动，遇到墙壁会沿可通行方向滑动 |
| 按住鼠标左键 | 持续挖掘玩家中心格上下左右相邻的一格普通地形 |
| R | 恢复地形和全部耐久、回到出生点，并清除本轮完成状态 |
| G | 切换网格显示 |

普通地形初始为 5 HP，每次命中扣 1 HP。工具就绪时按下立即命中，此后每隔 250 ms 可再攻击一次。松手或切换目标会保留这段冷却。冷却期间按住合法目标，到期即可命中。工具就绪时连续按住约 1 秒可挖空一格。悬停可查看格子类型、坐标和普通地形的剩余耐久，受损地形会逐步变暗。HP 归零后，该格立即可通行。

每次按下会锁定目标。移到画布内的其他格子时，挖掘仍对准原目标。松开左键、离开画布、走出挖掘距离、窗口失焦、切换标签页或重置都会结束本次挖掘。重新挖掘要重新按下左键，地形耐久保留至本轮重置。

长图从 `(11, 92)` 出生。先朝北尝试移动，可以看到 `(11, 91)` 会阻挡玩家。按住左键挖开后，沿第 11 列向北推进可抵达 `(11, 4)`，也可以在侧方开路。镜头跟随玩家，HUD 显示玩家段号及当前绘制段。返回南段时可检查耐久和空地状态，按 `R` 可恢复全部段、出生点和镜头位置。

## P0-B 防御灰盒

在本地地址末尾加 `?mode=defense`。悬停空地后按 **B** 放城墙、**T** 放测试塔、**X** 拆除。选择敌人数量和撞墙伤害，再点「南端生成」。敌人从固定出兵点逐只进入，间隔至少 200 ms。出兵点仍被占用时，其余敌人在队列中等待。面板累计显示本轮请求、实际生成、待生成、存活、镜头内可见和已移除数量。放置的墙和塔都阻挡通行。

从 `(11, 92)` 向北走，挖开入口 `(11, 89)`。在西侧通道 `(11, 87)` 建墙后，敌人可各撞击一次并消失。挖通右侧 `(12, 87)` 后，敌人优先用空地绕过墙。测试塔可放在 `(12, 90)`，自动攻击射程内的敌人。数字显示墙的剩余 HP，塔击杀和撞墙分别统计。

灰盒默认使用北端测试建筑标记作目标。勾选「玩家接触测试」后，正交直线内测试视距可触发玩家优先和接触事件。城墙初始 50 HP，测试塔和出生批次均为验证参数。50、100、250 只档位用于压力观察。R 恢复地图、建筑和敌人。

```powershell
npm.cmd test                    # 地图耐久、挖掘计时与移动测试
npm.cmd run typecheck           # TypeScript 类型检查
npm.cmd run build               # 类型检查并生成 dist/
npm.cmd run preview             # 本地预览 dist/
npm.cmd run test:browser        # 用已安装的 Edge 验证生产构建，需先 build
npm.cmd run test:browser -- --dev # 用已安装的 Edge 验证开发服务器
```

Edge 测试会临时启动回环地址上的 Vite，并通过隔离浏览器验证单图、A2 回归长图、密集长图和防御场景。测试通过键鼠和画布像素检查挖掘、跨段、出兵、绕墙、撞墙和塔射击。设置 `P0A_SCREENSHOT` 可指定一张单图初始界面截图的本地输出路径。地形比例、出生队列和 50、100、250 单位的纯模拟检查包含在 `npm.cmd test` 中。

## 目录和模块

| 文件 | 职责 |
| --- | --- |
| `index.html`、`src/style.css` | 画布容器、操作提示、调试面板和排版 |
| `src/main.ts`、`src/scene.ts` | Phaser 启动、场景输入和模块协调 |
| `src/test-map.ts`、`src/long-map.ts`、`src/dense-long-map.ts`、`src/terrain.ts` | 固定布局、分段地形状态、世界格与段内格互换、耐久与通行查询 |
| `src/mining-config.ts`、`src/mining.ts` | 测试参数、目标锁定和按实际经过时间结算攻击 |
| `src/player.ts` | 世界坐标转换、连续移动、玩家碰撞与重置 |
| `src/buildings.ts`、`src/enemy-navigation.ts` | 独立建筑占用、墙结算和按目标及拓扑版本复用的路径 |
| `src/defense-map.ts`、`src/defense-simulation.ts`、`src/defense-debug.ts` | 防御地图、离屏独立模拟和可视调试入口 |
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

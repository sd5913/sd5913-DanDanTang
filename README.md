# P0-A.1 格子地形与持续挖掘

在固定的 24 列 × 32 行地图上，从南端空地挖向北端绿色目标区。坐标写成 `(列, 行)`，左上角为 `(0, 0)`。进入目标区后，调试面板显示 **P0-A 测试完成**。

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

普通地形初始为 5 HP，每次命中扣 1 HP。按下时立即命中，按住时每隔 250 ms 再命中一次，约 1 秒挖空满耐久的一格。悬停可查看格子类型、坐标和普通地形的剩余耐久，受损地形会逐步变暗。HP 归零后，该格立即可通行。

每次按下会锁定目标。移到画布内的其他格子时，挖掘仍对准原目标。松开左键、离开画布、走出挖掘距离、窗口失焦、切换标签页或重置都会结束本次挖掘。重新挖掘要重新按下左键，地形耐久保留至本轮重置。

从 `(11, 28)` 出生后，可先朝北移动确认 `(11, 27)` 会阻挡玩家。对该格按住左键，等调试面板显示 `HP 3/5` 后松开，移开再返回，确认它仍为 3 HP。重新按住直到格子清除并走入，随后沿第 11 列逐格向北开路，在 `(11, 4)` 检查完成提示。按 `R` 检查地形耐久和出生点已恢复。

```powershell
npm.cmd test                    # 地图耐久、挖掘计时与移动测试
npm.cmd run typecheck           # TypeScript 类型检查
npm.cmd run build               # 类型检查并生成 dist/
npm.cmd run preview             # 本地预览 dist/
npm.cmd run test:browser        # 用已安装的 Edge 验证生产构建，需先 build
npm.cmd run test:browser -- --dev # 用已安装的 Edge 验证开发服务器
```

Edge 测试会临时启动回环地址上的 Vite、打开隔离的无头浏览器，完成后关闭两者。测试通过键鼠输入检查按住、释放、目标锁定、碰撞、重置和北上通关，并读取画布像素验证受损及清除时的变化。设置 `P0A_SCREENSHOT` 可指定一张初始界面截图的本地输出路径。

## 目录和模块

| 文件 | 职责 |
| --- | --- |
| `index.html`、`src/style.css` | 画布容器、操作提示、调试面板和排版 |
| `src/main.ts`、`src/scene.ts` | Phaser 启动、场景输入和模块协调 |
| `src/test-map.ts`、`src/terrain.ts` | 固定布局、二维地形状态、耐久与通行查询、统一伤害入口 |
| `src/mining-config.ts`、`src/mining.ts` | 测试参数、目标锁定和按实际经过时间结算攻击 |
| `src/player.ts` | 世界坐标转换、连续移动、玩家碰撞与重置 |
| `src/renderer.ts`、`src/hud.ts` | 地形纹理、网格、玩家与调试反馈 |
| `tests/terrain.test.mjs`、`tests/mining.test.mjs`、`tests/player.test.mjs` | 地形、挖掘计时、碰撞和重置测试 |
| `tests/browser-smoke.mjs` | Edge 实际键鼠及画布回归测试 |
| `package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore` | 依赖、脚本、类型检查与生成目录忽略规则 |

地形和碰撞共同读取 `TerrainMap`。每次有效攻击先更新格子数据，再重画目标格及刷新相关调试信息。地形用一张画布纹理渲染，初始及重置时整图生成，挖掘期间局部重绘。

## 供 P0-B 复用的地图接口

在 `src/terrain.ts` 中，`TerrainMap` 实现了与 Phaser 和像素尺寸无关的 `TerrainReader`。未来的调用方可以接收 `TerrainReader`，通过以下接口读取地图。

| 接口 | 行为 |
| --- | --- |
| `columns`、`rows` | 地图尺寸 |
| `isInside({ col, row })` | 检查整数坐标是否落在图内 |
| `getCell({ col, row })` | 返回不可变格子数据，越界时返回 `undefined` |
| `isWalkable({ col, row })` | 空地返回 `true`，实体和越界格返回 `false` |
| `getWalkableNeighbors({ col, row })` | 返回按北、东、南、西顺序排列的相邻通行格，传入越界坐标会得到空列表 |
| `revision` | 格子被清除或地图重置时递增，可用于使路径缓存失效 |

`TerrainCell` 提供 `terrain`、`hp`、`maxHp`、`terrainLevel` 和 `buildingId`。空地的耐久为 `0/0`，岩石的两个耐久字段均为 `null`。`TerrainMap.applyDigDamage(from, target, damage)` 统一校验并应用伤害，`reset()` 恢复固定布局和初始耐久。只损失耐久的地形仍是实体，通行 `revision` 保持原值。

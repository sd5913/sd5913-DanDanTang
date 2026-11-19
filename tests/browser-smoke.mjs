import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer, preview } from 'vite';
import { MINING_CONFIG } from '../src/mining-config.ts';
import { TerrainMap } from '../src/terrain.ts';
import { runDenseMapSmoke } from './browser-dense-map.mjs';
import { runDefenseSmoke } from './browser-defense.mjs';
import { runLongMapSmoke } from './browser-long-map.mjs';

const host = '127.0.0.1';
const root = fileURLToPath(new URL('..', import.meta.url));
const development = process.argv.includes('--dev');
const map = new TerrainMap();
const server = development
  ? await createServer({ root, server: { host, port: 0, strictPort: true } })
  : await preview({ root, preview: { host, port: 0, strictPort: true } });

try {
  if (development) await server.listen();

  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object', 'Vite did not bind a TCP port');
  const browser = await chromium.launch({ channel: 'msedge' });

  try {
    const url = `http://${host}:${address.port}`;
    const mode = development ? 'dev' : 'production';
    const dugTiles = await withSmokePage(browser, { width: 1440, height: 1060 },
      (page) => runSingleMapSmoke(page, `${url}/?map=single`));
    console.log(`Edge smoke (${mode}, single map): passed; real rapid clicks and cross-target cooldown, hold/release, target lock, interruption, and ready-tool reset verified; ${dugTiles} tiles mined on the route; no browser errors.`);

    await withSmokePage(browser, { width: 1040, height: 840 },
      (page) => runLongMapSmoke(page, `${url}/?map=regression`));
    console.log(`Edge smoke (${mode}, long map regression): passed; scaled camera input, two seams, offscreen HP and cleared terrain, viewport chunk counts, north goal, and reset across all three chunks verified; no browser errors.`);

    const denseDigs = await withSmokePage(browser, { width: 1040, height: 840 },
      (page) => runDenseMapSmoke(page, url));
    console.log(`Edge smoke (${mode}, dense default): passed; partial damage remained solid, ${denseDigs} dirt tiles cleared along the route to the first seam, actual terrain drawing and reset verified; no browser errors.`);

    await withSmokePage(browser, { width: 1440, height: 1060 }, (page) => runDefenseSmoke(page, `${url}/?mode=defense`));
    console.log(`Edge smoke (${mode}, defense): passed; queued 1/10/50/100 spawn counts, separated enemy drawings, blocked queue retry/reset, no-path recovery, alternate route, wall impacts and breach survivor, tower kill, and offscreen seam crossing verified; no browser errors.`);
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

async function withSmokePage(browser, viewport, run) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    const result = await run(page);
    assert.deepEqual(errors, [], 'Browser console and page must have no errors');
    return result;
  } finally {
    await page.close();
  }
}

async function runSingleMapSmoke(page, url) {
  const board = page.locator('#board canvas');
  const { col, row } = map.spawn;
  const firstDig = { col, row: row - 1 };
  const east = { col: col + 1, row };
  const south = { col, row: row + 1 };

  function coordinates(cell) {
    return `(${cell.col}, ${cell.row})`;
  }

  async function waitForText(selector, ...expected) {
    await page.waitForFunction(
      ({ selector, expected }) => {
        const text = document.querySelector(selector)?.textContent;
        return expected.every((value) => text?.includes(value));
      },
      { selector, expected },
    );
  }

  async function cellCenter(cell) {
    await board.scrollIntoViewIfNeeded();
    const box = await board.boundingBox();
    assert.ok(box, 'Game canvas must be visible');
    return {
      x: box.x + ((cell.col + 0.5) / map.columns) * box.width,
      y: box.y + ((cell.row + 0.5) / map.rows) * box.height,
    };
  }

  async function aimAt(cell) {
    const { x, y } = await cellCenter(cell);
    await page.mouse.move(x, y);
  }

  async function inspectCell(cell, ...details) {
    await aimAt(cell);
    await waitForText('#hover-cell', coordinates(cell), ...details);
  }

  async function samplePixel(column, line) {
    return page.evaluate(async ({ column, line, columns, rows }) => {
      // The HUD updates before Phaser renders the next frame.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.querySelector('#board canvas');
      const x = Math.floor((column / columns) * canvas.width);
      const y = Math.floor((line / rows) * canvas.height);
      const context = canvas.getContext('2d');
      return Array.from(context.getImageData(x, y, 1, 1).data);
    }, { column, line, columns: map.columns, rows: map.rows });
  }

  async function holdKey(key, until) {
    await page.keyboard.down(key);
    try {
      await until();
    } finally {
      await page.keyboard.up(key);
    }
  }

  async function movePlayer(key, cell) {
    await holdKey(key, () => waitForText('#player-cell', coordinates(cell)));
  }

  async function holdMouse(until) {
    await page.mouse.down({ button: 'left' });
    try {
      await until();
    } finally {
      await page.mouse.up({ button: 'left' });
    }
  }

  async function rejectDig(cell, terrain, reason) {
    await inspectCell(cell, terrain);
    await holdMouse(() => waitForText('#dig-result', reason, coordinates(cell)));
  }

  async function dig(cell) {
    await inspectCell(cell, '可挖地形');
    await holdMouse(async () => {
      await waitForText('#dig-result', '挖掘成功', coordinates(cell));
      await waitForText('#hover-cell', '空地', coordinates(cell));
    });
  }

  async function assertHoverHp(cell, hp, message) {
    const hover = await page.locator('#hover-cell').textContent();
    assert.ok(hover.includes(`${coordinates(cell)} | HP ${hp}/5`), `${message}. Hover showed: ${hover}`);
  }

  async function assertHoverHpStays(cell, hp, message) {
    // A negative assertion must leave at least one scheduled attack time behind it.
    await page.waitForTimeout(MINING_CONFIG.attackIntervalMs * 2);
    await assertHoverHp(cell, hp, message);
  }

  async function resetMap() {
    await holdKey('KeyR', () => waitForText('#dig-result', '等待挖掘'));
    await waitForText('#player-cell', coordinates(map.spawn));
  }

  await page.clock.install();
  const response = await page.goto(url);
  assert.equal(response?.status(), 200, 'Game page must load');
  await board.waitFor();
  await waitForText('#player-cell', coordinates(map.spawn));

  const originalGridStatus = await page.locator('#grid-status').textContent();
  assert.match(originalGridStatus, /显示|隐藏/);
  const toggledGridStatus = originalGridStatus.includes('显示') ? '隐藏' : '显示';
  const gridColumn = col;
  const gridRow = row - 2.5;
  const originalGridPixel = await samplePixel(gridColumn, gridRow);
  assert.equal(originalGridPixel[3], 255, 'The map must be fully painted');
  if (process.env.P0A_SCREENSHOT) {
    await page.screenshot({ path: process.env.P0A_SCREENSHOT, fullPage: true });
  }
  await holdKey('KeyG', () => waitForText('#grid-status', toggledGridStatus));
  assert.notDeepEqual(await samplePixel(gridColumn, gridRow), originalGridPixel,
    'G must change the rendered grid line');
  await holdKey('KeyG', () => waitForText('#grid-status', originalGridStatus.trim()));
  assert.deepEqual(await samplePixel(gridColumn, gridRow), originalGridPixel,
    'G must restore the initial rendered grid line');

  await rejectDig({ col: col + 1, row: row - 1 }, '可挖地形', '上下左右相邻');
  await rejectDig({ col, row: row - 2 }, '可挖地形', '上下左右相邻');
  await rejectDig({ col: col - 1, row }, '不可破坏岩石', '岩石不可挖掘');
  await rejectDig(east, '空地', '已经是空地');
  const emptyReference = await samplePixel(col + 1.78, row + 0.35);

  await holdKey('KeyA', () => page.waitForTimeout(800));
  assert.ok((await page.locator('#player-cell').textContent()).includes(coordinates(map.spawn)),
    'Rock must block movement');
  await movePlayer('KeyD', east);
  await movePlayer('KeyS', { col: col + 1, row: row + 1 });
  await resetMap();

  await inspectCell(firstDig, '可挖地形', 'HP 5/5');
  const terrainColumn = firstDig.col + 0.78;
  const terrainRow = firstDig.row + 0.35;
  const originalTerrainPixel = await samplePixel(terrainColumn, terrainRow);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await waitForText('#hover-cell', 'HP 4/5');
  await waitForText('#dig-result', '命中', '-1 HP', coordinates(firstDig));
  assert.notDeepEqual(await samplePixel(terrainColumn, terrainRow), originalTerrainPixel,
    'The first hit must visibly repaint the solid tile');
  await holdKey('KeyW', () => assertHoverHpStays(firstDig, 4, 'Releasing after one hit must stop damage'));
  assert.ok((await page.locator('#player-cell').textContent()).includes(coordinates(map.spawn)),
    'Partially mined terrain must still block movement');

  await resetMap();
  await waitForText('#hover-cell', 'HP 5/5');
  await holdMouse(() => waitForText('#hover-cell', 'HP 3/5'));
  await movePlayer('KeyS', south);
  await movePlayer('KeyW', map.spawn);
  await page.setViewportSize({ width: 1040, height: 840 });
  await inspectCell(east, '空地');
  await inspectCell(firstDig, '可挖地形', 'HP 3/5');

  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 2/5');
    await movePlayer('KeyD', east);
    await assertHoverHpStays(firstDig, 2, 'Moving out of range must stop mining');
    await holdKey('KeyA', async () => {
      await waitForText('#player-cell', coordinates(map.spawn));
      // Settle against the west wall so the player's right edge fits through the cleared tile later.
      await assertHoverHpStays(firstDig, 2, 'Returning to range with the same press must not restart mining');
    });
  });

  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 1/5');
    await page.mouse.move(2, 2);
    await waitForText('#hover-cell', '—');
    await inspectCell(firstDig, '可挖地形', 'HP 1/5');
    await assertHoverHpStays(firstDig, 1, 'Leaving the board must stop mining until a new press');
  });

  await dig(firstDig);
  const dugPixel = await samplePixel(terrainColumn, terrainRow);
  assert.notDeepEqual(dugPixel, originalTerrainPixel, 'Digging must repaint the terrain');
  assert.ok(dugPixel.every((channel, index) => Math.abs(channel - emptyReference[index]) <= 3),
    'The dug tile must render with the empty-terrain color');
  await movePlayer('KeyW', firstDig);
  await resetMap();
  await inspectCell(firstDig, '可挖地形', 'HP 5/5');
  assert.deepEqual(await samplePixel(terrainColumn, terrainRow), originalTerrainPixel,
    'Reset must restore the original terrain drawing');

  // Headless Edge keeps both tabs visible, so send the corresponding lifecycle DOM events.
  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 4/5');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await aimAt(firstDig);
    await assertHoverHpStays(firstDig, 4, 'Window blur must stop an in-progress press');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await assertHoverHpStays(firstDig, 4, 'Window focus must not resume the same press');
  });
  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 3/5');
    await page.evaluate(() => {
      Object.defineProperties(document, {
        hidden: { configurable: true, value: true },
        visibilityState: { configurable: true, value: 'hidden' },
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    try {
      await page.waitForTimeout(MINING_CONFIG.attackIntervalMs * 3);
    } finally {
      await page.evaluate(() => {
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await inspectCell(firstDig, '可挖地形', 'HP 3/5');
    await assertHoverHpStays(firstDig, 3, 'Returning to the tab must not apply missed hits or resume the press');
  });

  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 2/5');
    await resetMap();
    await inspectCell(firstDig, '可挖地形', 'HP 5/5');
    await assertHoverHpStays(firstDig, 5, 'Reset must restore all HP and cancel the ongoing press');
  });

  // Both dirt targets are eligible from this empty cell.
  const lockOrigin = { col: col + 2, row: row - 1 };
  const lockedTarget = { col: lockOrigin.col - 1, row: lockOrigin.row };
  const otherTarget = { col: lockOrigin.col, row: lockOrigin.row - 1 };

  async function moveToLockOrigin() {
    await movePlayer('KeyD', { col: lockOrigin.col + 1, row });
    await movePlayer('KeyA', { col: lockOrigin.col, row });
    await movePlayer('KeyW', lockOrigin);
  }

  await moveToLockOrigin();
  const firstTargetPoint = await cellCenter(lockedTarget);
  const secondTargetPoint = await cellCenter(otherTarget);
  // Use Edge's input events with explicit time advances around the 250 ms cooldown.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 200));
  try {
    await page.mouse.dblclick(firstTargetPoint.x, firstTargetPoint.y);
    await assertHoverHp(lockedTarget, 4, 'A rapid double click must only deal one hit');

    await page.clock.runFor(50);
    await page.mouse.click(secondTargetPoint.x, secondTargetPoint.y);
    await assertHoverHp(otherTarget, 5, 'Switching to another legal tile must respect cooldown');
    await page.clock.runFor(MINING_CONFIG.attackIntervalMs);
    await assertHoverHp(otherTarget, 5, 'Releasing during cooldown must not queue a later hit');

    await page.mouse.click(firstTargetPoint.x, firstTargetPoint.y);
    await assertHoverHp(lockedTarget, 3, 'A click after cooldown must hit immediately');
    await page.clock.runFor(50);
    await page.mouse.move(secondTargetPoint.x, secondTargetPoint.y);
    await holdMouse(async () => {
      await assertHoverHp(otherTarget, 5, 'Holding a new target must wait for cooldown');
      await page.mouse.move(firstTargetPoint.x, firstTargetPoint.y);
      await page.clock.runFor(MINING_CONFIG.attackIntervalMs);
      await assertHoverHp(lockedTarget, 3, 'A waiting hold must not switch to the new pointer position');
      await page.mouse.move(secondTargetPoint.x, secondTargetPoint.y);
      await assertHoverHp(otherTarget, 4, 'The original target must receive one hit when cooldown expires');
    });

    await holdKey('KeyR', () => page.clock.runFor(32));
    const spawnTargetPoint = await cellCenter(firstDig);
    await page.mouse.click(spawnTargetPoint.x, spawnTargetPoint.y);
    await assertHoverHp(firstDig, 4, 'Reset must restore a ready tool and full terrain HP');
    await holdKey('KeyR', () => page.clock.runFor(32));
  } finally {
    await page.clock.resume();
  }

  await moveToLockOrigin();
  await inspectCell(lockedTarget, '可挖地形', 'HP 5/5');
  await holdMouse(async () => {
    await waitForText('#hover-cell', 'HP 4/5');
    await inspectCell(otherTarget, '可挖地形', 'HP 5/5');
    await waitForText('#dig-result', '挖掘成功', coordinates(lockedTarget));
    await assertHoverHpStays(otherTarget, 5, 'Moving the pointer must not retarget, even after the original tile clears');
  });
  await inspectCell(lockedTarget, '空地');
  await resetMap();

  const dugCells = [];
  let nextRow = row;
  do {
    nextRow -= 1;
    const nextCell = { col, row: nextRow };
    const terrain = map.getCell(nextCell)?.terrain;
    if (terrain === 'dirt') {
      await dig(nextCell);
      dugCells.push(nextCell);
    } else {
      assert.equal(terrain, 'empty', `Expected a diggable route at ${coordinates(nextCell)}`);
    }
    await movePlayer('KeyW', nextCell);
  } while (!map.isGoal({ col, row: nextRow }));

  await waitForText('#goal-status', 'P0-A 测试完成');
  await resetMap();
  assert.doesNotMatch(await page.locator('#goal-status').textContent(), /P0-A 测试完成/);
  for (const cell of dugCells) await inspectCell(cell, '可挖地形', 'HP 5/5');

  return dugCells.length;
}

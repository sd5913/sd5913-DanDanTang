import type Phaser from "phaser";
import { PLAYER_HALF_SIZE, TILE_SIZE } from "./player.ts";
import type { Point } from "./player.ts";
import type { GridPosition, TerrainCell, TerrainMap, TerrainType } from "./terrain.ts";

export class GridRenderer {
  private readonly texture: Phaser.Textures.CanvasTexture;
  private readonly grid: Phaser.GameObjects.Graphics;
  private readonly cursor: Phaser.GameObjects.Rectangle;
  private readonly player: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene, map: TerrainMap) {
    const width = map.columns * TILE_SIZE;
    const height = map.rows * TILE_SIZE;
    const texture = scene.textures.createCanvas("terrain", width, height);
    if (!texture) throw new Error("Could not create the terrain canvas");
    this.texture = texture;
    scene.add.image(0, 0, texture.key).setOrigin(0);
    this.redraw(map);

    this.grid = scene.add.graphics().lineStyle(1, 0xcbd6d6, 0.32);
    for (let x = TILE_SIZE; x < width; x += TILE_SIZE) this.grid.lineBetween(x + 0.5, 0, x + 0.5, height);
    for (let y = TILE_SIZE; y < height; y += TILE_SIZE) this.grid.lineBetween(0, y + 0.5, width, y + 0.5);

    this.cursor = scene.add.rectangle(0, 0, TILE_SIZE - 2, TILE_SIZE - 2, 0xffffff, 0.09)
      .setOrigin(0)
      .setStrokeStyle(1, 0xf1f5e4)
      .setVisible(false);

    const playerSize = PLAYER_HALF_SIZE * 2;
    const border = scene.add.rectangle(0, 0, playerSize, playerSize, 0x102f31);
    const body = scene.add.rectangle(0, 0, playerSize - 2, playerSize - 2, 0xcefff0);
    this.player = scene.add.container(0, 0, [border, body]);
  }

  redraw(map: TerrainMap): void {
    for (let row = 0; row < map.rows; row += 1) {
      for (let col = 0; col < map.columns; col += 1) this.paintCell(map, { col, row });
    }
    this.texture.refresh();
  }

  redrawCell(map: TerrainMap, position: GridPosition): void {
    this.paintCell(map, position);
    this.texture.refresh();
  }

  private paintCell(map: TerrainMap, cell: GridPosition): void {
    const state = map.getCell(cell);
    if (!state) return;
    const x = cell.col * TILE_SIZE;
    const y = cell.row * TILE_SIZE;
    const context = this.texture.getContext();
    const variant = (cell.col * 5 + cell.row * 3) % 4;
    if (map.isGoal(cell)) {
      paintGoal(context, map, cell, x, y);
    } else {
      paintTerrain(context, state, x, y, variant);
    }
  }

  movePlayer({ x, y }: Point): void {
    this.player.setPosition(x, y);
  }

  showHover(cell: GridPosition | null): void {
    this.cursor.setVisible(cell !== null);
    if (cell) this.cursor.setPosition(cell.col * TILE_SIZE + 1, cell.row * TILE_SIZE + 1);
  }

  showGrid(visible: boolean): void {
    this.grid.setVisible(visible);
  }
}

const TILE_COLORS: Record<TerrainType, readonly string[]> = {
  empty: ["#233238", "#243339", "#25343a", "#243339"],
  dirt: ["#966649", "#9c6c4d", "#926448", "#98694b"],
  rock: ["#43505c", "#485562", "#44515d", "#46535f"],
};

function paintTerrain(context: CanvasRenderingContext2D, cell: TerrainCell, x: number, y: number, variant: number): void {
  const { terrain } = cell;
  context.fillStyle = TILE_COLORS[terrain][variant];
  context.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  if (terrain === "empty") return;

  context.fillStyle = terrain === "dirt" ? "#af805b" : "#566572";
  context.fillRect(x, y, TILE_SIZE, 2);
  context.fillRect(x, y + 2, 2, TILE_SIZE - 2);
  context.fillStyle = terrain === "dirt" ? "#70472f" : "#323f4b";
  context.fillRect(x + 2, y + TILE_SIZE - 2, TILE_SIZE - 2, 2);
  context.fillRect(x + TILE_SIZE - 2, y + 2, 2, TILE_SIZE - 4);

  if (terrain === "dirt") {
    context.fillStyle = "#bc8a64";
    context.fillRect(x + 5 + variant * 2, y + 6 + variant, 4, 2);
    context.fillStyle = "#7e5138";
    context.fillRect(x + 13 - variant, y + 15 - variant, 3, 2);
    if (cell.hp < cell.maxHp) {
      const damageRatio = 1 - cell.hp / cell.maxHp;
      context.fillStyle = `rgba(44, 26, 21, ${damageRatio * 0.55})`;
      context.fillRect(x, y, TILE_SIZE, TILE_SIZE);
    }
  } else {
    context.strokeStyle = "#687985";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x + 6, y + 16 + variant);
    context.lineTo(x + 15 + variant, y + 7);
    context.stroke();
  }
}

function paintGoal(context: CanvasRenderingContext2D, map: TerrainMap, { col, row }: GridPosition, x: number, y: number): void {
  context.fillStyle = "#347569";
  context.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  context.fillStyle = "#8de6ca";
  context.fillRect(x + 11, y + 11, 2, 2);
  if (!map.isGoal({ col: col - 1, row })) context.fillRect(x, y, 2, TILE_SIZE);
  if (!map.isGoal({ col: col + 1, row })) context.fillRect(x + TILE_SIZE - 2, y, 2, TILE_SIZE);
  if (!map.isGoal({ col, row: row - 1 })) context.fillRect(x, y, TILE_SIZE, 2);
  if (!map.isGoal({ col, row: row + 1 })) context.fillRect(x, y + TILE_SIZE - 2, TILE_SIZE, 2);
}

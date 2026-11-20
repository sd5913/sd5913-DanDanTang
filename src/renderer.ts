import type Phaser from "phaser";
import type { PlacementPreview } from "./build-placement.ts";
import { PLAYER_HALF_SIZE, TILE_SIZE } from "./player.ts";
import type { Point } from "./player.ts";
import { CHUNK_ROWS } from "./terrain.ts";
import type { GridPosition, TerrainCell, TerrainMap, TerrainType } from "./terrain.ts";

const CHUNK_HEIGHT = CHUNK_ROWS * TILE_SIZE;

interface ChunkSlot {
  readonly texture: Phaser.Textures.CanvasTexture;
  readonly image: Phaser.GameObjects.Image;
  readonly grid: Phaser.GameObjects.Graphics;
}

export class GridRenderer {
  readonly followTarget: Phaser.GameObjects.Container;
  private readonly scene: Phaser.Scene;
  private readonly terrainLayer: Phaser.GameObjects.Layer;
  private readonly gridLayer: Phaser.GameObjects.Layer;
  private readonly cursor: Phaser.GameObjects.Rectangle;
  private readonly buildCursor: Phaser.GameObjects.Rectangle;
  private readonly resident = new Map<number, ChunkSlot>();
  private readonly spare: ChunkSlot[] = [];
  private visibleRows: readonly number[] = [];
  private firstVisible = -1;
  private endVisible = -1;

  constructor(scene: Phaser.Scene, map: TerrainMap) {
    this.scene = scene;
    // Fixed layers preserve draw order when the camera loads a chunk during pre-render.
    this.terrainLayer = scene.add.layer().setDepth(0);
    this.gridLayer = scene.add.layer().setDepth(1);

    this.cursor = scene.add.rectangle(0, 0, TILE_SIZE - 2, TILE_SIZE - 2, 0xffffff, 0.09)
      .setOrigin(0)
      .setStrokeStyle(1, 0xf1f5e4)
      .setDepth(2)
      .setVisible(false);

    this.buildCursor = scene.add.rectangle(0, 0, TILE_SIZE - 2, TILE_SIZE - 2)
      .setOrigin(0)
      .setDepth(4.5)
      .setVisible(false);

    const playerSize = PLAYER_HALF_SIZE * 2;
    const border = scene.add.rectangle(0, 0, playerSize, playerSize, 0x102f31);
    const body = scene.add.rectangle(0, 0, playerSize - 2, playerSize - 2, 0xcefff0);
    this.followTarget = scene.add.container(0, 0, [border, body]).setDepth(3);

    const worldHeight = map.rows * TILE_SIZE;
    const spawnY = (map.spawn.row + 0.5) * TILE_SIZE;
    const top = Math.max(0, Math.min(spawnY - CHUNK_HEIGHT / 2, worldHeight - CHUNK_HEIGHT));
    this.syncViewport(map, top, top + CHUNK_HEIGHT);

    scene.events.once("shutdown", () => {
      for (const slot of this.resident.values()) scene.textures.remove(slot.texture.key);
      for (const slot of this.spare) scene.textures.remove(slot.texture.key);
    });
  }

  syncViewport(map: TerrainMap, worldTop: number, worldBottom: number): readonly number[] {
    const first = Math.max(0, Math.floor(worldTop / CHUNK_HEIGHT));
    const end = Math.min(Math.ceil(map.rows / CHUNK_ROWS), Math.ceil(worldBottom / CHUNK_HEIGHT));
    if (first === this.firstVisible && end === this.endVisible) return this.visibleRows;

    for (const [row, slot] of this.resident) {
      if (row >= first && row < end) continue;
      slot.image.setVisible(false);
      slot.grid.setVisible(false);
      this.resident.delete(row);
      this.spare.push(slot);
    }

    const width = map.columns * TILE_SIZE;
    const visibleRows = [];
    for (let row = first; row < end; row += 1) {
      visibleRows.push(row);
      if (this.resident.has(row)) continue;

      const slot = this.spare.pop() ?? this.createSlot(width);
      slot.image.setY(row * CHUNK_HEIGHT).setVisible(true);
      slot.grid.setY(row * CHUNK_HEIGHT).setVisible(true);
      this.resident.set(row, slot);
      this.paintChunk(slot, map, row);
      this.paintGrid(slot.grid, map, row);
    }

    this.firstVisible = first;
    this.endVisible = end;
    this.visibleRows = visibleRows;
    return visibleRows;
  }

  redraw(map: TerrainMap): void {
    for (const [row, slot] of this.resident) this.paintChunk(slot, map, row);
  }

  redrawCell(map: TerrainMap, position: GridPosition): void {
    const chunkRow = Math.floor(position.row / CHUNK_ROWS);
    const slot = this.resident.get(chunkRow);
    if (!slot) return;
    this.paintCell(slot.texture.getContext(), map, position, chunkRow);
    slot.texture.refresh();
  }

  private createSlot(width: number): ChunkSlot {
    const { scene } = this;
    const index = this.resident.size + this.spare.length;
    const key = `terrain-${scene.sys.settings.key}-${index}`;
    const texture = scene.textures.createCanvas(key, width, CHUNK_HEIGHT);
    if (!texture) throw new Error("Could not create a terrain chunk canvas");

    const image = scene.add.image(0, 0, key).setOrigin(0);
    const grid = scene.add.graphics();
    this.terrainLayer.add(image);
    this.gridLayer.add(grid);
    return { texture, image, grid };
  }

  private paintChunk(slot: ChunkSlot, map: TerrainMap, chunkRow: number): void {
    const context = slot.texture.getContext();
    const firstRow = chunkRow * CHUNK_ROWS;
    const endRow = Math.min(firstRow + CHUNK_ROWS, map.rows);
    // A reused slot can have fewer than CHUNK_ROWS tiles at the end of the map.
    if (endRow - firstRow < CHUNK_ROWS) context.clearRect(0, 0, slot.texture.width, CHUNK_HEIGHT);
    for (let row = firstRow; row < endRow; row += 1) {
      for (let col = 0; col < map.columns; col += 1) this.paintCell(context, map, { col, row }, chunkRow);
    }
    slot.texture.refresh();
  }

  private paintGrid(grid: Phaser.GameObjects.Graphics, map: TerrainMap, chunkRow: number): void {
    const width = map.columns * TILE_SIZE;
    const height = Math.min(CHUNK_ROWS, map.rows - chunkRow * CHUNK_ROWS) * TILE_SIZE;
    grid.clear().lineStyle(1, 0xcbd6d6, 0.32);
    for (let x = TILE_SIZE; x < width; x += TILE_SIZE) grid.lineBetween(x + 0.5, 0, x + 0.5, height);
    // Each shared boundary belongs to the chunk just below it.
    for (let y = chunkRow === 0 ? TILE_SIZE : 0; y < height; y += TILE_SIZE) {
      grid.lineBetween(0, y + 0.5, width, y + 0.5);
    }
  }

  private paintCell(context: CanvasRenderingContext2D, map: TerrainMap, cell: GridPosition, chunkRow: number): void {
    const state = map.getCell(cell);
    if (!state) return;
    const x = cell.col * TILE_SIZE;
    const y = (cell.row - chunkRow * CHUNK_ROWS) * TILE_SIZE;
    const variant = (cell.col * 5 + cell.row * 3) % 4;
    if (map.isGoal(cell)) {
      paintGoal(context, map, cell, x, y);
    } else {
      paintTerrain(context, state, x, y, variant);
    }
  }

  movePlayer({ x, y }: Point): void {
    this.followTarget.setPosition(x, y);
  }

  showHover(cell: GridPosition | null): void {
    this.cursor.setVisible(cell !== null);
    if (cell) this.cursor.setPosition(cell.col * TILE_SIZE + 1, cell.row * TILE_SIZE + 1);
  }

  showBuildPreview(cell: GridPosition | null, state?: PlacementPreview): void {
    this.buildCursor.setVisible(cell !== null && state !== undefined);
    if (!cell || !state) return;
    const color = state === "valid" ? 0x80dfb5 : 0xff928b;
    this.buildCursor.setPosition(cell.col * TILE_SIZE + 1, cell.row * TILE_SIZE + 1)
      .setFillStyle(color, 0.15)
      .setStrokeStyle(2, color);
  }

  showGrid(visible: boolean): void {
    this.gridLayer.setVisible(visible);
  }
}

const TILE_COLORS: Record<TerrainType, readonly string[]> = {
  empty: ["#233238", "#243339", "#25343a", "#243339"],
  dirt: ["#966649", "#9c6c4d", "#926448", "#98694b"],
  rock: ["#43505c", "#485562", "#44515d", "#46535f"],
  water: ["#235264", "#285a6c", "#25566a", "#23556b"],
};
const ADVANCED_DIRT_COLORS = ["#765c6b", "#7d6172", "#79596b", "#806477"];

function paintTerrain(context: CanvasRenderingContext2D, cell: TerrainCell, x: number, y: number, variant: number): void {
  const { terrain } = cell;
  const colors = terrain === "dirt" && cell.terrainLevel === 2 ? ADVANCED_DIRT_COLORS : TILE_COLORS[terrain];
  context.fillStyle = colors[variant];
  context.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  if (terrain === "empty") return;
  if (terrain === "water") {
    context.fillStyle = "#3a7890";
    context.fillRect(x + 4 + variant, y + 7, 8, 1);
    context.fillRect(x + 11 - variant, y + 17, 9, 1);
    return;
  }

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

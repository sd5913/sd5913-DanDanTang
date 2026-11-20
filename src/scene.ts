import Phaser from "phaser";
import { BIOME_PROTOTYPE } from "./biome-effects.ts";
import { DefenseDebug } from "./defense-debug.ts";
import type { DefenseScenario } from "./defense-debug.ts";
import { ExplorationFog } from "./fog.ts";
import { FogRenderer } from "./fog-renderer.ts";
import { DebugHud } from "./hud.ts";
import { MINING_CONFIG } from "./mining-config.ts";
import { MiningSession } from "./mining.ts";
import type { MiningStrike } from "./mining.ts";
import { Player, TILE_SIZE, worldToCell } from "./player.ts";
import { GridRenderer } from "./renderer.ts";
import { TerrainMap } from "./terrain.ts";
import type { GridPosition, TerrainOptions } from "./terrain.ts";

const VISIBLE_COLUMNS = 18;
const CAMERA_FOLLOW = 0.24;
const NORTH_LOOK_AHEAD = 0.15;

export class GridScene extends Phaser.Scene {
  private readonly terrain: TerrainMap;
  private readonly player: Player;
  private readonly mining: MiningSession;
  private readonly defenseOptions?: DefenseScenario;
  private readonly wide: boolean;
  private readonly fog?: ExplorationFog;
  private fogRenderer?: FogRenderer;
  private fogCell?: GridPosition;
  private fogTerrainRevision = -1;
  private readonly previousView = new Phaser.Geom.Rectangle();
  private readonly projectedView = new Phaser.Geom.Rectangle();
  private readonly topLeft = new Phaser.Math.Vector2();
  private readonly bottomRight = new Phaser.Math.Vector2();
  private readonly worldPointer = new Phaser.Math.Vector2();
  private defense?: DefenseDebug;
  private boardRenderer!: GridRenderer;
  private hud!: DebugHud;
  private keys!: Record<"W" | "A" | "S" | "D" | "R" | "G", Phaser.Input.Keyboard.Key>;
  private hovered: GridPosition | null = null;
  private gridVisible = true;
  private reachedGoal = false;
  private refreshPointerAfterResize = false;

  constructor(
    layout?: readonly string[], defenseOptions?: DefenseScenario, wide = false, biomes?: TerrainOptions["biomes"],
  ) {
    super("grid");
    this.terrain = new TerrainMap(layout, { autoMerge: wide ? undefined : false, biomes });
    this.player = new Player(this.terrain.spawn);
    if (defenseOptions?.fogEnabled) this.fog = new ExplorationFog(this.terrain.columns, this.terrain.rows);
    this.mining = new MiningSession(this.terrain, MINING_CONFIG, () => this.defense?.toolLevel ?? 1);
    this.defenseOptions = defenseOptions;
    this.wide = wide;
  }

  create(): void {
    this.boardRenderer = new GridRenderer(this, this.terrain);
    if (this.fog) this.fogRenderer = new FogRenderer(this, this.fog);
    this.hud = new DebugHud();
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("Keyboard input is unavailable");
    this.keys = keyboard.addKeys("W,A,S,D,R,G", false) as typeof this.keys;
    if (this.defenseOptions) this.defense = new DefenseDebug(this, this.terrain, this.player, this.defenseOptions);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.inspectPointer, this);
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.beginMining, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.releasePointer, this);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.releasePointer, this);
    this.input.on(Phaser.Input.Events.GAME_OUT, this.leaveBoard, this);
    this.game.events.on(Phaser.Core.Events.BLUR, this.stopMining, this);
    this.game.events.on(Phaser.Core.Events.PAUSE, this.stopMining, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);
    this.updatePlayer();

    const camera = this.cameras.main;
    camera.on(Phaser.Cameras.Scene2D.Events.FOLLOW_UPDATE, this.syncViewport, this);
    if (this.wide) {
      this.resizeWideCamera();
      this.scale.on(Phaser.Scale.Events.RESIZE, this.resizeWideCamera, this);
    } else {
      camera.setBounds(0, 0, this.terrain.columns * TILE_SIZE, this.terrain.rows * TILE_SIZE);
      camera.startFollow(this.boardRenderer.followTarget, true, 1, 1);
    }
  }

  update(_time: number, delta: number): void {
    if (Phaser.Input.Keyboard.JustDown(this.keys.G)) {
      this.gridVisible = !this.gridVisible;
      this.boardRenderer.showGrid(this.gridVisible);
      this.hud.showGrid(this.gridVisible);
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.R)) {
      this.reset();
      return;
    }

    if (this.defense?.roundEnded) {
      this.stopMining();
      return;
    }

    const horizontal = Number(this.keys.D.isDown) - Number(this.keys.A.isDown);
    const vertical = Number(this.keys.S.isDown) - Number(this.keys.W.isDown);
    if (horizontal || vertical) {
      this.player.move(horizontal, vertical, delta, this.terrain);
      this.updatePlayer();
    }
    this.defense?.update(delta, this.hovered);

    if (this.defense?.roundEnded || !this.input.mousePointer.leftButtonDown()
      || !this.input.isOver || document.hidden || !document.hasFocus()) {
      this.stopMining();
      return;
    }

    const strike = this.mining.update(this.player.cell, performance.now(), this.hovered);
    if (strike) this.showStrike(strike);
  }

  private inspectPointer(pointer: Phaser.Input.Pointer): void {
    const cell = this.pointerCell(pointer);
    this.updateHover(cell && this.terrain.isInside(cell) ? cell : null);
  }

  private pointerCell(pointer: Phaser.Input.Pointer): GridPosition | null {
    const camera = this.cameras.main;
    let { x, y } = pointer;
    if (this.wide && pointer.event instanceof MouseEvent) {
      const bounds = this.scale.canvasBounds;
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      const { clientX, clientY } = pointer.event;
      x = (clientX + window.scrollX - bounds.left) * camera.width / bounds.width;
      y = (clientY + window.scrollY - bounds.top) * camera.height / bounds.height;
      if (x < 0 || x >= camera.width || y < 0 || y >= camera.height) return null;
    }
    const point = camera.getWorldPoint(x, y, this.worldPointer);
    return worldToCell(point.x, point.y);
  }

  private resizeWideCamera(): void {
    const { width, height } = this.game.canvas;
    if (width <= 0 || height <= 0) return;

    const worldWidth = this.terrain.columns * TILE_SIZE;
    const worldHeight = this.terrain.rows * TILE_SIZE;
    const zoom = Math.max(width / (VISIBLE_COLUMNS * TILE_SIZE), width / worldWidth, height / worldHeight);
    const camera = this.cameras.main;
    camera.setSize(width, height).setZoom(zoom);

    // Phaser rounds the screen center on odd-sized viewports. Compensate in its
    // bounds so the true projection still meets the map edge when clamped.
    const boundX = (Math.round(width / 2) - width / 2) / zoom;
    const boundY = (Math.round(height / 2) - height / 2) / zoom;
    camera.setBounds(boundX, boundY, worldWidth, worldHeight);
    camera.startFollow(this.boardRenderer.followTarget, true, CAMERA_FOLLOW, CAMERA_FOLLOW,
      0, camera.displayHeight * NORTH_LOOK_AHEAD);
    this.refreshPointerAfterResize = true;
  }

  private viewBounds(): Phaser.Geom.Rectangle {
    const camera = this.cameras.main;
    if (!this.wide) return camera.worldView;

    // Phaser's worldView rounds to whole world pixels. Use the exact matrix
    // applied in this render for seams and for the debug picking coordinates.
    camera.getWorldPoint(camera.x, camera.y, this.topLeft);
    camera.getWorldPoint(camera.x + camera.width, camera.y + camera.height, this.bottomRight);
    return this.projectedView.setTo(this.topLeft.x, this.topLeft.y,
      this.bottomRight.x - this.topLeft.x, this.bottomRight.y - this.topLeft.y);
  }

  private syncViewport(): void {
    const view = this.viewBounds();
    const chunks = this.boardRenderer.syncViewport(this.terrain, view.top, view.bottom);
    this.hud.showViewport(chunks, view);
    const fogChanged = this.updateFog();
    if (fogChanged || !Phaser.Geom.Rectangle.Equals(view, this.previousView) || this.refreshPointerAfterResize) {
      this.previousView.setTo(view.x, view.y, view.width, view.height);
      this.refreshPointerAfterResize = false;
      if (this.hovered || (this.wide && this.input.isOver)) this.inspectPointer(this.input.mousePointer);
    }
    this.defense?.render(view, this.hovered, this.isVisible);
    this.fogRenderer?.render(view);
  }

  private updateFog(): boolean {
    if (!this.fog) return false;
    const cell = this.player.cell;
    const unchangedPosition = this.fogCell?.col === cell.col && this.fogCell.row === cell.row;
    if (unchangedPosition && this.fogTerrainRevision === this.terrain.revision) return false;
    this.fogCell = cell;
    this.fogTerrainRevision = this.terrain.revision;
    const towers = [];
    for (const building of this.terrain.getBuildings()) {
      if (building.kind !== "tower") continue;
      const extra = this.terrain.getBiome(building.cell) === "highland" ? BIOME_PROTOTYPE.highlandTowerVisionBonus : 0;
      towers.push({ cell: building.cell, radius: BIOME_PROTOTYPE.towerVision + extra });
    }
    this.fog.reveal(cell, towers);
    return true;
  }

  private readonly isVisible = (cell: GridPosition): boolean => !this.fog || this.fog.visibility(cell) === "visible";

  private updateHover(cell: GridPosition | null): void {
    this.hovered = cell;
    this.boardRenderer.showHover(cell && this.isVisible(cell) ? cell : null);
    this.hud.showHover(cell, cell ? this.terrain.getCell(cell) : undefined, cell ? this.fog?.visibility(cell) : undefined);
  }

  private beginMining(pointer: Phaser.Input.Pointer): void {
    if (this.defense?.roundEnded || pointer.button !== 0 || !pointer.leftButtonDown()
      || document.hidden || !document.hasFocus() || this.game.isPaused) return;
    const target = this.pointerCell(pointer);
    if (!target) return;
    if (this.defense?.placeSelectedCard(target, this.isVisible(target))) {
      this.stopMining();
      return;
    }
    const strike = this.mining.begin(this.player.cell, target, performance.now());
    if (strike) this.showStrike(strike);
    this.inspectPointer(pointer);
  }

  private releasePointer(pointer: Phaser.Input.Pointer): void {
    if (!pointer.leftButtonDown()) this.stopMining();
  }

  private leaveBoard(): void {
    this.stopMining();
    this.updateHover(null);
  }

  private stopMining(): void {
    this.mining.stop();
  }

  private shutdown(): void {
    this.stopMining();
    this.game.events.off(Phaser.Core.Events.BLUR, this.stopMining, this);
    this.game.events.off(Phaser.Core.Events.PAUSE, this.stopMining, this);
    this.cameras.main?.off(Phaser.Cameras.Scene2D.Events.FOLLOW_UPDATE, this.syncViewport, this);
    if (this.wide) this.scale.off(Phaser.Scale.Events.RESIZE, this.resizeWideCamera, this);
  }

  private showStrike(strike: MiningStrike): void {
    const { target, result } = strike;
    if (result.effective) {
      this.boardRenderer.redrawCell(this.terrain, target);
      if (this.hovered?.col === target.col && this.hovered.row === target.row) {
        this.updateHover(target);
      }
    }
    this.hud.showDig(strike);
  }

  private updatePlayer(): void {
    const cell = this.player.cell;
    this.boardRenderer.movePlayer(this.player.position);
    this.hud.showPlayer(cell, this.terrain.worldToChunk(cell)?.chunk);
    this.defense?.showBiome(this.terrain.getBiome(cell) ?? "ordinary");
    if (!this.reachedGoal && this.terrain.isGoal(cell) && (this.defense?.reachGoal() ?? true)) {
      this.reachedGoal = true;
      this.hud.showGoal(true, this.defenseOptions?.worldSeed !== undefined);
    }
  }

  private reset(): void {
    this.mining.reset();
    this.terrain.reset();
    this.player.reset(this.terrain.spawn);
    this.defense?.reset();
    this.fog?.reset();
    this.fogTerrainRevision = -1;
    this.reachedGoal = false;
    this.boardRenderer.redraw(this.terrain);
    this.updatePlayer();
    if (this.wide) {
      const camera = this.cameras.main;
      const { x, y } = this.player.position;
      camera.centerOn(x, y - camera.followOffset.y);
    }
    this.updateHover(this.hovered);
    this.hud.showDig();
    this.hud.showGoal(false, this.defenseOptions?.worldSeed !== undefined);
  }
}

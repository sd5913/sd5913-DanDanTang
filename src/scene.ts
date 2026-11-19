import Phaser from "phaser";
import { DefenseDebug } from "./defense-debug.ts";
import { DebugHud } from "./hud.ts";
import { MiningSession } from "./mining.ts";
import type { MiningStrike } from "./mining.ts";
import { Player, TILE_SIZE, worldToCell } from "./player.ts";
import { GridRenderer } from "./renderer.ts";
import { TerrainMap } from "./terrain.ts";
import type { GridPosition } from "./terrain.ts";

export class GridScene extends Phaser.Scene {
  private readonly terrain: TerrainMap;
  private readonly player: Player;
  private readonly mining: MiningSession;
  private readonly defenseEnabled: boolean;
  private defense?: DefenseDebug;
  private boardRenderer!: GridRenderer;
  private hud!: DebugHud;
  private keys!: Record<"W" | "A" | "S" | "D" | "R" | "G", Phaser.Input.Keyboard.Key>;
  private hovered: GridPosition | null = null;
  private gridVisible = true;
  private reachedGoal = false;
  private lastViewTop = Number.NaN;

  constructor(layout?: readonly string[], defenseEnabled = false) {
    super("grid");
    this.terrain = new TerrainMap(layout);
    this.player = new Player(this.terrain.spawn);
    this.mining = new MiningSession(this.terrain);
    this.defenseEnabled = defenseEnabled;
  }

  create(): void {
    this.boardRenderer = new GridRenderer(this, this.terrain);
    this.hud = new DebugHud();
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("Keyboard input is unavailable");
    this.keys = keyboard.addKeys("W,A,S,D,R,G", false) as typeof this.keys;
    if (this.defenseEnabled) this.defense = new DefenseDebug(this, this.terrain, this.player);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.inspectPointer, this);
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.beginMining, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.releasePointer, this);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.releasePointer, this);
    this.input.on(Phaser.Input.Events.GAME_OUT, this.leaveBoard, this);
    this.game.events.on(Phaser.Core.Events.BLUR, this.stopMining, this);
    this.game.events.on(Phaser.Core.Events.PAUSE, this.stopMining, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdownMining, this);
    this.updatePlayer();

    const camera = this.cameras.main;
    camera.setBounds(0, 0, this.terrain.columns * TILE_SIZE, this.terrain.rows * TILE_SIZE);
    camera.on(Phaser.Cameras.Scene2D.Events.FOLLOW_UPDATE, this.syncViewport, this);
    camera.startFollow(this.boardRenderer.followTarget, true, 1, 1);
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

    const horizontal = Number(this.keys.D.isDown) - Number(this.keys.A.isDown);
    const vertical = Number(this.keys.S.isDown) - Number(this.keys.W.isDown);
    if (horizontal || vertical) {
      this.player.move(horizontal, vertical, delta, this.terrain);
      this.updatePlayer();
    }
    this.defense?.update(delta, this.hovered);

    if (!this.input.mousePointer.leftButtonDown() || !this.input.isOver || document.hidden || !document.hasFocus()) {
      this.stopMining();
      return;
    }

    const strike = this.mining.update(this.player.cell, performance.now());
    if (strike) this.showStrike(strike);
  }

  private inspectPointer(pointer: Phaser.Input.Pointer): void {
    const cell = this.pointerCell(pointer);
    this.updateHover(this.terrain.isInside(cell) ? cell : null);
  }

  private pointerCell(pointer: Phaser.Input.Pointer): GridPosition {
    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return worldToCell(point.x, point.y);
  }

  private syncViewport(): void {
    const view = this.cameras.main.worldView;
    const { top, bottom } = view;
    const chunks = this.boardRenderer.syncViewport(this.terrain, top, bottom);
    this.hud.showViewport(chunks, top);
    if (top !== this.lastViewTop) {
      this.lastViewTop = top;
      if (this.hovered) this.inspectPointer(this.input.mousePointer);
    }
    this.defense?.render(view, this.hovered);
  }

  private updateHover(cell: GridPosition | null): void {
    this.hovered = cell;
    this.boardRenderer.showHover(cell);
    this.hud.showHover(cell, cell ? this.terrain.getCell(cell) : undefined);
  }

  private beginMining(pointer: Phaser.Input.Pointer): void {
    if (pointer.button !== 0 || !pointer.leftButtonDown() || document.hidden || !document.hasFocus() || this.game.isPaused) return;
    const target = this.pointerCell(pointer);
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

  private shutdownMining(): void {
    this.stopMining();
    this.game.events.off(Phaser.Core.Events.BLUR, this.stopMining, this);
    this.game.events.off(Phaser.Core.Events.PAUSE, this.stopMining, this);
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
    if (!this.reachedGoal && this.terrain.isGoal(cell)) {
      this.reachedGoal = true;
      this.hud.showGoal(true);
    }
  }

  private reset(): void {
    this.mining.reset();
    this.terrain.reset();
    this.player.reset(this.terrain.spawn);
    this.defense?.reset();
    this.reachedGoal = false;
    this.boardRenderer.redraw(this.terrain);
    this.updatePlayer();
    this.updateHover(this.hovered);
    this.hud.showDig();
    this.hud.showGoal(false);
  }
}

import Phaser from "phaser";
import { DebugHud } from "./hud.ts";
import { MiningSession } from "./mining.ts";
import type { MiningStrike } from "./mining.ts";
import { Player, worldToCell } from "./player.ts";
import { GridRenderer } from "./renderer.ts";
import { TerrainMap } from "./terrain.ts";
import type { GridPosition } from "./terrain.ts";

export class GridScene extends Phaser.Scene {
  private readonly terrain = new TerrainMap();
  private readonly player = new Player(this.terrain.spawn);
  private readonly mining = new MiningSession(this.terrain);
  private boardRenderer!: GridRenderer;
  private hud!: DebugHud;
  private keys!: Record<"W" | "A" | "S" | "D" | "R" | "G", Phaser.Input.Keyboard.Key>;
  private hovered: GridPosition | null = null;
  private gridVisible = true;
  private reachedGoal = false;

  create(): void {
    this.boardRenderer = new GridRenderer(this, this.terrain);
    this.hud = new DebugHud();
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("Keyboard input is unavailable");
    this.keys = keyboard.addKeys("W,A,S,D,R,G", false) as typeof this.keys;
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.inspectPointer, this);
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.beginMining, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.releasePointer, this);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.releasePointer, this);
    this.input.on(Phaser.Input.Events.GAME_OUT, this.leaveBoard, this);
    this.game.events.on(Phaser.Core.Events.BLUR, this.stopMining, this);
    this.game.events.on(Phaser.Core.Events.PAUSE, this.stopMining, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdownMining, this);
    this.updatePlayer();
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

    if (!this.input.mousePointer.leftButtonDown() || !this.input.isOver || document.hidden || !document.hasFocus()) {
      this.stopMining();
      return;
    }

    const strike = this.mining.update(this.player.cell, performance.now());
    if (strike) this.showStrike(strike);
  }

  private inspectPointer(pointer: Phaser.Input.Pointer): void {
    const cell = worldToCell(pointer.x, pointer.y);
    this.updateHover(this.terrain.isInside(cell) ? cell : null);
  }

  private updateHover(cell: GridPosition | null): void {
    this.hovered = cell;
    this.boardRenderer.showHover(cell);
    this.hud.showHover(cell, cell ? this.terrain.getCell(cell) : undefined);
  }

  private beginMining(pointer: Phaser.Input.Pointer): void {
    if (pointer.button !== 0 || !pointer.leftButtonDown() || document.hidden || !document.hasFocus() || this.game.isPaused) return;
    const target = worldToCell(pointer.x, pointer.y);
    this.showStrike(this.mining.begin(this.player.cell, target, performance.now()));
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
    this.hud.showPlayer(cell);
    if (!this.reachedGoal && this.terrain.isGoal(cell)) {
      this.reachedGoal = true;
      this.hud.showGoal(true);
    }
  }

  private reset(): void {
    this.stopMining();
    this.terrain.reset();
    this.player.reset(this.terrain.spawn);
    this.reachedGoal = false;
    this.boardRenderer.redraw(this.terrain);
    this.updatePlayer();
    this.updateHover(this.hovered);
    this.hud.showDig();
    this.hud.showGoal(false);
  }
}

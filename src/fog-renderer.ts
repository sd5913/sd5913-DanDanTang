import Phaser from "phaser";
import type { ExplorationFog } from "./fog.ts";
import { TILE_SIZE } from "./player.ts";

type ViewBounds = Pick<Phaser.Geom.Rectangle, "left" | "right" | "top" | "bottom">;

const UNKNOWN_COLOR = "#101820";
const EXPLORED_COLOR = "rgba(16, 24, 32, 0.64)";

export class FogRenderer {
  private readonly texture: Phaser.Textures.CanvasTexture;
  private readonly image: Phaser.GameObjects.Image;
  private readonly fog: ExplorationFog;
  private previousRevision = -1;
  private firstCol = -1;
  private endCol = -1;
  private firstRow = -1;
  private endRow = -1;

  constructor(scene: Phaser.Scene, fog: ExplorationFog) {
    this.fog = fog;
    const texture = scene.textures.createCanvas(`fog-${scene.sys.settings.key}`, 1, 1);
    if (!texture) throw new Error("Could not create the fog canvas");
    texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.texture = texture;
    this.image = scene.add.image(0, 0, texture.key).setOrigin(0).setDepth(4).setVisible(false);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => scene.textures.remove(texture.key));
  }

  render(view: ViewBounds): void {
    const firstCol = Math.max(0, Math.floor(view.left / TILE_SIZE));
    const endCol = Math.min(this.fog.columns, Math.ceil(view.right / TILE_SIZE));
    const firstRow = Math.max(0, Math.floor(view.top / TILE_SIZE));
    const endRow = Math.min(this.fog.rows, Math.ceil(view.bottom / TILE_SIZE));
    const width = (endCol - firstCol) * TILE_SIZE;
    const height = (endRow - firstRow) * TILE_SIZE;

    this.image.setVisible(width > 0 && height > 0);
    if (width <= 0 || height <= 0 || (
      this.previousRevision === this.fog.revision && firstCol === this.firstCol && endCol === this.endCol
      && firstRow === this.firstRow && endRow === this.endRow
    )) return;

    this.texture.setSize(width, height);
    const context = this.texture.getContext();
    context.clearRect(0, 0, width, height);
    for (let row = firstRow; row < endRow; row += 1) {
      for (let col = firstCol; col < endCol; col += 1) {
        const state = this.fog.visibility({ col, row });
        if (state === "visible") continue;
        context.fillStyle = state === "unknown" ? UNKNOWN_COLOR : EXPLORED_COLOR;
        context.fillRect((col - firstCol) * TILE_SIZE, (row - firstRow) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
    this.texture.refresh();
    this.image.setPosition(firstCol * TILE_SIZE, firstRow * TILE_SIZE);
    this.previousRevision = this.fog.revision;
    this.firstCol = firstCol;
    this.endCol = endCol;
    this.firstRow = firstRow;
    this.endRow = endRow;
  }
}

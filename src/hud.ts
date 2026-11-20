import type { MiningStrike } from "./mining.ts";
import type { FogVisibility } from "./fog.ts";
import type { ChunkId, DigFailure, GridPosition, TerrainCell, TerrainType } from "./terrain.ts";

const TERRAIN_NAMES: Record<TerrainType, string> = {
  empty: "空地",
  dirt: "可挖地形",
  rock: "不可破坏岩石",
  water: "水域",
};

const DIG_FAILURE_MESSAGES: Record<DigFailure, string> = {
  "out-of-bounds": "目标格超出地图边界",
  "invalid-origin": "玩家所在格不可通行",
  "out-of-reach": "只能挖掘上下左右相邻格",
  rock: "岩石不可挖掘",
  water: "水域不可挖掘",
  empty: "目标格已经是空地",
  "tool-level": "需要二级挖掘工具",
  "invalid-damage": "工具伤害无效",
};

function coordinates({ col, row }: GridPosition): string {
  return `(${col}, ${row})`;
}

function statusField(id: string): HTMLElement {
  const field = document.getElementById(id);
  if (!field) throw new Error(`Missing debug field #${id}`);
  return field;
}

function writeStatus(field: HTMLElement, value: string): void {
  if (field.textContent !== value) field.textContent = value;
}

export class DebugHud {
  private readonly player = statusField("player-cell");
  private readonly chunk = statusField("chunk-status");
  private readonly viewport = statusField("visible-chunks");
  private readonly hover = statusField("hover-cell");
  private readonly grid = statusField("grid-status");
  private readonly dig = statusField("dig-result");
  private readonly goal = statusField("goal-status");

  showPlayer(cell: GridPosition, chunk?: ChunkId): void {
    writeStatus(this.player, coordinates(cell));
    writeStatus(this.chunk, chunk ? `(${chunk.chunkCol}, ${chunk.chunkRow})` : "—");
  }

  showViewport(chunkRows: readonly number[], view: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">): void {
    writeStatus(this.viewport, chunkRows.map((row) => `(0, ${row})`).join(" "));
    for (const [field, value] of Object.entries({ count: chunkRows.length, worldLeft: view.left,
      worldTop: view.top, worldWidth: view.width, worldHeight: view.height })) {
      const text = String(value);
      if (this.viewport.dataset[field] !== text) this.viewport.dataset[field] = text;
    }
  }

  showHover(cell: GridPosition | null, state?: TerrainCell, visibility?: FogVisibility): void {
    if (visibility && this.hover.dataset.visibility !== visibility) this.hover.dataset.visibility = visibility;
    if (!visibility && this.hover.dataset.visibility) delete this.hover.dataset.visibility;
    if (visibility === "unknown" || visibility === "explored") {
      writeStatus(this.hover, visibility === "unknown" ? "未探索" : "已探索 · 当前不可见");
      return;
    }
    if (!cell || !state) {
      writeStatus(this.hover, "—");
      return;
    }
    const hp = state.terrain === "dirt" ? ` | HP ${state.hp}/${state.maxHp}` : "";
    const tier = state.terrain === "dirt" ? ` | Lv.${state.terrainLevel}` : "";
    writeStatus(this.hover, `${TERRAIN_NAMES[state.terrain]} ${coordinates(cell)}${hp}${tier}`);
  }

  showGrid(visible: boolean): void {
    writeStatus(this.grid, visible ? "显示" : "隐藏");
  }

  showDig(strike?: MiningStrike, miningIncome = 0): void {
    if (!strike) {
      this.dig.dataset.outcome = "idle";
      writeStatus(this.dig, "等待挖掘");
      return;
    }

    const { result, target } = strike;
    if (!result.effective) {
      this.dig.dataset.outcome = "rejected";
      writeStatus(this.dig, `${DIG_FAILURE_MESSAGES[result.reason]} · ${coordinates(target)}`);
      return;
    }

    this.dig.dataset.outcome = result.cleared ? "dug" : "hit";
    const message = result.cleared ? "挖掘成功" : `命中 · -${result.damage} HP · 剩余 ${result.hp} HP`;
    const income = miningIncome > 0 ? ` · +${miningIncome.toFixed(1)} 经济` : "";
    writeStatus(this.dig, `${message} · ${coordinates(target)}${income}`);
  }

  showGoal(reached: boolean, expedition = false): void {
    this.goal.dataset.reached = String(reached);
    if (expedition) {
      writeStatus(this.goal, reached ? "已抵达北端目标区" : "升级至 Lv.2 工具，挖通地形并抵达北端目标区");
    } else {
      writeStatus(this.goal, reached ? "P0-A 测试完成" : "挖通地形，抵达北端目标区");
    }
  }
}

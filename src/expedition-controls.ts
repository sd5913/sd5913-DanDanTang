import type Phaser from "phaser";
import type { BuildingKind } from "./buildings.ts";
import { CARD_KINDS, ECONOMY_PROTOTYPE, ExpeditionEconomy, TECHNOLOGY_PROTOTYPE } from "./expedition-economy.ts";
import type { CardKind } from "./expedition-economy.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

export const BUILDING_NAMES: Record<BuildingKind, string> = {
  wall: "城墙", tower: "防御塔", economy: "经济建筑", technology: "科技设施",
};

function field<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing expedition field #${id}`);
  return element as T;
}

function write(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

interface ExpeditionActions {
  spawnEnemy(): void;
  canRebuild(cell: GridPosition): boolean;
}

export class ExpeditionControls {
  readonly economy: ExpeditionEconomy;
  private selected?: CardKind;
  private readonly cards = new Map(CARD_KINDS.map((kind) => [kind, field<HTMLButtonElement>(`card-${kind}`)]));
  private readonly balance = field("economy-balance");
  private readonly makeCard = field<HTMLButtonElement>("make-card");
  private readonly tool = field("tool-level");
  private readonly research = field<HTMLButtonElement>("research-tool");
  private readonly rebuild = field<HTMLButtonElement>("rebuild-technology");
  private readonly status = field("expedition-feedback");
  private readonly building = field("expedition-building");

  constructor(scene: Phaser.Scene, map: TerrainMap, seed: number, actions: ExpeditionActions) {
    this.economy = new ExpeditionEconomy(map, seed);
    const events = new AbortController();
    const options = { signal: events.signal };
    const panel = field("expedition-panel");
    panel.hidden = false;
    this.makeCard.textContent = `制造卡牌（${ECONOMY_PROTOTYPE.drawCost} 经济）`;
    this.research.textContent = `研发 Lv.2 工具（${TECHNOLOGY_PROTOTYPE.researchCost} 经济）`;
    this.makeCard.addEventListener("click", () => {
      const card = this.economy.drawCard();
      if (card) this.showFeedback(`已制造${BUILDING_NAMES[card]}卡`);
      this.refresh();
    }, options);
    this.research.addEventListener("click", () => {
      if (this.economy.researchTool()) this.showFeedback("已研发 Lv.2 工具");
      this.refresh();
    }, options);
    this.rebuild.addEventListener("click", () => {
      if (actions.canRebuild(this.economy.technologyCell) && this.economy.rebuildTechnology()) {
        this.showFeedback("已重建科技设施");
      } else {
        this.showFeedback("科技设施原址暂被占用");
      }
      this.refresh();
    }, options);
    field("expedition-spawn").addEventListener("click", actions.spawnEnemy, options);
    for (const [card, button] of this.cards) {
      button.addEventListener("click", () => {
        this.selected = this.selected === card ? undefined : card;
        this.showFeedback(this.selected ? `点击空地放置${BUILDING_NAMES[card]}` : "已取消选择");
        this.refresh();
      }, options);
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.selected) return;
      this.selected = undefined;
      this.showFeedback("已取消选择");
      this.refresh();
    }, options);
    scene.events.once("shutdown", () => {
      events.abort();
      panel.hidden = true;
    });
    this.refresh();
  }

  get hasSelection(): boolean { return this.selected !== undefined; }

  placeSelected(cell: GridPosition, canPlace: boolean): void {
    if (!this.selected) return;
    const name = BUILDING_NAMES[this.selected];
    const building = canPlace && this.economy.placeCard(this.selected, cell);
    if (!building) {
      this.showFeedback("只能在未被占用的空地建造");
      return;
    }
    const position = `(${building.cell.col}, ${building.cell.row})`;
    this.showFeedback(building.level === 2 ? `已合成${name} Lv.2 ${position}` : `已建造${name} ${position}`);
    if (!this.economy.cards[this.selected]) this.selected = undefined;
    this.refresh();
  }

  showBuilding(text: string): void {
    write(this.building, text);
  }

  showFeedback(text: string): void {
    write(this.status, text);
  }

  refresh(): void {
    write(this.balance, String(this.economy.balance));
    const cards = this.economy.cards;
    for (const [kind, button] of this.cards) {
      const count = String(cards[kind]);
      if (button.dataset.count !== count) {
        button.dataset.count = count;
        button.disabled = cards[kind] === 0;
        write(button, `${BUILDING_NAMES[kind]} ${count}`);
      }
      const pressed = String(this.selected === kind);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
    const canDraw = this.economy.hasTechnology && this.economy.balance >= ECONOMY_PROTOTYPE.drawCost;
    if (this.makeCard.disabled === canDraw) this.makeCard.disabled = !canDraw;
    const { toolLevel, hasTechnology, balance } = this.economy;
    write(this.tool, `Lv.${toolLevel}`);
    const canResearch = toolLevel < 2 && hasTechnology && balance >= TECHNOLOGY_PROTOTYPE.researchCost;
    if (this.research.disabled === canResearch) this.research.disabled = !canResearch;
    if (this.rebuild.hidden !== hasTechnology) this.rebuild.hidden = hasTechnology;
  }

  reset(): void {
    this.economy.reset();
    this.selected = undefined;
    this.showFeedback("请选择建筑卡，或按住左键挖掘");
    this.refresh();
  }
}

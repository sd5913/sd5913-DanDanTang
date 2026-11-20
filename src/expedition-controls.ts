import type Phaser from "phaser";
import type { BuildingKind } from "./buildings.ts";
import { BIOME_NAMES } from "./biome-effects.ts";
import type { PlacementFailure, PlacementPreview } from "./build-placement.ts";
import type { BiomeId } from "./expedition-biomes.ts";
import { CARD_KINDS, ECONOMY_PROTOTYPE, ExpeditionEconomy, TECHNOLOGY_PROTOTYPE } from "./expedition-economy.ts";
import type { CardDrawFailure, CardKind } from "./expedition-economy.ts";
import type { ExpeditionPhase, ExpeditionRound } from "./expedition-round.ts";
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

const PHASE_NAMES: Record<ExpeditionPhase, string> = {
  preparing: "准备中", attacking: "敌人进攻中", recovering: "休整中",
  won: "获胜 · 已抵达北端目标", lost: "战败 · 玩家生命耗尽",
};

const CARD_DRAW_FEEDBACK_MS = 1_750;
const CHALLENGE_OPENING_HINT = "挖掘地形获得经济，使用科技设施制造建筑卡。";
const FIRST_CARD_READY_HINT = "已可制造第一张建筑卡";
const CARD_SYMBOLS: Record<CardKind, string> = { wall: "▦", tower: "▲", economy: "◆" };
const DRAW_FAILURE_LABELS: Record<CardDrawFailure | "round-ended", string> = {
  "technology-destroyed": "科技设施已损毁",
  "insufficient-funds": `经济不足，需要 ${ECONOMY_PROTOTYPE.drawCost} 经济`,
  "round-ended": "本局已结束",
};

const PLACEMENT_FAILURE_LABELS: Record<PlacementFailure, string> = {
  "round-ended": "本局已结束，无法建造",
  "out-of-bounds": "目标格超出地图边界",
  "player-cell": "不能在玩家脚下建造",
  "out-of-range": "距离过远，只能在周围一格建造",
  "not-visible": "目标格当前不可见",
  reserved: "该格保留给地图目标、出兵点或科技设施",
  terrain: "地形不可建造，需要空地",
  occupied: "该格已有建筑",
  "player-overlap": "玩家仍与该格重叠，请让开后建造",
  "enemy-occupied": "该格被敌人占用",
  "out-of-stock": "对应建筑卡片不足",
};

interface ExpeditionActions {
  readonly debug: boolean;
  spawnEnemy(): void;
  spawnStress(count: number): void;
  checkPlacement(cell: GridPosition, kind: CardKind | "technology"): PlacementFailure | undefined;
}

export class ExpeditionControls {
  readonly economy: ExpeditionEconomy;
  private readonly checkPlacement: ExpeditionActions["checkPlacement"];
  private readonly challenge: boolean;
  private firstDrawReadyShown = false;
  private selected?: CardKind;
  private finished = false;
  private recentDraw?: { readonly card: CardKind; readonly timer: number };
  private readonly drawnCards: Record<CardKind, number> = { wall: 0, tower: 0, economy: 0 };
  private readonly state = field("round-state");
  private readonly time = field("round-time");
  private readonly timeLabel = field("round-time-label");
  private readonly nextCount = field("round-next-count");
  private readonly playerHp = field("player-hp");
  private readonly wave = field("round-wave");
  private readonly pressure = field("round-pressure");
  private readonly stage = field("round-stage");
  private readonly spawn = field<HTMLButtonElement>("expedition-spawn");
  private readonly stress = field<HTMLButtonElement>("expedition-stress");
  private readonly cards = new Map(CARD_KINDS.map((kind) => [kind, field<HTMLButtonElement>(`card-${kind}`)]));
  private readonly balance = field("economy-balance");
  private readonly makeCard = field<HTMLButtonElement>("make-card");
  private readonly drawResult = field("card-draw-result");
  private readonly drawSymbol = field("card-draw-symbol");
  private readonly drawText = field("card-draw-text");
  private readonly drawReason = field("card-draw-reason");
  private readonly drawSummary = field("card-draw-summary");
  private readonly tool = field("tool-level");
  private readonly research = field<HTMLButtonElement>("research-tool");
  private readonly rebuild = field<HTMLButtonElement>("rebuild-technology");
  private readonly status = field("expedition-feedback");
  private readonly placementPreview = field("build-preview");
  private readonly building = field("expedition-building");
  private readonly biome = field("expedition-biome");

  constructor(
    scene: Phaser.Scene, map: TerrainMap, seed: number, round: ExpeditionRound, actions: ExpeditionActions,
  ) {
    this.economy = new ExpeditionEconomy(map, seed, undefined, round.difficulty);
    this.challenge = round.difficulty === "challenge";
    this.checkPlacement = actions.checkPlacement;
    const events = new AbortController();
    const options = { signal: events.signal };
    const panel = field("expedition-panel");
    const roundPanel = field("round-panel");
    panel.hidden = false;
    roundPanel.hidden = false;
    field("expedition-debug").hidden = !actions.debug;
    this.showRound(round);
    if (this.challenge) this.showFeedback(CHALLENGE_OPENING_HINT);
    this.makeCard.textContent = `制造卡牌（${ECONOMY_PROTOTYPE.drawCost} 经济）`;
    this.research.textContent = `研发 Lv.2 工具（${TECHNOLOGY_PROTOTYPE.researchCost} 经济）`;
    this.makeCard.addEventListener("click", () => {
      const before = this.economy.cards;
      const card = this.finished ? undefined : this.economy.drawCard();
      if (card) {
        this.showDrawFeedback(card, before[card], this.economy.cards[card]);
        if (this.status.textContent === FIRST_CARD_READY_HINT) this.showFeedback("");
      }
      this.refresh();
    }, options);
    this.research.addEventListener("click", () => {
      if (this.economy.researchTool()) this.showFeedback("已研发 Lv.2 工具");
      this.refresh();
    }, options);
    this.rebuild.addEventListener("click", () => {
      const reason = this.checkPlacement(this.economy.technologyCell, "technology");
      if (!reason && this.economy.rebuildTechnology()) {
        this.showFeedback("已重建科技设施");
      } else {
        this.showFeedback(reason ? PLACEMENT_FAILURE_LABELS[reason] : "科技设施原址暂被占用");
      }
      this.refresh();
    }, options);
    if (actions.debug) {
      const stressCount = field<HTMLSelectElement>("expedition-stress-count");
      this.spawn.addEventListener("click", actions.spawnEnemy, options);
      this.stress.addEventListener("click", () => actions.spawnStress(Number(stressCount.value)), options);
    }
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
      this.clearDrawFeedback();
      write(this.drawSummary, "");
      this.previewPlacement(null);
      panel.hidden = true;
      roundPanel.hidden = true;
    });
    this.refresh();
  }

  previewPlacement(cell: GridPosition | null): PlacementPreview | undefined {
    const { placementPreview } = this;
    if (!cell || !this.selected) {
      if (!placementPreview.hidden) {
        placementPreview.hidden = true;
        delete placementPreview.dataset.state;
        delete placementPreview.dataset.reason;
        write(placementPreview, "");
      }
      return undefined;
    }

    const reason = this.checkPlacement(cell, this.selected);
    const state = reason ? "invalid" : "valid";
    if (placementPreview.dataset.state !== state) placementPreview.dataset.state = state;
    if (reason && placementPreview.dataset.reason !== reason) placementPreview.dataset.reason = reason;
    if (!reason && placementPreview.dataset.reason) delete placementPreview.dataset.reason;
    write(placementPreview, reason ? PLACEMENT_FAILURE_LABELS[reason] : `可建造${BUILDING_NAMES[this.selected]}`);
    if (placementPreview.hidden) placementPreview.hidden = false;
    return state;
  }

  placeSelected(cell: GridPosition): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const reason = this.checkPlacement(cell, selected);
    if (reason) {
      this.showFeedback(PLACEMENT_FAILURE_LABELS[reason]);
      return true;
    }

    const building = this.economy.placeCard(selected, cell);
    if (!building) {
      this.showFeedback("当前无法在该格建造");
      return true;
    }
    const name = BUILDING_NAMES[selected];
    const position = `(${building.cell.col}, ${building.cell.row})`;
    this.showFeedback(building.level === 2 ? `已合成${name} Lv.2 ${position}` : `已建造${name} ${position}`);
    if (!this.economy.cards[selected]) this.selected = undefined;
    this.refresh();
    return true;
  }

  showBuilding(text: string): void {
    write(this.building, text);
  }

  showBiome(biome: BiomeId): void {
    write(this.biome, BIOME_NAMES[biome]);
  }

  showFeedback(text: string): void {
    write(this.status, text);
  }

  showRound(round: ExpeditionRound): void {
    const { phase, playerHp, wave, pressure, stage, remainingMs } = round;
    this.finished = phase === "won" || phase === "lost";
    if (this.finished) this.selected = undefined;
    if (this.state.dataset.phase !== phase) this.state.dataset.phase = phase;
    const upcoming = round.upcoming;
    write(this.state, phase === "attacking" ? `第 ${wave} 波开始 · 敌人进攻中` : PHASE_NAMES[phase]);
    write(this.playerHp, String(playerHp));
    write(this.wave, String(wave));
    write(this.pressure, String(pressure));
    write(this.stage, `${stage + 1} · ${round.strength.enemyHp} HP`);
    const waitingLabel = this.challenge && phase === "preparing" ? "首波倒计时" : "下波倒计时";
    write(this.timeLabel, this.finished ? "剩余时间" : upcoming ? waitingLabel : "进攻剩余");
    write(this.time, this.finished ? "—" : `${Math.ceil(remainingMs / 1000)} 秒`);
    write(this.nextCount, upcoming ? `${upcoming.count} 只` : "—");
  }

  refresh(): void {
    if (!this.selected) this.previewPlacement(null);
    const { toolLevel, hasTechnology, balance } = this.economy;
    write(this.balance, this.challenge ? balance.toFixed(1) : String(balance));
    const cards = this.economy.cards;
    for (const [kind, button] of this.cards) {
      const count = String(cards[kind]);
      if (button.dataset.count !== count) {
        button.dataset.count = count;
        write(button, `${BUILDING_NAMES[kind]} ${count}`);
      }
      const disabled = this.finished;
      if (button.disabled !== disabled) button.disabled = disabled;
      const pressed = String(this.selected === kind);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
    const drawFailure = this.finished ? "round-ended" : this.economy.drawFailure;
    const canDraw = drawFailure === undefined;
    if (this.makeCard.disabled === canDraw) this.makeCard.disabled = !canDraw;
    write(this.drawReason, drawFailure ? DRAW_FAILURE_LABELS[drawFailure] : "");
    if (this.challenge && canDraw && !this.firstDrawReadyShown) {
      this.firstDrawReadyShown = true;
      this.showFeedback(FIRST_CARD_READY_HINT);
    }
    write(this.tool, `Lv.${toolLevel}`);
    const canResearch = !this.finished && toolLevel < 2 && hasTechnology && balance >= TECHNOLOGY_PROTOTYPE.researchCost;
    if (this.research.disabled === canResearch) this.research.disabled = !canResearch;
    if (this.rebuild.hidden !== hasTechnology) this.rebuild.hidden = hasTechnology;
    if (this.rebuild.disabled !== this.finished) this.rebuild.disabled = this.finished;
    if (this.spawn.disabled !== this.finished) this.spawn.disabled = this.finished;
    if (this.stress.disabled !== this.finished) this.stress.disabled = this.finished;
  }

  private showDrawFeedback(card: CardKind, before: number, after: number): void {
    this.clearDrawFeedback();
    this.drawResult.dataset.card = card;
    this.cards.get(card)!.dataset.drawn = "true";
    write(this.drawSymbol, CARD_SYMBOLS[card]);
    write(this.drawText, `获得：一级${BUILDING_NAMES[card]}卡 ×${after - before} · 库存：${before} → ${after}`);
    this.drawnCards[card] += after - before;
    const totals = CARD_KINDS.map((kind) => `${BUILDING_NAMES[kind]} ${this.drawnCards[kind]}`);
    write(this.drawSummary, `本局获得 · ${totals.join(" · ")}`);
    const timer = window.setTimeout(() => this.clearDrawFeedback(), CARD_DRAW_FEEDBACK_MS);
    this.recentDraw = { card, timer };
  }

  private clearDrawFeedback(): void {
    if (!this.recentDraw) return;
    window.clearTimeout(this.recentDraw.timer);
    delete this.cards.get(this.recentDraw.card)!.dataset.drawn;
    delete this.drawResult.dataset.card;
    write(this.drawSymbol, "");
    write(this.drawText, "");
    this.recentDraw = undefined;
  }

  reset(): void {
    this.economy.reset();
    this.firstDrawReadyShown = false;
    this.selected = undefined;
    this.clearDrawFeedback();
    for (const card of CARD_KINDS) this.drawnCards[card] = 0;
    write(this.drawSummary, "");
    this.showFeedback(this.challenge ? CHALLENGE_OPENING_HINT : "请选择建筑卡，或按住左键挖掘");
    this.refresh();
  }
}

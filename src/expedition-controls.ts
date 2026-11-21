import type Phaser from "phaser";
import type { BuildingKind, BuildingSynthesisPreview, TowerEvolution } from "./buildings.ts";
import { BIOME_NAMES } from "./biome-effects.ts";
import type { PlacementFailure, PlacementPreview } from "./build-placement.ts";
import type { BiomeId } from "./expedition-biomes.ts";
import { CARD_KINDS, ExpeditionEconomy } from "./expedition-economy.ts";
import type { CardDrawFailure, CardKind, EconomyExperiment, TechnologyBuildFailure } from "./expedition-economy.ts";
import type { ExpeditionPhase, ExpeditionRound } from "./expedition-round.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

export const BUILDING_NAMES: Record<BuildingKind, string> = {
  wall: "城墙", tower: "防御塔", economy: "经济建筑", technology: "科技设施",
};

export function evolutionName(evolution: TowerEvolution): string {
  return evolution.kind === "piercing" ? "Piercing Tower Lv.2" : "Burst Tower Lv.2";
}

export function evolutionDirection(evolution: TowerEvolution): string {
  return evolution.kind === "burst" ? "范围爆裂" : evolution.axis === "horizontal" ? "横向穿透" : "纵向穿透";
}

function cellCoordinates({ col, row }: GridPosition): string { return `(${col}, ${row})`; }

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
  evacuating: "撤离防守 · 最终敌袭", won: "获胜 · 已抵达北端目标", lost: "战败 · 玩家生命耗尽",
};

const CARD_DRAW_FEEDBACK_MS = 1_750;
const CHALLENGE_OPENING_HINT = "挖掘地形获得经济，先建造科技设施，再制造建筑卡。";
const FIRST_CARD_READY_HINT = "已可制造第一张建筑卡";
const CARD_SYMBOLS: Record<CardKind, string> = { wall: "▦", tower: "▲", economy: "◆" };
const DRAW_FAILURE_LABELS: Record<Exclude<CardDrawFailure, "insufficient-funds"> | "round-ended", string> = {
  "technology-missing": "请先建造科技设施",
  "technology-destroyed": "科技设施已损毁",
  "round-ended": "本局已结束",
};

type PlacementKind = CardKind | "technology";

const PLACEMENT_FAILURE_LABELS: Record<PlacementFailure | TechnologyBuildFailure, string> = {
  "already-built": "科技设施已建成",
  "insufficient-funds": "经济不足，无法建造科技设施",
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
  readonly economyExperiment?: EconomyExperiment;
  readonly manualMerge?: boolean;
  spawnEnemy(): void;
  spawnStress(count: number): void;
  checkPlacement(cell: GridPosition, kind: PlacementKind): PlacementFailure | undefined;
}

export class ExpeditionControls {
  readonly economy: ExpeditionEconomy;
  private readonly checkPlacement: ExpeditionActions["checkPlacement"];
  private readonly challenge: boolean;
  private readonly manualMerge: boolean;
  private readonly map: TerrainMap;
  private preview?: {
    readonly revision: number;
    readonly target: GridPosition;
    readonly synthesis?: BuildingSynthesisPreview;
    readonly label?: string;
  };
  private activeSynthesis?: BuildingSynthesisPreview;
  private firstDrawReadyShown = false;
  private firstTechnologyReadyShown = false;
  private selected?: PlacementKind;
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
  private readonly placementCost = field("card-placement-cost");
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
    this.map = map;
    this.economy = new ExpeditionEconomy(map, seed, undefined, round.difficulty, actions.economyExperiment);
    this.challenge = round.difficulty === "challenge";
    this.manualMerge = actions.manualMerge === true;
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
    this.research.textContent = `研发 Lv.2 工具（${this.economy.researchCost} 经济）`;
    const technologyCost = this.economy.technologyBuildCost;
    write(this.rebuild, technologyCost === undefined ? "重建科技设施" : `建造科技设施（${technologyCost} 经济）`);
    if (technologyCost === undefined) this.rebuild.removeAttribute("aria-pressed");
    this.makeCard.addEventListener("click", () => {
      const before = this.economy.cards;
      const cost = this.economy.drawCost;
      const card = this.finished ? undefined : this.economy.drawCard();
      if (card) {
        this.showDrawFeedback(card, before[card], this.economy.cards[card]);
        if (this.economy.drawCost !== cost) {
          this.showFeedback(`下次制造费用升至 ${this.economy.drawCost} 经济`);
        } else if (this.status.textContent?.includes(FIRST_CARD_READY_HINT)) {
          this.showFeedback("");
        }
      }
      this.refresh();
    }, options);
    this.research.addEventListener("click", () => {
      if (this.economy.researchTool()) this.showFeedback("已研发 Lv.2 工具");
      this.refresh();
    }, options);
    this.rebuild.addEventListener("click", () => {
      if (this.challenge) {
        if (this.finished || this.economy.technologyFailure) return;
        this.selected = this.selected === "technology" ? undefined : "technology";
        this.showFeedback(this.selected ? "点击空地放置科技设施" : "已取消选择");
        this.refresh();
        return;
      }
      const cell = this.economy.technologyCell;
      if (!cell) return;
      const reason = this.checkPlacement(cell, "technology");
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
        write(this.placementCost, "");
        const quickPlace = this.manualMerge ? " · 按住 Shift 连续放置" : "";
        this.showFeedback(this.selected ? `点击空地放置${BUILDING_NAMES[card]}${quickPlace}` : "已取消选择");
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
      write(this.placementCost, "");
      this.clearDrawFeedback();
      write(this.drawSummary, "");
      this.previewPlacement(null);
      panel.hidden = true;
      roundPanel.hidden = true;
    });
    this.refresh();
  }

  private placementRejection(cell: GridPosition, kind: PlacementKind): PlacementFailure | TechnologyBuildFailure | undefined {
    return this.checkPlacement(cell, kind) ?? (kind === "technology" ? this.economy.technologyFailure : undefined);
  }

  previewPlacement(cell: GridPosition | null): PlacementPreview | undefined {
    const { placementPreview } = this;
    this.activeSynthesis = undefined;
    if (!cell || !this.selected) {
      if (!placementPreview.hidden) {
        placementPreview.hidden = true;
        delete placementPreview.dataset.state;
        delete placementPreview.dataset.reason;
        write(placementPreview, "");
      }
      return undefined;
    }

    const reason = this.placementRejection(cell, this.selected);
    const state = reason ? "invalid" : "valid";
    if (placementPreview.dataset.state !== state) placementPreview.dataset.state = state;
    if (reason && placementPreview.dataset.reason !== reason) placementPreview.dataset.reason = reason;
    if (!reason && placementPreview.dataset.reason) delete placementPreview.dataset.reason;
    let label = reason ? PLACEMENT_FAILURE_LABELS[reason] : `可建造${BUILDING_NAMES[this.selected]}`;
    if (!reason && this.selected === "tower") {
      const previous = this.preview;
      if (previous?.revision !== this.map.revision || previous.target.col !== cell.col || previous.target.row !== cell.row) {
        const synthesis = this.map.previewBuildingSynthesis("tower", cell);
        const evolution = synthesis?.evolution;
        const forecast = evolution ? `将合成 ${evolutionName(evolution)} · ${evolutionDirection(evolution)}`
          + ` · 保留 ${cellCoordinates(synthesis.retained)} · 释放 ${synthesis.released.map(cellCoordinates).join("、")}` : undefined;
        this.preview = { revision: this.map.revision, target: cell, synthesis, label: forecast };
      }
      if (this.preview?.label) {
        this.activeSynthesis = this.preview.synthesis;
        label = this.preview.label;
      }
    }
    write(placementPreview, label);
    if (placementPreview.hidden) placementPreview.hidden = false;
    return state;
  }

  get synthesisPreview(): BuildingSynthesisPreview | undefined { return this.activeSynthesis; }
  get placing(): boolean { return this.selected !== undefined; }

  placeSelected(cell: GridPosition, keepPlacing = false): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const reason = this.placementRejection(cell, selected);
    if (reason) {
      this.showFeedback(PLACEMENT_FAILURE_LABELS[reason]);
      return true;
    }

    if (selected === "technology") {
      this.placePaidTechnology(cell);
      return true;
    }

    const before = this.economy.cards[selected];
    const building = this.economy.placeCard(selected, cell);
    if (!building) {
      this.showFeedback("当前无法在该格建造");
      return true;
    }
    const name = BUILDING_NAMES[selected];
    const position = cellCoordinates(building.cell);
    if (building.evolution) {
      this.showFeedback(`已合成 ${evolutionName(building.evolution)} ${position} · ${evolutionDirection(building.evolution)}`);
    } else {
      this.showFeedback(building.level === 2 ? `已合成${name} Lv.2 ${position}` : `已建造${name} ${position}`);
    }
    const after = this.economy.cards[selected];
    write(this.placementCost, `消耗：${name}卡 ×${before - after} · 库存：${before} → ${after}`);
    this.selected = this.manualMerge && keepPlacing && after > 0 ? selected : undefined;
    this.refresh();
    return true;
  }

  private placePaidTechnology(cell: GridPosition): void {
    const before = this.economy.balance;
    const building = this.economy.buildTechnology(cell);
    if (!building) {
      this.showFeedback("当前无法在该格建造");
      return;
    }
    const { balance, technologyBuildCost, drawFailure } = this.economy;
    let feedback = `已建造科技设施 (${cell.col}, ${cell.row}) · 消耗 ${technologyBuildCost} 经济`
      + ` · 余额 ${before.toFixed(1)} → ${balance.toFixed(1)}`;
    if (!this.firstDrawReadyShown && drawFailure === undefined) {
      this.firstDrawReadyShown = true;
      feedback += ` · ${FIRST_CARD_READY_HINT}`;
    }
    this.showFeedback(feedback);
    this.selected = undefined;
    this.refresh();
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
    const terminal = phase === "won" && round.evacuation ? "获胜 · 撤离成功"
      : phase === "lost" && round.lossReason === "evacuation" ? "战败 · 撤离装置已摧毁" : undefined;
    write(this.state, phase === "attacking" ? `第 ${wave} 波开始 · 敌人进攻中` : terminal ?? PHASE_NAMES[phase]);
    write(this.playerHp, String(playerHp));
    write(this.wave, String(wave));
    write(this.pressure, String(pressure));
    write(this.stage, `${stage + 1} · ${round.strength.enemyHp} HP`);
    const waitingLabel = this.challenge && phase === "preparing" ? "首波倒计时" : "下波倒计时";
    write(this.timeLabel, phase === "evacuating" ? "最终敌袭" : this.finished ? "剩余时间" : upcoming ? waitingLabel : "进攻剩余");
    write(this.time, phase === "evacuating" ? "见北端装置" : this.finished ? "—" : `${Math.ceil(remainingMs / 1000)} 秒`);
    write(this.nextCount, upcoming ? `${upcoming.count} 只` : "—");
  }

  refresh(): void {
    if (!this.selected) this.previewPlacement(null);
    const { toolLevel, hasTechnology, balance, drawCost } = this.economy;
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
    write(this.makeCard, `制造卡牌（${drawCost} 经济）`);
    write(this.drawReason, drawFailure === "insufficient-funds"
      ? `经济不足，需要 ${drawCost} 经济`
      : drawFailure ? DRAW_FAILURE_LABELS[drawFailure] : "");
    if (this.challenge && canDraw && !this.firstDrawReadyShown) {
      this.firstDrawReadyShown = true;
      this.showFeedback(FIRST_CARD_READY_HINT);
    }
    write(this.tool, `Lv.${toolLevel}`);
    const canResearch = !this.finished && toolLevel < 2 && hasTechnology && balance >= this.economy.researchCost;
    if (this.research.disabled === canResearch) this.research.disabled = !canResearch;
    if (this.rebuild.hidden !== hasTechnology) this.rebuild.hidden = hasTechnology;
    const technologyDisabled = this.finished || (this.challenge && this.economy.technologyFailure !== undefined);
    if (this.rebuild.disabled !== technologyDisabled) this.rebuild.disabled = technologyDisabled;
    if (this.challenge) {
      const pressed = String(this.selected === "technology");
      if (this.rebuild.getAttribute("aria-pressed") !== pressed) this.rebuild.setAttribute("aria-pressed", pressed);
      if (!technologyDisabled && !hasTechnology && !this.firstTechnologyReadyShown) {
        this.firstTechnologyReadyShown = true;
        this.showFeedback("已可建造科技设施，选择后在周围空地放置");
      }
    }
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
    this.firstTechnologyReadyShown = false;
    this.selected = undefined;
    write(this.placementCost, "");
    this.clearDrawFeedback();
    for (const card of CARD_KINDS) this.drawnCards[card] = 0;
    write(this.drawSummary, "");
    this.showFeedback(this.challenge ? CHALLENGE_OPENING_HINT : "请选择建筑卡，或按住左键挖掘");
    this.refresh();
  }
}

import type { Building } from "./buildings.ts";
import { BIOME_PROTOTYPE } from "./biome-effects.ts";
import { DIFFICULTY_PROFILES } from "./expedition-difficulty.ts";
import type { DifficultyEconomy, DifficultyId } from "./expedition-difficulty.ts";
import type { DefenseEvent } from "./defense-simulation.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

export const CARD_KINDS = Object.freeze(["wall", "tower", "economy"] as const);
export type CardKind = typeof CARD_KINDS[number];
export type CardDrawFailure = "technology-destroyed" | "insufficient-funds";
type CardCounts = Readonly<Record<CardKind, number>>;

export interface EconomyTotals {
  readonly balance: number;
  readonly killIncome: number;
  readonly productionIncome: number;
  readonly cardsMade: number;
  readonly cardSpend: number;
  readonly researchSpend: number;
  readonly miningIncome?: number;
}

function newTotals() {
  return {
    killIncomeTenths: 0, productionIncomeTenths: 0, cardsMade: 0,
    cardSpendTenths: 0, researchSpendTenths: 0, miningIncomeTenths: 0,
  };
}

const TENTHS_PER_COIN = 10;

export function toEconomyTenths(coins: number): number {
  return Math.round(coins * TENTHS_PER_COIN);
}

export function fromEconomyTenths(tenths: number): number {
  return tenths / TENTHS_PER_COIN;
}

export const ECONOMY_PROTOTYPE = Object.freeze({
  initialBalance: DIFFICULTY_PROFILES.baseline.economy.initialBalance,
  initialCards: DIFFICULTY_PROFILES.baseline.economy.initialCards,
  productionIntervalMs: 4_000,
  productionAmount: 1,
  towerKillReward: 2,
  drawCost: 3,
  drawWeights: Object.freeze({ wall: 1, tower: 1, economy: 1 }),
  buildingHp: Object.freeze({ wall: 50, tower: 6, economy: 6, technology: 10 }),
  technologyCell: Object.freeze({ col: 17, row: 90 }),
});

export const TECHNOLOGY_PROTOTYPE = Object.freeze({ researchCost: 10 });

const DRAW_SALT = 0x9e37_79b9;
const DEFENSE_DRAW_SALT = 0xa511_e9b3;
const DRAW_WEIGHT = CARD_KINDS.reduce((total, kind) => total + ECONOMY_PROTOTYPE.drawWeights[kind], 0);
const DRAW_COST_TENTHS = toEconomyTenths(ECONOMY_PROTOTYPE.drawCost);
const RESEARCH_COST_TENTHS = toEconomyTenths(TECHNOLOGY_PROTOTYPE.researchCost);

function nextDrawState(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

export class ExpeditionEconomy {
  readonly #map: TerrainMap;
  readonly #initialDrawState: number;
  readonly #initialDefenseDrawState: number;
  readonly #technologyCell: GridPosition;
  readonly #rules: DifficultyEconomy;
  #toolLevel: 1 | 2 = 1;
  #balanceTenths = 0;
  #cards: CardCounts = ECONOMY_PROTOTYPE.initialCards;
  #drawState = 0;
  #hasDrawnDefense = false;
  #productionMs = new WeakMap<GridPosition, number>();
  readonly #rewardedKills = new Set<number>();
  #totals = newTotals();

  constructor(
    map: TerrainMap, seed: number, technologyCell: GridPosition = ECONOMY_PROTOTYPE.technologyCell,
    difficulty: DifficultyId = "baseline",
  ) {
    this.#map = map;
    this.#rules = DIFFICULTY_PROFILES[difficulty].economy;
    this.#initialDrawState = (seed ^ DRAW_SALT) >>> 0;
    this.#initialDefenseDrawState = (seed ^ DEFENSE_DRAW_SALT) >>> 0;
    this.#technologyCell = Object.freeze({ ...technologyCell });
    this.reset();
  }

  get balance(): number {
    return fromEconomyTenths(this.#balanceTenths);
  }

  get totals(): EconomyTotals {
    return {
      balance: this.balance,
      killIncome: fromEconomyTenths(this.#totals.killIncomeTenths),
      productionIncome: fromEconomyTenths(this.#totals.productionIncomeTenths),
      cardsMade: this.#totals.cardsMade,
      cardSpend: fromEconomyTenths(this.#totals.cardSpendTenths),
      researchSpend: fromEconomyTenths(this.#totals.researchSpendTenths),
      ...(this.#rules.miningIncomeTenthsPerHp > 0
        ? { miningIncome: fromEconomyTenths(this.#totals.miningIncomeTenths) } : {}),
    };
  }

  get cards(): CardCounts {
    return this.#cards;
  }

  get technologyCell(): GridPosition {
    return this.#technologyCell;
  }

  get toolLevel(): 1 | 2 {
    return this.#toolLevel;
  }

  get hasTechnology(): boolean {
    return this.#map.getBuilding(this.#technologyCell)?.kind === "technology";
  }

  handleEvent(event: DefenseEvent): number {
    if (event.type !== "towerKill" || this.#rewardedKills.has(event.enemyId)) return 0;
    this.#rewardedKills.add(event.enemyId);
    const credit = ECONOMY_PROTOTYPE.towerKillReward;
    const creditTenths = toEconomyTenths(credit);
    this.#balanceTenths += creditTenths;
    this.#totals.killIncomeTenths += creditTenths;
    return credit;
  }

  creditMiningDamage(actualDamage: number): number {
    if (!Number.isSafeInteger(actualDamage) || actualDamage <= 0) return 0;
    const creditTenths = actualDamage * this.#rules.miningIncomeTenthsPerHp;
    if (!Number.isSafeInteger(creditTenths) || creditTenths <= 0) return 0;
    this.#balanceTenths += creditTenths;
    this.#totals.miningIncomeTenths += creditTenths;
    return fromEconomyTenths(creditTenths);
  }

  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    for (const building of this.#map.getBuildings()) {
      if (building.kind !== "economy") continue;
      const biome = this.#map.getBiome(building.cell);
      const interval = biome === "plain" ? BIOME_PROTOTYPE.plainProductionMs : biome === "highland"
        ? BIOME_PROTOTYPE.highlandProductionMs : ECONOMY_PROTOTYPE.productionIntervalMs;
      const elapsed = (this.#productionMs.get(building.cell) ?? 0) + deltaMs;
      const creditTenths = Math.floor(elapsed / interval) * toEconomyTenths(ECONOMY_PROTOTYPE.productionAmount);
      this.#balanceTenths += creditTenths;
      this.#totals.productionIncomeTenths += creditTenths;
      this.#productionMs.set(building.cell, elapsed % interval);
    }
  }

  get drawFailure(): CardDrawFailure | undefined {
    if (!this.hasTechnology) return "technology-destroyed";
    return this.#balanceTenths < DRAW_COST_TENTHS ? "insufficient-funds" : undefined;
  }

  drawCard(): CardKind | undefined {
    if (this.drawFailure) return undefined;
    // Each paid draw advances the regular stream, including a guaranteed result.
    this.#drawState = nextDrawState(this.#drawState);
    let ticket = Math.floor(this.#drawState / 0x1_0000_0000 * DRAW_WEIGHT);
    for (const kind of CARD_KINDS) {
      ticket -= ECONOMY_PROTOTYPE.drawWeights[kind];
      if (ticket >= 0) continue;
      const guarantee = this.#totals.cardsMade + 1 === this.#rules.guaranteedDefenseDraw && !this.#hasDrawnDefense;
      const granted = guarantee
        ? (nextDrawState(this.#initialDefenseDrawState) < 0x8000_0000 ? "wall" : "tower")
        : kind;
      this.#balanceTenths -= DRAW_COST_TENTHS;
      this.#totals.cardsMade += 1;
      this.#totals.cardSpendTenths += DRAW_COST_TENTHS;
      this.#hasDrawnDefense ||= granted === "wall" || granted === "tower";
      this.updateCards(granted, 1);
      return granted;
    }
    return undefined;
  }

  placeCard(kind: CardKind, cell: GridPosition): Building | undefined {
    if (!CARD_KINDS.includes(kind) || this.#cards[kind] <= 0) return undefined;
    if (cell.col === this.#technologyCell.col && cell.row === this.#technologyCell.row) return undefined;
    const building = this.#map.placeBuilding(kind, cell, ECONOMY_PROTOTYPE.buildingHp[kind]);
    if (building) this.updateCards(kind, -1);
    return building;
  }

  researchTool(): boolean {
    if (this.#toolLevel === 2 || !this.hasTechnology || this.#balanceTenths < RESEARCH_COST_TENTHS) return false;
    this.#balanceTenths -= RESEARCH_COST_TENTHS;
    this.#totals.researchSpendTenths += RESEARCH_COST_TENTHS;
    this.#toolLevel = 2;
    return true;
  }

  rebuildTechnology(): Building | undefined {
    return this.#map.placeBuilding("technology", this.#technologyCell, ECONOMY_PROTOTYPE.buildingHp.technology);
  }

  reset(): void {
    const cell = this.#technologyCell;
    if (!this.rebuildTechnology()) {
      throw new Error(`Cannot place the technology facility at (${cell.col}, ${cell.row})`);
    }
    this.#toolLevel = 1;
    this.#balanceTenths = toEconomyTenths(this.#rules.initialBalance);
    this.#cards = this.#rules.initialCards;
    this.#drawState = this.#initialDrawState;
    this.#hasDrawnDefense = false;
    this.#productionMs = new WeakMap();
    this.#rewardedKills.clear();
    this.#totals = newTotals();
  }

  private updateCards(kind: CardKind, change: number): void {
    this.#cards = Object.freeze({ ...this.#cards, [kind]: this.#cards[kind] + change });
  }
}

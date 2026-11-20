import type { Building } from "./buildings.ts";
import { BIOME_PROTOTYPE } from "./biome-effects.ts";
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
}

function newTotals() {
  return { killIncome: 0, productionIncome: 0, cardsMade: 0, cardSpend: 0, researchSpend: 0 };
}

export const ECONOMY_PROTOTYPE = Object.freeze({
  initialBalance: 8,
  initialCards: Object.freeze({ wall: 4, tower: 2, economy: 1 }),
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
const DRAW_WEIGHT = CARD_KINDS.reduce((total, kind) => total + ECONOMY_PROTOTYPE.drawWeights[kind], 0);

export class ExpeditionEconomy {
  readonly #map: TerrainMap;
  readonly #initialDrawState: number;
  readonly #technologyCell: GridPosition;
  #toolLevel: 1 | 2 = 1;
  #balance: number = ECONOMY_PROTOTYPE.initialBalance;
  #cards: CardCounts = ECONOMY_PROTOTYPE.initialCards;
  #drawState = 0;
  #productionMs = new WeakMap<GridPosition, number>();
  readonly #rewardedKills = new Set<number>();
  #totals = newTotals();

  constructor(map: TerrainMap, seed: number, technologyCell: GridPosition = ECONOMY_PROTOTYPE.technologyCell) {
    this.#map = map;
    this.#initialDrawState = (seed ^ DRAW_SALT) >>> 0;
    this.#technologyCell = Object.freeze({ ...technologyCell });
    this.reset();
  }

  get balance(): number {
    return this.#balance;
  }

  get totals(): EconomyTotals { return { balance: this.#balance, ...this.#totals }; }

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
    this.#balance += credit;
    this.#totals.killIncome += credit;
    return credit;
  }

  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    for (const building of this.#map.getBuildings()) {
      if (building.kind !== "economy") continue;
      const biome = this.#map.getBiome(building.cell);
      const interval = biome === "plain" ? BIOME_PROTOTYPE.plainProductionMs : biome === "highland"
        ? BIOME_PROTOTYPE.highlandProductionMs : ECONOMY_PROTOTYPE.productionIntervalMs;
      const elapsed = (this.#productionMs.get(building.cell) ?? 0) + deltaMs;
      const credit = Math.floor(elapsed / interval) * ECONOMY_PROTOTYPE.productionAmount;
      this.#balance += credit;
      this.#totals.productionIncome += credit;
      this.#productionMs.set(building.cell, elapsed % interval);
    }
  }

  get drawFailure(): CardDrawFailure | undefined {
    if (!this.hasTechnology) return "technology-destroyed";
    return this.#balance < ECONOMY_PROTOTYPE.drawCost ? "insufficient-funds" : undefined;
  }

  drawCard(): CardKind | undefined {
    if (this.drawFailure) return undefined;
    this.#drawState = (Math.imul(this.#drawState, 1_664_525) + 1_013_904_223) >>> 0;
    let ticket = Math.floor(this.#drawState / 0x1_0000_0000 * DRAW_WEIGHT);
    for (const kind of CARD_KINDS) {
      ticket -= ECONOMY_PROTOTYPE.drawWeights[kind];
      if (ticket >= 0) continue;
      this.#balance -= ECONOMY_PROTOTYPE.drawCost;
      this.#totals.cardsMade += 1;
      this.#totals.cardSpend += ECONOMY_PROTOTYPE.drawCost;
      this.updateCards(kind, 1);
      return kind;
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
    const { researchCost } = TECHNOLOGY_PROTOTYPE;
    if (this.#toolLevel === 2 || !this.hasTechnology || this.#balance < researchCost) return false;
    this.#balance -= researchCost;
    this.#totals.researchSpend += researchCost;
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
    this.#balance = ECONOMY_PROTOTYPE.initialBalance;
    this.#cards = ECONOMY_PROTOTYPE.initialCards;
    this.#drawState = this.#initialDrawState;
    this.#productionMs = new WeakMap();
    this.#rewardedKills.clear();
    this.#totals = newTotals();
  }

  private updateCards(kind: CardKind, change: number): void {
    this.#cards = Object.freeze({ ...this.#cards, [kind]: this.#cards[kind] + change });
  }
}

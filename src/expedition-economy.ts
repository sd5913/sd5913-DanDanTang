import type { Building } from "./buildings.ts";
import type { DefenseEvent } from "./defense-simulation.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

export const CARD_KINDS = Object.freeze(["wall", "tower", "economy"] as const);
export type CardKind = typeof CARD_KINDS[number];
type CardCounts = Readonly<Record<CardKind, number>>;

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

const DRAW_SALT = 0x9e37_79b9;
const DRAW_WEIGHT = CARD_KINDS.reduce((total, kind) => total + ECONOMY_PROTOTYPE.drawWeights[kind], 0);

export class ExpeditionEconomy {
  readonly #map: TerrainMap;
  readonly #initialDrawState: number;
  readonly #technologyCell: GridPosition;
  #balance: number = ECONOMY_PROTOTYPE.initialBalance;
  #cards: CardCounts = ECONOMY_PROTOTYPE.initialCards;
  #drawState = 0;
  #productionMs = new WeakMap<GridPosition, number>();
  readonly #rewardedKills = new Set<number>();

  constructor(map: TerrainMap, seed: number, technologyCell: GridPosition = ECONOMY_PROTOTYPE.technologyCell) {
    this.#map = map;
    this.#initialDrawState = (seed ^ DRAW_SALT) >>> 0;
    this.#technologyCell = { ...technologyCell };
    this.reset();
  }

  get balance(): number {
    return this.#balance;
  }

  get cards(): CardCounts {
    return this.#cards;
  }

  get hasTechnology(): boolean {
    return this.#map.getBuilding(this.#technologyCell)?.kind === "technology";
  }

  handleEvent(event: DefenseEvent): void {
    if (event.type !== "towerKill" || this.#rewardedKills.has(event.enemyId)) return;
    this.#rewardedKills.add(event.enemyId);
    this.#balance += ECONOMY_PROTOTYPE.towerKillReward;
  }

  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const interval = ECONOMY_PROTOTYPE.productionIntervalMs;
    for (const building of this.#map.getBuildings()) {
      if (building.kind !== "economy") continue;
      const elapsed = (this.#productionMs.get(building.cell) ?? 0) + deltaMs;
      this.#balance += Math.floor(elapsed / interval) * ECONOMY_PROTOTYPE.productionAmount;
      this.#productionMs.set(building.cell, elapsed % interval);
    }
  }

  drawCard(): CardKind | undefined {
    if (!this.hasTechnology || this.#balance < ECONOMY_PROTOTYPE.drawCost) return undefined;
    this.#drawState = (Math.imul(this.#drawState, 1_664_525) + 1_013_904_223) >>> 0;
    let ticket = Math.floor(this.#drawState / 0x1_0000_0000 * DRAW_WEIGHT);
    for (const kind of CARD_KINDS) {
      ticket -= ECONOMY_PROTOTYPE.drawWeights[kind];
      if (ticket >= 0) continue;
      this.#balance -= ECONOMY_PROTOTYPE.drawCost;
      this.updateCards(kind, 1);
      return kind;
    }
    return undefined;
  }

  placeCard(kind: CardKind, cell: GridPosition): Building | undefined {
    if (!CARD_KINDS.includes(kind) || this.#cards[kind] <= 0) return undefined;
    const building = this.#map.placeBuilding(kind, cell, ECONOMY_PROTOTYPE.buildingHp[kind]);
    if (building) this.updateCards(kind, -1);
    return building;
  }

  reset(): void {
    const cell = this.#technologyCell;
    if (!this.#map.placeBuilding("technology", cell, ECONOMY_PROTOTYPE.buildingHp.technology)) {
      throw new Error(`Cannot place the technology facility at (${cell.col}, ${cell.row})`);
    }
    this.#balance = ECONOMY_PROTOTYPE.initialBalance;
    this.#cards = ECONOMY_PROTOTYPE.initialCards;
    this.#drawState = this.#initialDrawState;
    this.#productionMs = new WeakMap();
    this.#rewardedKills.clear();
  }

  private updateCards(kind: CardKind, change: number): void {
    this.#cards = Object.freeze({ ...this.#cards, [kind]: this.#cards[kind] + change });
  }
}

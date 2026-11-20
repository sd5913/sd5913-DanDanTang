import type { EconomyTotals } from "./expedition-economy.ts";

export interface WaveEconomySnapshot extends EconomyTotals {
  readonly waveId: number;
  readonly openingBalance: number;
  readonly net: number;
  readonly cohortKillIncome: number;
}

interface Period {
  readonly waveId: number;
  readonly opening: EconomyTotals;
  cohortKillIncome: number;
}

export class WaveEconomyHistory {
  readonly #periods = new Map<number, Period>();

  constructor(initial: EconomyTotals) {
    this.reset(initial);
  }

  reset(initial: EconomyTotals): void {
    this.#periods.clear();
    this.startWave(0, initial);
  }

  startWave(waveId: number, totals: EconomyTotals): void {
    if (!this.#periods.has(waveId)) this.#periods.set(waveId, { waveId, opening: totals, cohortKillIncome: 0 });
  }

  creditKill(waveId: number | undefined, credit: number): void {
    if (waveId === undefined || credit <= 0) return;
    const period = this.#periods.get(waveId);
    if (period) period.cohortKillIncome += credit;
  }

  snapshot(totals: EconomyTotals): readonly WaveEconomySnapshot[] {
    const periods = [...this.#periods.values()];
    return periods.map(({ waveId, opening, cohortKillIncome }, index) => {
      const closing = periods[index + 1]?.opening ?? totals;
      return {
        waveId, openingBalance: opening.balance, balance: closing.balance,
        net: closing.balance - opening.balance, cohortKillIncome,
        killIncome: closing.killIncome - opening.killIncome,
        productionIncome: closing.productionIncome - opening.productionIncome,
        cardsMade: closing.cardsMade - opening.cardsMade,
        cardSpend: closing.cardSpend - opening.cardSpend,
        researchSpend: closing.researchSpend - opening.researchSpend,
      };
    });
  }
}

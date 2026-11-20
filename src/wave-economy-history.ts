import { fromEconomyTenths, toEconomyTenths } from "./expedition-economy.ts";
import type { EconomyTotals } from "./expedition-economy.ts";

export interface WaveEconomySnapshot extends EconomyTotals {
  readonly waveId: number;
  readonly openingBalance: number;
  readonly net: number;
  readonly cohortKillIncome: number;
}

interface Period {
  readonly waveId: number;
  readonly opening: ReturnType<typeof totalsInTenths>;
  cohortKillIncomeTenths: number;
}

function totalsInTenths(totals: EconomyTotals) {
  return {
    balance: toEconomyTenths(totals.balance),
    killIncome: toEconomyTenths(totals.killIncome),
    productionIncome: toEconomyTenths(totals.productionIncome),
    cardsMade: totals.cardsMade,
    cardSpend: toEconomyTenths(totals.cardSpend),
    researchSpend: toEconomyTenths(totals.researchSpend),
    miningIncome: totals.miningIncome === undefined ? undefined : toEconomyTenths(totals.miningIncome),
    technologySpend: totals.technologySpend === undefined ? undefined : toEconomyTenths(totals.technologySpend),
  };
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
    if (!this.#periods.has(waveId)) {
      this.#periods.set(waveId, { waveId, opening: totalsInTenths(totals), cohortKillIncomeTenths: 0 });
    }
  }

  creditKill(waveId: number | undefined, credit: number): void {
    if (waveId === undefined || credit <= 0) return;
    const period = this.#periods.get(waveId);
    if (period) period.cohortKillIncomeTenths += toEconomyTenths(credit);
  }

  snapshot(totals: EconomyTotals): readonly WaveEconomySnapshot[] {
    const periods = [...this.#periods.values()];
    const current = totalsInTenths(totals);
    return periods.map(({ waveId, opening, cohortKillIncomeTenths }, index) => {
      const closing = periods[index + 1]?.opening ?? current;
      return {
        waveId, openingBalance: fromEconomyTenths(opening.balance), balance: fromEconomyTenths(closing.balance),
        net: fromEconomyTenths(closing.balance - opening.balance),
        cohortKillIncome: fromEconomyTenths(cohortKillIncomeTenths),
        killIncome: fromEconomyTenths(closing.killIncome - opening.killIncome),
        productionIncome: fromEconomyTenths(closing.productionIncome - opening.productionIncome),
        cardsMade: closing.cardsMade - opening.cardsMade,
        cardSpend: fromEconomyTenths(closing.cardSpend - opening.cardSpend),
        researchSpend: fromEconomyTenths(closing.researchSpend - opening.researchSpend),
        ...(closing.miningIncome === undefined
          ? {} : { miningIncome: fromEconomyTenths(closing.miningIncome - (opening.miningIncome ?? 0)) }),
        ...(closing.technologySpend === undefined
          ? {} : { technologySpend: fromEconomyTenths(closing.technologySpend - (opening.technologySpend ?? 0)) }),
      };
    });
  }
}

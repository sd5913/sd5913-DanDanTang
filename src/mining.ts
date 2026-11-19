import { MINING_CONFIG } from "./mining-config.ts";
import type { DigResult, GridPosition, TerrainMap } from "./terrain.ts";

const MAX_UPDATE_GAP_MS = 500;

export interface MiningTool {
  readonly damage: number;
  readonly attackIntervalMs: number;
}

export interface MiningStrike {
  readonly target: GridPosition;
  readonly result: DigResult;
}

interface ActiveMining {
  readonly target: GridPosition;
  lastUpdateMs: number;
}

export class MiningSession {
  private readonly map: Pick<TerrainMap, "getDigFailure" | "applyDigDamage">;
  private readonly tool: MiningTool;
  private active?: ActiveMining;
  private nextAttackMs = -Infinity;

  constructor(map: Pick<TerrainMap, "getDigFailure" | "applyDigDamage">, tool: MiningTool = MINING_CONFIG) {
    if (!Number.isFinite(tool.attackIntervalMs) || tool.attackIntervalMs <= 0) {
      throw new RangeError("The mining attack interval must be positive and finite");
    }
    this.map = map;
    this.tool = { damage: tool.damage, attackIntervalMs: tool.attackIntervalMs };
  }

  begin(from: GridPosition, { col, row }: GridPosition, nowMs: number): MiningStrike | undefined {
    const target = Object.freeze({ col, row });
    this.stop();
    if (!Number.isFinite(nowMs)) return;

    // A legal press during cooldown locks its target without spending a strike.
    if (nowMs < this.nextAttackMs && !this.map.getDigFailure(from, target)) {
      this.active = { target, lastUpdateMs: nowMs };
      return;
    }

    const result = this.map.applyDigDamage(from, target, this.tool.damage);
    if (result.effective) {
      this.nextAttackMs = nowMs + this.tool.attackIntervalMs;
      if (!result.cleared) this.active = { target, lastUpdateMs: nowMs };
    }
    return { target, result };
  }

  update(from: GridPosition, nowMs: number): MiningStrike | undefined {
    const active = this.active;
    if (!active) return;

    const elapsed = nowMs - active.lastUpdateMs;
    if (!(elapsed >= 0 && elapsed <= MAX_UPDATE_GAP_MS) || this.map.getDigFailure(from, active.target)) {
      this.stop();
      return;
    }
    active.lastUpdateMs = nowMs;

    let result: DigResult | undefined;
    // Keep the original cadence across short stalls and stop at the clearing strike.
    while (nowMs >= this.nextAttackMs) {
      result = this.map.applyDigDamage(from, active.target, this.tool.damage);
      if (result.effective) this.nextAttackMs += this.tool.attackIntervalMs;
      if (!result.effective || result.cleared) {
        this.stop();
        break;
      }
    }

    if (result) return { target: active.target, result };
  }

  stop(): void {
    this.active = undefined;
  }

  reset(): void {
    this.stop();
    this.nextAttackMs = -Infinity;
  }
}

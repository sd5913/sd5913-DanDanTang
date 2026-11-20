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
  // A cleared target leaves the hold active for the next adjacent tile.
  readonly target: GridPosition | null;
  lastUpdateMs: number;
}

export class MiningSession {
  private readonly map: Pick<TerrainMap, "getDigFailure" | "applyDigDamage">;
  private readonly tool: MiningTool;
  private readonly getToolLevel: () => number;
  private active?: ActiveMining;
  private nextAttackMs = -Infinity;

  constructor(
    map: Pick<TerrainMap, "getDigFailure" | "applyDigDamage">,
    tool: MiningTool = MINING_CONFIG,
    getToolLevel: () => number = () => 1,
  ) {
    if (!Number.isFinite(tool.attackIntervalMs) || tool.attackIntervalMs <= 0) {
      throw new RangeError("The mining attack interval must be positive and finite");
    }
    this.map = map;
    this.tool = { damage: tool.damage, attackIntervalMs: tool.attackIntervalMs };
    this.getToolLevel = getToolLevel;
  }

  begin(from: GridPosition, { col, row }: GridPosition, nowMs: number): MiningStrike | undefined {
    const target = Object.freeze({ col, row });
    this.stop();
    if (!Number.isFinite(nowMs)) return;
    const toolLevel = this.getToolLevel();

    // A legal press during cooldown locks its target without spending a strike.
    if (nowMs < this.nextAttackMs && !this.map.getDigFailure(from, target, toolLevel)) {
      this.active = { target, lastUpdateMs: nowMs };
      return;
    }

    const result = this.map.applyDigDamage(from, target, this.tool.damage, toolLevel);
    if (result.effective) {
      this.nextAttackMs = nowMs + this.tool.attackIntervalMs;
      this.active = { target: result.cleared ? null : target, lastUpdateMs: nowMs };
    }
    return { target, result };
  }

  getTarget(from: GridPosition, nextCell: GridPosition | null = null): GridPosition | null {
    return this.selectTarget(from, nextCell, this.getToolLevel());
  }

  private selectTarget(from: GridPosition, nextCell: GridPosition | null, toolLevel: number): GridPosition | null {
    if (!this.active) return null;
    const target = this.active.target ?? nextCell;
    return target && !this.map.getDigFailure(from, target, toolLevel) ? target : null;
  }

  update(from: GridPosition, nowMs: number, nextCell: GridPosition | null = null): MiningStrike | undefined {
    const active = this.active;
    if (!active) return;

    const elapsed = nowMs - active.lastUpdateMs;
    if (!(elapsed >= 0 && elapsed <= MAX_UPDATE_GAP_MS)) {
      this.stop();
      return;
    }
    active.lastUpdateMs = nowMs;

    const toolLevel = this.getToolLevel();
    const target = this.selectTarget(from, nextCell, toolLevel);
    if (!target) {
      if (active.target) this.stop();
      return;
    }
    if (!active.target) {
      return nowMs >= this.nextAttackMs ? this.begin(from, target, nowMs) : undefined;
    }

    let result: DigResult | undefined;
    let damage = 0;
    // Keep the original cadence across short stalls and stop at the clearing strike.
    while (nowMs >= this.nextAttackMs) {
      const strike = this.map.applyDigDamage(from, target, this.tool.damage, toolLevel);
      if (!strike.effective) {
        this.stop();
        result ??= strike;
        break;
      }
      damage += strike.damage;
      result = strike;
      this.nextAttackMs += this.tool.attackIntervalMs;
      if (strike.cleared) {
        this.active = { target: null, lastUpdateMs: nowMs };
        break;
      }
    }

    if (result?.effective && damage > result.damage) result = { ...result, damage };
    if (result) return { target, result };
  }

  stop(): void {
    this.active = undefined;
  }

  reset(): void {
    this.stop();
    this.nextAttackMs = -Infinity;
  }
}

import type Phaser from "phaser";
import type { ExpeditionRound } from "./expedition-round.ts";

interface BatchProgress {
  readonly batch: number;
  readonly planned: number;
  readonly spawned: number;
  readonly resolved: number;
  readonly active: number;
  readonly pending: number;
  readonly deviceContacts: number;
  readonly deviceDamage: number;
}

function field<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error("Missing evacuation field #" + id);
  return element as T;
}

function write(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export class EvacuationHud {
  private readonly panel = field("evacuation");
  private readonly start = field<HTMLButtonElement>("evacuation-start");
  private readonly goal = field("goal-status");
  private readonly health = field("evacuation-health");
  private readonly progress = field("evacuation-progress");
  private readonly route = field("evacuation-route");

  constructor(scene: Phaser.Scene, activate: () => void) {
    this.panel.hidden = false;
    this.start.addEventListener("click", activate);
    scene.events.once("shutdown", () => {
      this.start.removeEventListener("click", activate);
      this.panel.hidden = true;
      this.start.hidden = true;
    });
  }

  update(round: ExpeditionRound, records: readonly BatchProgress[], canActivate: boolean, blocked: boolean, peak: number): void {
    const status = round.evacuation;
    const done = round.phase === "won" || round.phase === "lost";
    const outcome = round.lossReason ?? (round.phase === "won" ? "won" : "");
    const totals = records.reduce((total, batch) => ({
      spawned: total.spawned + batch.spawned,
      resolved: total.resolved + batch.resolved,
      active: total.active + batch.active,
      pending: total.pending + batch.pending,
      contacts: total.contacts + batch.deviceContacts,
      damage: total.damage + batch.deviceDamage,
    }), { spawned: 0, resolved: 0, active: 0, pending: 0, contacts: 0, damage: 0 });
    for (const [key, value] of Object.entries({
      ...totals, hp: status?.hp ?? 0, planned: status?.planned ?? 0, batch: status?.batch ?? 0, peak, outcome,
      firstSpawned: records.find(({ batch }) => batch === 1)?.spawned ?? 0,
      secondSpawned: records.find(({ batch }) => batch === 2)?.spawned ?? 0,
    })) {
      const text = String(value);
      if (this.panel.dataset[key] !== text) this.panel.dataset[key] = text;
    }
    const prompt = round.phase === "won" ? "撤离成功 · 最终敌袭已清场"
      : round.phase === "lost" ? (outcome === "evacuation" ? "战败 · 撤离装置已摧毁" : "战败 · 玩家生命耗尽")
      : status ? "撤离装置已启动 · 守住装置并清场"
      : canActivate ? "撤离装置已就绪" : "升级 Lv.2 工具，抵达北端。靠近装置后按 E 启动撤离防守。";
    write(this.goal, prompt);
    this.start.hidden = !canActivate;
    this.health.hidden = !status;
    this.progress.hidden = !status;
    const showBlocked = !done && Boolean(status) && blocked;
    this.route.hidden = !showBlocked;
    if (showBlocked) write(this.route, "南端通路或入口受阻 · 检查挖掘路线和建筑占用");
    if (!status) return;
    write(this.health, "装置耐久 " + status.hp + "/" + status.maxHp + " HP");
    write(this.progress, "第 " + status.batch + "/2 批 · 已出兵 " + totals.spawned + "/" + status.planned
      + " · 已清场 " + totals.resolved + "/" + status.planned);
  }
}

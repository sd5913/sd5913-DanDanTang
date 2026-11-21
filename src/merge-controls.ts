import type Phaser from "phaser";
import { isWithinSynthesisRange } from "./buildings.ts";
import type { Building, ReadyBuildingSynthesis } from "./buildings.ts";
import type { MergeRoutePreview } from "./merge-route-preview.ts";
import type { GridPosition, TerrainMap } from "./terrain.ts";

interface MergeActions {
  playerCell(): GridPosition;
  isVisible(cell: GridPosition): boolean;
  isKnown(cell: GridPosition): boolean;
  roundEnded(): boolean;
  previewRoute(candidate: ReadyBuildingSynthesis, force?: boolean): MergeRoutePreview;
  describe(building: Building): { name: string; attributes: string };
  feedback(message: string): void;
  merged(building: Building, released: readonly GridPosition[]): void;
}

function write(field: HTMLElement, text: string): void {
  if (field.textContent !== text) field.textContent = text;
}

function coordinates({ col, row }: GridPosition): string { return "(" + col + ", " + row + ")"; }

function routeMessage(route: MergeRoutePreview): string {
  if (route.kind === "unknown") return "路线风险暂无法判定";
  const sample = route.representative === "enemy" ? "可见敌人样本 · " : "入口样本 · ";
  const boundary = "boundary" in route && route.boundary === "wall" ? "（至同一堵墙）" : "";
  const distances = "before" in route && "after" in route && route.before !== undefined && route.after !== undefined
    ? " · " + route.before + " → " + route.after + " 格" + boundary : "";
  switch (route.kind) {
    case "shorter": return sample + "合成可能形成敌人捷径" + distances;
    case "opened": return sample + "合成可能打开可直接通行的路线";
    case "unchanged": return sample + "路线无明显缩短" + distances;
    case "target-changed": return "敌人目标可能变化，无法直接比较路线长度";
  }
}

export class MergeControls {
  private readonly panel = document.getElementById("merge-controls")!;
  private readonly name = document.getElementById("merge-name")!;
  private readonly attributes = document.getElementById("merge-attributes")!;
  private readonly tiles = document.getElementById("merge-tiles")!;
  private readonly risk = document.getElementById("merge-risk")!;
  private readonly hint = document.getElementById("merge-hint")!;
  private readonly action = document.querySelector<HTMLButtonElement>("#merge-confirm")!;
  private readonly map: TerrainMap;
  private readonly actions: MergeActions;
  private selected?: ReadyBuildingSynthesis;
  private described?: ReadyBuildingSynthesis;

  constructor(map: TerrainMap, actions: MergeActions, scene: Phaser.Scene) {
    this.map = map;
    this.actions = actions;
    const events = new AbortController();
    const options = { signal: events.signal };
    this.action.addEventListener("click", () => this.execute(), options);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.selected) this.clearSelection();
    }, options);
    scene.events.once("shutdown", () => {
      events.abort();
      this.clearSelection();
    });
  }

  selectAt(cell: GridPosition): boolean {
    if (this.actions.roundEnded()) return false;
    const candidate = this.atVisibleAnchor(cell);
    if (!candidate) {
      this.clearSelection();
      return false;
    }
    this.selected = candidate;
    this.render(null, false);
    return true;
  }

  render(hover: GridPosition | null, placing: boolean): ReadyBuildingSynthesis | undefined {
    if (placing || this.actions.roundEnded()) {
      this.clearSelection();
      return;
    }

    const selected = this.selected;
    const candidate = selected ? this.current(selected) : hover ? this.atVisibleAnchor(hover) : undefined;
    if (!candidate) {
      if (selected) this.actions.feedback("合成组合已失效，请重新选择");
      this.clearSelection();
      return;
    }

    if (this.described !== candidate) {
      const { name, attributes } = this.actions.describe(candidate.upgraded);
      write(this.name, "可合成 · " + name);
      write(this.attributes, attributes);
      write(this.tiles, "保留 " + coordinates(candidate.retained) + " · 释放 " + candidate.released.map(coordinates).join("、"));
      this.described = candidate;
    }

    const near = isWithinSynthesisRange(candidate, this.actions.playerCell());
    this.showRisk(this.actions.previewRoute(candidate));
    write(this.hint, !near ? "靠近任一参与建筑一格内才能合成" : !selected ? "点击地图上的可合成建筑进行选择" : "");
    if (this.action.hidden !== !selected) this.action.hidden = !selected;
    if (this.action.disabled !== !near) this.action.disabled = !near;
    if (this.panel.hidden) this.panel.hidden = false;
    return candidate;
  }

  clearSelection(): void {
    this.selected = undefined;
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.action.hidden = true;
    this.described = undefined;
    delete this.risk.dataset.state;
    for (const field of [this.name, this.attributes, this.tiles, this.risk, this.hint]) write(field, "");
  }

  private disclosed(candidate?: ReadyBuildingSynthesis): ReadyBuildingSynthesis | undefined {
    return candidate?.participants.every(({ cell }) => this.actions.isKnown(cell)) ? candidate : undefined;
  }

  private atVisibleAnchor(cell: GridPosition): ReadyBuildingSynthesis | undefined {
    return this.actions.isVisible(cell) ? this.disclosed(this.map.previewReadySynthesis(cell)) : undefined;
  }

  private current(expected: ReadyBuildingSynthesis): ReadyBuildingSynthesis | undefined {
    const candidate = this.disclosed(this.map.previewReadySynthesis(expected.retained));
    return candidate?.key === expected.key ? candidate : undefined;
  }

  private showRisk(route: MergeRoutePreview): void {
    if (this.risk.dataset.state !== route.kind) this.risk.dataset.state = route.kind;
    write(this.risk, routeMessage(route));
  }

  private execute(): void {
    const expected = this.selected;
    if (!expected || this.actions.roundEnded()) return;
    const current = this.current(expected);
    if (!current) {
      this.clearSelection();
      this.actions.feedback("合成组合已失效，请重新选择");
      return;
    }
    const playerCell = this.actions.playerCell();
    if (!isWithinSynthesisRange(current, playerCell)) {
      this.actions.feedback("距离过远，靠近任一参与建筑再合成");
      return;
    }

    const route = this.actions.previewRoute(current, true);
    if (this.risk.textContent !== routeMessage(route) || this.risk.dataset.state !== route.kind) {
      this.showRisk(route);
      this.actions.feedback("路线预览已更新，请查看后再合成");
      return;
    }
    const result = this.map.executeBuildingSynthesis(current, playerCell);
    this.clearSelection();
    if (result.success) {
      this.actions.merged(result.building, result.released);
    } else {
      this.actions.feedback(result.reason === "out-of-range" ? "距离过远" : "合成组合已失效，请重新选择");
    }
  }
}

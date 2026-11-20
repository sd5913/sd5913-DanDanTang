import { DEFAULT_MAP_SEED } from "./generated-map.ts";
import type { ExpeditionWorld } from "./generated-map.ts";

function randomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export function selectWorldSeed(parameter: string | null, draw = randomUint32): number {
  if (parameter === null) return draw();
  const seed = Number(parameter);
  return /^\d+$/.test(parameter) && seed <= 0xffff_ffff ? seed : DEFAULT_MAP_SEED;
}

export function newWorldSeed(
  current: Pick<ExpeditionWorld, "requestedSeed" | "effectiveSeed">, draw = randomUint32,
): number {
  const matchesCurrent = (seed: number) => seed === current.requestedSeed || seed === current.effectiveSeed;
  let seed = draw();
  if (matchesCurrent(seed)) seed = draw();
  while (matchesCurrent(seed)) seed = (seed + 1) >>> 0;
  return seed;
}

export function worldSeedLabel(world: ExpeditionWorld): string {
  const fallback = world.usedFallback ? `已启用（请求种子 ${world.requestedSeed}）` : "未启用";
  return `种子 ${world.effectiveSeed} · 生成器 v${world.generatorVersion} · 备用布局 ${fallback}`;
}

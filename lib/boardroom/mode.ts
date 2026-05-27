import type { AdvisorName, Depth, Lane, ModeContext } from "@/lib/types";

export function normalizeDepth(value: unknown): Depth {
  return value === "quick" || value === "deep" ? value : "normal";
}

export function normalizeLane(value: unknown): Lane {
  return value === "life" || value === "technical" ? value : "business";
}

export function modeContext(input?: Partial<ModeContext>): ModeContext {
  const depth = normalizeDepth(input?.depth);
  const lane = normalizeLane(input?.lane);
  const laneAdvisor = ({ business: "Russell", life: "Calvina", technical: "Andrej" } as Record<Lane, AdvisorName>)[lane];
  return {
    depth,
    lane,
    laneAdvisor,
    cardLimit: depth === "quick" ? 1 : depth === "normal" ? 2 : 3
  };
}

export function depthLabel(depth: Depth) {
  return ({ quick: "Quick", normal: "Normal", deep: "Deep" })[depth];
}

export function laneLabel(lane: Lane) {
  return ({ business: "Business", life: "Life", technical: "Technical" })[lane];
}

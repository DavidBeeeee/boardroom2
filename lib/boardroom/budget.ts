import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side DeepSeek cost and usage bound (WO-20260927-evening, Developer 99).
//
// A single boardroom session fans out many DeepSeek calls (Tony, each advisor
// in parallel, Chanos, the close). With no ceiling, a runaway loop or an abused
// workspace could spend without limit. This enforces two per-workspace caps over
// a rolling window, read from the same boardroom_logs the observability layer
// writes, so the bound is real usage rather than a guess.
//
// Caps are env-configurable so they can be tuned without a deploy. The defaults
// are generous for a legitimate mastermind workspace and only bite on abuse.

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type BudgetStatus = {
  windowHours: number;
  calls: number;
  maxCalls: number;
  tokens: number;
  maxTokens: number;
};

export async function checkDeepSeekBudget(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<BudgetStatus> {
  const windowHours = envInt("DEEPSEEK_WINDOW_HOURS", 24);
  const maxCalls = envInt("DEEPSEEK_MAX_CALLS_PER_WINDOW", 400);
  const maxTokens = envInt("DEEPSEEK_MAX_TOKENS_PER_WINDOW", 3_000_000);

  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("boardroom_logs")
    .select("total_tokens")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "deepseek_call")
    .eq("status", "success")
    .gte("created_at", since);

  // Fail open on a read error: never block a real session because the meter
  // itself is unavailable. The observability layer records the call regardless.
  if (error) {
    console.error("[boardroom budget] usage read failed:", error.message);
    return { windowHours, calls: 0, maxCalls, tokens: 0, maxTokens };
  }

  const rows = data ?? [];
  const calls = rows.length;
  const tokens = rows.reduce((sum, r) => sum + (Number(r.total_tokens) || 0), 0);

  return { windowHours, calls, maxCalls, tokens, maxTokens };
}

// Throws BudgetExceededError when the workspace is over either cap.
export async function assertDeepSeekBudget(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<BudgetStatus> {
  const status = await checkDeepSeekBudget(supabase, workspaceId);
  if (status.calls >= status.maxCalls) {
    throw new BudgetExceededError(
      `You've reached this workspace's advisor limit for the last ${status.windowHours} hours (${status.calls} of ${status.maxCalls} calls). The room opens again as older activity ages out of the window. Nothing you've saved is affected.`,
    );
  }
  if (status.tokens >= status.maxTokens) {
    throw new BudgetExceededError(
      `You've reached this workspace's advisor limit for the last ${status.windowHours} hours. The room opens again as older activity ages out of the window. Nothing you've saved is affected.`,
    );
  }
  return status;
}

// Telling the member the rule before they hit it (WBR-373 continuation,
// Stranger 26, 68). The plain rule always shows in Settings; the warning shows
// once a workspace has used 75% of either cap in the current window.
export const BUDGET_WARN_AT = 0.75;

export function budgetRule(status: Pick<BudgetStatus, "windowHours">): string {
  return `Each workspace can run a set amount of advisor work in any rolling ${status.windowHours} hours. A full Boardroom session uses about 8 to 12 advisor calls, so the limit only matters on a very heavy day. If you reach it, the room pauses and opens again as older activity ages out of the window. Nothing you've saved is affected.`;
}

export function budgetNotice(status: BudgetStatus): string | null {
  const used = Math.max(status.calls / status.maxCalls, status.tokens / status.maxTokens);
  if (!Number.isFinite(used) || used < BUDGET_WARN_AT) return null;
  const pct = Math.min(100, Math.round(used * 100));
  if (used >= 1) return `You've used all of this workspace's advisor capacity for the last ${status.windowHours} hours. The room opens again as older activity ages out of the window. Nothing you've saved is affected.`;
  return `Heads up: you've used about ${pct}% of this workspace's advisor capacity for the last ${status.windowHours} hours. A full session uses about 8 to 12 advisor calls, so Quick depth or Tony Only will stretch what's left.`;
}

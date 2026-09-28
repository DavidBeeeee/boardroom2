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
      `Boardroom usage limit reached: ${status.calls} advisor calls in the last ${status.windowHours}h (cap ${status.maxCalls}). Try again later.`,
    );
  }
  if (status.tokens >= status.maxTokens) {
    throw new BudgetExceededError(
      `Boardroom usage limit reached: ${status.tokens.toLocaleString()} tokens in the last ${status.windowHours}h (cap ${status.maxTokens.toLocaleString()}). Try again later.`,
    );
  }
  return status;
}

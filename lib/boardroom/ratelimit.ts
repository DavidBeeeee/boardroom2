import type { SupabaseClient } from "@supabase/supabase-js";

// AI Boardroom burst rate limit (WO-20261016-evening, WBR-373, Developer 97).
//
// The DeepSeek budget (budget.ts) bounds a workspace over a rolling day. It does
// nothing about one member hammering Send, which fans every click out into a
// Tony call and an advisor round before the daily cap notices. This bounds each
// member in each workspace over a short burst window, per route scope.
//
// Counted from a dedicated table, boardroom_request_events, rather than from
// boardroom_logs: log writes are fire-and-forget and can land after the next
// request has already been counted, and boardroom_logs has no index on the
// member, so counting it would put a wider scan on every chat turn. The events
// table is narrow, indexed on (workspace, member, scope, time), and each member
// occasionally clears their own rows older than a day (the only delete RLS
// allows), so it never grows past roughly a day of traffic.
//
// Fails open, like the budget meter: an unreadable counter never blocks a real
// session.

export type RateScope = "chat" | "chat_stage";

export class RateLimitedError extends Error {
  retryAfterSeconds: number;
  scope: RateScope;
  constructor(message: string, retryAfterSeconds: number, scope: RateScope) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.scope = scope;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type RateConfig = { windowSeconds: number; max: number };

// A full session is one chat turn plus at most a handful of stage calls, so
// these only bite on a stuck client or a member pasting in a loop.
export function rateConfig(scope: RateScope): RateConfig {
  const windowSeconds = envInt("BOARDROOM_RATE_WINDOW_SECONDS", 60);
  const max = scope === "chat"
    ? envInt("BOARDROOM_RATE_MAX_CHAT", 8)
    : envInt("BOARDROOM_RATE_MAX_STAGE", 30);
  return { windowSeconds, max };
}

export type RateStore = {
  // Timestamps (ms) of this member's requests in the window, oldest first.
  recent(input: { workspaceId: string; userId: string; scope: RateScope; sinceIso: string }): Promise<number[]>;
  record(input: { workspaceId: string; userId: string; scope: RateScope }): Promise<void>;
};

export function createSupabaseRateStore(supabase: SupabaseClient): RateStore {
  return {
    async recent({ workspaceId, userId, scope, sinceIso }) {
      const { data, error } = await supabase
        .from("boardroom_request_events")
        .select("created_at")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .eq("scope", scope)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []).map(row => Date.parse(String(row.created_at))).filter(Number.isFinite);
    },
    async record({ workspaceId, userId, scope }) {
      const { error } = await supabase
        .from("boardroom_request_events")
        .insert({ workspace_id: workspaceId, user_id: userId, scope });
      if (error) throw new Error(error.message);
      if (Math.random() < 0.05) {
        const cutoff = new Date(Date.now() - 86_400_000).toISOString();
        const { error: pruneError } = await supabase
          .from("boardroom_request_events").delete()
          .eq("user_id", userId).lt("created_at", cutoff);
        if (pruneError) console.error("[boardroom ratelimit] prune failed:", pruneError.message);
      }
    },
  };
}

// Plain words, no em dashes. Says when they can send again.
export function rateLimitMessage(retryAfterSeconds: number, scope: RateScope): string {
  const wait = retryAfterSeconds <= 1
    ? "in a second"
    : retryAfterSeconds < 60
      ? `in about ${retryAfterSeconds} seconds`
      : `in about ${Math.ceil(retryAfterSeconds / 60)} minute${Math.ceil(retryAfterSeconds / 60) === 1 ? "" : "s"}`;
  const kept = scope === "chat"
    ? "Your message was not sent, so it is back in the box below."
    : "Everything said so far is saved.";
  return `You're sending faster than the room can keep up with. You can send again ${wait}. ${kept} Press Retry when you're ready.`;
}

// Throws RateLimitedError when this member is at the cap for this scope;
// otherwise records the request and returns. `now` is injectable for tests.
export async function assertRateLimit(
  store: RateStore,
  input: { workspaceId: string; userId: string; scope: RateScope },
  now: number = Date.now(),
): Promise<void> {
  const { windowSeconds, max } = rateConfig(input.scope);
  const since = now - windowSeconds * 1000;
  let recent: number[];
  try {
    recent = await store.recent({ ...input, sinceIso: new Date(since).toISOString() });
  } catch (error) {
    console.error("[boardroom ratelimit] read failed:", error instanceof Error ? error.message : error);
    return;
  }
  const inWindow = recent.filter(t => t >= since).sort((a, b) => a - b);
  if (inWindow.length >= max) {
    // The window frees up when the oldest counted request ages out of it.
    const oldest = inWindow[inWindow.length - max];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000));
    throw new RateLimitedError(rateLimitMessage(retryAfterSeconds, input.scope), retryAfterSeconds, input.scope);
  }
  try {
    await store.record(input);
  } catch (error) {
    console.error("[boardroom ratelimit] record failed:", error instanceof Error ? error.message : error);
  }
}

// The degraded-notice shape the client already understands (degraded.ts):
// error, retryable, failedService, plus when they can send again.
export function rateLimitedBody(error: RateLimitedError) {
  return {
    error: error.message,
    retryable: true as const,
    failedService: "rate_limit" as const,
    retryAfterSeconds: error.retryAfterSeconds,
  };
}

import type { SupabaseClient } from "@supabase/supabase-js";

// AI Boardroom idempotency (WO-20261002-evening, Stream A; Developer 13,15,16,33).
//
// Every member-initiated state-changing request carries a one-time key. The
// first request with a given (workspace, scope, key) claims the key, runs the
// work, and stores its response. A resent or redelivered request with the same
// key never runs the work again: it replays the stored response, so no message,
// card, memory row or conversation is duplicated and DeepSeek is not billed a
// second time.
//
// The orchestration below is deliberately split from Supabase so it can be
// tested directly against an in-memory store: the decision tree (fresh / replay
// / in-flight, and release-on-failure) is where the correctness lives. The
// Supabase-backed store is a thin adapter verified live against the database.

export type IdempotencyScope = "chat" | "chat_stage" | "document";

const UNIQUE_VIOLATION = "23505";

// A client-supplied key must be stable across a retry of the same action and
// distinct across different actions. We accept URL-safe tokens of a sane length;
// anything else is treated as absent so the caller can fall back to a random key
// (which simply means "no dedup for this request").
export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  if (key.length < 8 || key.length > 200) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  return key;
}

export type ClaimResult =
  | { state: "claimed"; id: string }
  | { state: "exists"; status: "in_progress" | "completed"; response: unknown };

export interface IdempotencyStore {
  claim(input: {
    workspaceId: string;
    scope: string;
    key: string;
    userId: string | null;
  }): Promise<ClaimResult>;
  complete(id: string, response: unknown): Promise<void>;
  release(id: string): Promise<void>;
}

export type IdempotencyOutcome<T> =
  | { kind: "fresh"; response: T }
  | { kind: "replay"; response: T }
  | { kind: "in_flight" };

export async function withIdempotency<T>(
  store: IdempotencyStore,
  ctx: { workspaceId: string; scope: string; key: string; userId?: string | null },
  work: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const claim = await store.claim({
    workspaceId: ctx.workspaceId,
    scope: ctx.scope,
    key: ctx.key,
    userId: ctx.userId ?? null,
  });

  if (claim.state === "exists") {
    if (claim.status === "completed") {
      return { kind: "replay", response: claim.response as T };
    }
    // A duplicate arrived while the first is still running. Do not run the work
    // again and do not guess a response; tell the caller to retry shortly.
    return { kind: "in_flight" };
  }

  try {
    const response = await work();
    await store.complete(claim.id, response);
    return { kind: "fresh", response };
  } catch (error) {
    // The work failed, so the key must not stay claimed forever: release it so a
    // genuine retry can run. Releasing is best-effort; the original error wins.
    await store.release(claim.id).catch(() => {});
    throw error;
  }
}

// Supabase-backed store. Claims by inserting an in_progress row; a unique
// violation means the key already exists, which we then read back. Writes go
// through the caller's RLS-scoped client, so keys are walled off per workspace
// exactly like messages.
export function createSupabaseIdempotencyStore(supabase: SupabaseClient): IdempotencyStore {
  const table = "boardroom_idempotency_keys";
  return {
    async claim({ workspaceId, scope, key, userId }) {
      const inserted = await supabase
        .from(table)
        .insert({
          workspace_id: workspaceId,
          scope,
          idempotency_key: key,
          status: "in_progress",
          created_by: userId,
        })
        .select("id")
        .single();

      if (!inserted.error && inserted.data) {
        return { state: "claimed", id: inserted.data.id as string };
      }

      const code = (inserted.error as { code?: string } | null)?.code;
      if (code !== UNIQUE_VIOLATION) {
        throw inserted.error ?? new Error("Idempotency claim failed.");
      }

      const existing = await supabase
        .from(table)
        .select("status,response")
        .eq("workspace_id", workspaceId)
        .eq("scope", scope)
        .eq("idempotency_key", key)
        .maybeSingle();

      if (existing.error) throw existing.error;
      if (!existing.data) {
        // The row vanished between the conflict and the read (a concurrent
        // release). Treat it as still in flight rather than running the work
        // blind; the client retry will claim it cleanly.
        return { state: "exists", status: "in_progress", response: null };
      }
      return {
        state: "exists",
        status: existing.data.status as "in_progress" | "completed",
        response: existing.data.response ?? null,
      };
    },

    async complete(id, response) {
      const { error } = await supabase
        .from(table)
        .update({
          status: "completed",
          response: response ?? {},
          completed_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },

    async release(id) {
      await supabase.from(table).delete().eq("id", id).eq("status", "in_progress");
    },
  };
}

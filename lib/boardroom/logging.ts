import type { SupabaseClient } from "@supabase/supabase-js";

// AI Boardroom observability (WO-20260927-evening, Stream A).
//
// Before this the app wrote no operational logs at all, so a broken generation
// or a dropped write was invisible until a member reported it. This module
// records three kinds of event to public.boardroom_logs:
//
//   - "turn"          every conversation turn the engine produces
//   - "deepseek_call" every DeepSeek call, with its outcome: success,
//                     generation_failure (the API errored or returned empty),
//                     or parse_fallback (the call returned but its JSON could
//                     not be parsed and a fallback was used)
//   - "state_write"   every state-changing write to a boardroom_* table
//
// Logging is best-effort and must NEVER break a request or an LLM call: every
// write is fire-and-forget, failures are swallowed (surfaced to the server
// console only), and callers flush() pending writes at the end of a request.
// Writes go through the caller's RLS-scoped client, so a workspace's logs are
// walled off exactly like its messages.

export type LogEventType = "turn" | "deepseek_call" | "state_write" | "safety";

export type LogStatus =
  | "success"
  | "generation_failure"
  | "parse_fallback"
  | "ok"
  | "error";

export type DeepSeekUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type LogRow = {
  workspace_id: string;
  conversation_id: string | null;
  event_type: LogEventType;
  stage: string;
  speaker: string;
  status: LogStatus;
  model: string;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  detail: Record<string, unknown>;
  created_by: string | null;
};

export type BoardroomLogger = {
  turn(input: { stage?: string; speaker?: string; detail?: Record<string, unknown> }): void;
  deepseek(input: {
    stage?: string;
    speaker?: string;
    status: LogStatus;
    model?: string;
    latencyMs?: number;
    usage?: DeepSeekUsage;
    detail?: Record<string, unknown>;
  }): void;
  stateWrite(input: {
    table: string;
    status?: LogStatus;
    stage?: string;
    detail?: Record<string, unknown>;
  }): void;
  // A member message tripped the crisis check (WBR-373 Stream B). Records the
  // category and pattern id only, never the member's words.
  safety(input: { category: string; patternId: string; stage?: string }): void;
  flush(): Promise<void>;
};

function toInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function createBoardroomLogger(
  supabase: SupabaseClient,
  ctx: { workspaceId: string; conversationId?: string | null; userId?: string | null },
): BoardroomLogger {
  const pending = new Set<Promise<unknown>>();

  const enqueue = (row: LogRow) => {
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(supabase.from("boardroom_logs").insert(row))
        .then((res: { error?: { message?: string } | null }) => {
          if (res && res.error) {
            console.error("[boardroom_logs] insert failed:", res.error.message);
          }
        })
        .catch((err: unknown) => {
          console.error("[boardroom_logs] insert threw:", err);
        });
    } catch (err) {
      console.error("[boardroom_logs] enqueue threw:", err);
      p = Promise.resolve();
    }
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  const base = (): Omit<LogRow, "event_type" | "status"> => ({
    workspace_id: ctx.workspaceId,
    conversation_id: ctx.conversationId ?? null,
    stage: "",
    speaker: "",
    model: "",
    latency_ms: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    detail: {},
    created_by: ctx.userId ?? null,
  });

  return {
    turn(input) {
      enqueue({
        ...base(),
        event_type: "turn",
        status: "success",
        stage: input.stage ?? "",
        speaker: input.speaker ?? "",
        detail: input.detail ?? {},
      });
    },
    deepseek(input) {
      enqueue({
        ...base(),
        event_type: "deepseek_call",
        status: input.status,
        stage: input.stage ?? "",
        speaker: input.speaker ?? "",
        model: input.model ?? "",
        latency_ms: input.latencyMs ?? null,
        prompt_tokens: toInt(input.usage?.prompt_tokens),
        completion_tokens: toInt(input.usage?.completion_tokens),
        total_tokens: toInt(input.usage?.total_tokens),
        detail: input.detail ?? {},
      });
    },
    stateWrite(input) {
      enqueue({
        ...base(),
        event_type: "state_write",
        status: input.status ?? "ok",
        stage: input.stage ?? "",
        detail: { table: input.table, ...(input.detail ?? {}) },
      });
    },
    safety(input) {
      enqueue({
        ...base(),
        event_type: "safety",
        status: "ok",
        stage: input.stage ?? "safety_pause",
        speaker: "AI Boardroom",
        detail: { category: input.category, patternId: input.patternId, advisorRoundsSkipped: true },
      });
    },
    async flush() {
      await Promise.allSettled(Array.from(pending));
    },
  };
}

// Threaded through the engine so a DeepSeek call and any JSON parse-fallback are
// attributed to the turn that caused them.
export type LogMeta = {
  logger?: BoardroomLogger;
  stage?: string;
  speaker?: string;
};

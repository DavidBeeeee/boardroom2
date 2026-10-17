import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError, requestIdempotencyKey, WorkspaceAccessError, workspaceLocked, workspaceOwnerIsAdmin } from "@/lib/supabase/server";
import { memoryForChannel } from "@/lib/boardroom/lapse";
import { buildBoardroomContext } from "@/lib/boardroom/context";
import { runAdvisorRound, runChanosRound, runTonyClose, guardMemoryContent } from "@/lib/boardroom/engine";
import { memberEvidence } from "@/lib/boardroom/claims";
import type { SessionState } from "@/lib/boardroom/engine";
import { modeContext } from "@/lib/boardroom/mode";
import { createBoardroomLogger } from "@/lib/boardroom/logging";
import { assertDeepSeekBudget, BudgetExceededError } from "@/lib/boardroom/budget";
import { createSupabaseIdempotencyStore, withIdempotency } from "@/lib/boardroom/idempotency";
import { decisionMetadataForTurn } from "@/lib/boardroom/decision";
import { stageFailureNotice, type FailedService } from "@/lib/boardroom/degraded";
import { assertRateLimit, createSupabaseRateStore, RateLimitedError, rateLimitedBody } from "@/lib/boardroom/ratelimit";
import { guardMemberInput } from "@/lib/boardroom/injection";
import type { AdvisorCard, Message } from "@/lib/types";

export const maxDuration = 60;

// A failure inside the idempotent stage run, carrying the HTTP status to return.
// Thrown so withIdempotency releases the claimed key and a genuine retry can run.
class StageError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "StageError";
    this.status = status;
    this.extra = extra;
  }
}

// Degraded mode (Developer 81 to 83): a plain notice the member can act on,
// with Retry continuing from the failed stage. Raw error to the console only.
function degradedStage(error: unknown, service?: FailedService) {
  console.error("[boardroom stage]", error instanceof Error ? error.message : (error as { message?: string })?.message ?? error);
  const notice = stageFailureNotice(error, service);
  return new StageError(notice.message, 503, { retryable: true, failedService: notice.service });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;
  const session = authed;

  try {
    await ensureWorkspaceMember(session.supabase, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return workspaceLocked();
    return jsonError(error instanceof Error ? error.message : "Could not check Boardroom access.", 500);
  }

  const body = await req.json();
  const conversationId = String(body.conversationId || "");
  const nextStage = String(body.nextStage || "");
  const sessionState = body.sessionState as SessionState;
  const mode = modeContext(body.mode);

  if (!conversationId || !nextStage || !sessionState) {
    return jsonError("Missing conversationId, nextStage, or sessionState.", 400);
  }

  // Idempotency: a resent stage request replays the first response rather than
  // re-running the debate stage and re-inserting its messages, cards and memory
  // (Developer 13,15,16,33). The DeepSeek call sits inside the claim, so a
  // duplicate never bills a second time.
  const store = createSupabaseIdempotencyStore(session.supabase);
  const idempotencyKey = requestIdempotencyKey(req);

  let outcome;
  try {
    outcome = await withIdempotency(store, { workspaceId, scope: "chat_stage", key: idempotencyKey, userId: session.userId }, async () => {
      await assertRateLimit(createSupabaseRateStore(session.supabase), { workspaceId, userId: session.userId, scope: "chat_stage" });
      await assertDeepSeekBudget(session.supabase, workspaceId);
      return await runStage();
    });
  } catch (error) {
    if (error instanceof RateLimitedError || error instanceof BudgetExceededError) {
      const limitLog = createBoardroomLogger(session.supabase, { workspaceId, conversationId, userId: session.userId });
      if (error instanceof RateLimitedError) {
        limitLog.limit({ kind: "rate_limit", scope: "chat_stage", detail: { retryAfterSeconds: error.retryAfterSeconds } });
        await limitLog.flush();
        return NextResponse.json(rateLimitedBody(error), { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } });
      }
      limitLog.limit({ kind: "budget_cap", scope: "chat_stage" });
      await limitLog.flush();
      return jsonError(error.message, 429);
    }
    if (error instanceof StageError) return NextResponse.json({ error: error.message, ...error.extra }, { status: error.status });
    const notice = degradedStage(error);
    return NextResponse.json({ error: notice.message, ...notice.extra }, { status: notice.status });
  }

  if (outcome.kind === "in_flight") {
    return NextResponse.json({ error: "This stage is already being processed.", duplicate: true }, { status: 409 });
  }
  return NextResponse.json(outcome.response);

  // The full stage mutation, run exactly once per idempotency key.
  async function runStage() {
    const logger = createBoardroomLogger(session.supabase, { workspaceId, conversationId, userId: session.userId });

    // Load fresh context and history
    const [settings, profile, documents, memory, previousMessages, ownerIsAdmin] = await Promise.all([
      session.supabase.from("boardroom_workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle(),
      session.supabase.from("boardroom_profiles").select("*").eq("workspace_id", workspaceId).maybeSingle(),
      session.supabase.from("boardroom_documents").select("name,extracted_text").eq("workspace_id", workspaceId).eq("status", "ready").order("created_at", { ascending: false }).limit(8),
      session.supabase.from("boardroom_memory_entries").select("kind,content,metadata").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(40),
      session.supabase.from("boardroom_messages").select("*").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(12),
      workspaceOwnerIsAdmin(session.supabase, workspaceId),
    ]);

    const loadError = settings.error || profile.error || documents.error || memory.error || previousMessages.error;
    // Loaded newest first so a long conversation keeps its latest turns; the
    // engine reads them oldest first.
    previousMessages.data?.reverse();
    if (loadError) throw degradedStage(loadError, "database");

    // Documents stay fenced and flagged in every stage, not just the intake.
    // Findings were already logged once by the chat turn, so not again here.
    const guarded = guardMemberInput({ text: "", documents: (documents.data || []).slice(0, 6) });

    const contextText = buildBoardroomContext({
      guardrails: settings.data?.guardrails || "",
      profile: profile.data,
      documents: guarded.documents,
      memory: memoryForChannel(memory.data || [], "brainstorming").slice(0, 8),
      recentMessages: previousMessages.data || [],
      activeCard: null,
    });

    const stageInput = {
      context: contextText,
      history: previousMessages.data as Message[] || [],
      mode,
      clientApiKey: body.clientApiKey ? String(body.clientApiKey) : undefined,
      sessionState,
      ceoName: profile.data?.preferred_name || "CEO",
      audience: (ownerIsAdmin ? "owner" : "member") as "owner" | "member",
      log: logger,
    };

    try {
      let result;

      if (nextStage === "advisor_round") {
        result = await runAdvisorRound(stageInput);
      } else if (nextStage === "chanos") {
        result = await runChanosRound(stageInput);
      } else if (nextStage === "tony_close") {
        result = await runTonyClose(stageInput);
      } else {
        throw new StageError(`Unknown stage: ${nextStage}`, 400);
      }

      // Record each conversation turn the engine produced.
      for (const turn of result.turns) {
        logger.turn({ stage: turn.stage, speaker: turn.speaker, detail: { length: turn.content.length } });
      }

      // Save this stage's messages to DB
      const messageRows = result.turns.map(turn => ({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        role: "assistant",
        speaker: turn.speaker,
        content: turn.content,
        stage: turn.stage,
        metadata: decisionMetadataForTurn(turn),
      }));

      const { data: insertedMessages, error: messageError } = await session.supabase
        .from("boardroom_messages").insert(messageRows).select("*");
      if (messageError) {
        logger.stateWrite({ table: "boardroom_messages", status: "error", stage: nextStage, detail: { error: messageError.message, count: messageRows.length } });
        await logger.flush();
        throw degradedStage(messageError, "database");
      }
      logger.stateWrite({ table: "boardroom_messages", stage: nextStage, detail: { count: messageRows.length } });

      // Save cards and memory on final close
      let insertedCards: AdvisorCard[] = [];
      if (nextStage === "tony_close") {
        if (result.cards.length) {
          const sourceMessageId = insertedMessages?.find(m => m.stage === "tony_close")?.id || null;
          const { data: cards, error: cardError } = await session.supabase
            .from("boardroom_advisor_cards")
            .insert(result.cards.map(card => ({
              workspace_id: workspaceId,
              conversation_id: conversationId,
              source_message_id: sourceMessageId,
              type: card.type,
              work_type: card.workType,
              title: card.title,
              advisor: card.advisor,
              priority: card.priority,
              status: card.status,
              context: card.context,
              desired_output: card.desiredOutput,
              label: card.label,
              source_decision: card.sourceDecision,
              inputs: card.inputs,
              external_target: card.externalTarget,
            })))
            .select("*");
          if (!cardError && cards) insertedCards = cards as AdvisorCard[];
          logger.stateWrite({ table: "boardroom_advisor_cards", status: cardError ? "error" : "ok", stage: "tony_close", detail: cardError ? { error: cardError.message } : { count: result.cards.length } });
        }

        // Save session summary to memory
        const closeContent = result.turns.find(t => t.stage === "tony_close")?.content || "";
        if (closeContent) {
          await session.supabase.from("boardroom_memory_entries").insert({
            workspace_id: workspaceId,
            kind: "session_summary",
            content: [
              `Prompt: ${sessionState.userPrompt.slice(0, 300)}`,
              sessionState.tension ? `Tension: ${sessionState.tension}` : "",
              `Advisors: ${sessionState.selectedAdvisors.join(", ")}`,
              result.cards.length ? `Cards: ${result.cards.map(c => c.title).join(" | ")}` : "",
              `Decision: ${guardMemoryContent(closeContent.slice(0, 800), memberEvidence((previousMessages.data || []) as Message[], sessionState.userPrompt), logger)}`,
            ].filter(Boolean).join("\n"),
            metadata: { conversationId, channel: "brainstorming", tension: sessionState.tension, source: "stage_route" }
          });
          logger.stateWrite({ table: "boardroom_memory_entries", stage: "session_summary" });
        }
      }

      await logger.flush();
      return {
        messages: insertedMessages || [],
        cards: insertedCards,
        nextStage: result.nextStage,
        sessionState: result.sessionState,
      };

    } catch (error) {
      if (error instanceof StageError) throw error;
      const message = error instanceof Error ? error.message : "Stage error.";
      const failure = degradedStage(error);
      logger.stateWrite({ table: "boardroom_messages", status: "error", stage: "error", detail: { error: message, failedService: failure.extra.failedService } });
      await logger.flush();
      throw failure;
    }
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError, requestIdempotencyKey, WorkspaceAccessError, workspaceLocked, workspaceOwnerIsAdmin } from "@/lib/supabase/server";
import { crisisResponse, detectCrisis } from "@/lib/boardroom/safety";
import { conversationMatchesChannel, memoryForChannel } from "@/lib/boardroom/lapse";
import { buildBoardroomContext } from "@/lib/boardroom/context";
import { guardMemoryContent, runTonyIntake } from "@/lib/boardroom/engine";
import { memberEvidence } from "@/lib/boardroom/claims";
import { modeContext } from "@/lib/boardroom/mode";
import { createBoardroomLogger } from "@/lib/boardroom/logging";
import { assertDeepSeekBudget, BudgetExceededError } from "@/lib/boardroom/budget";
import { createSupabaseIdempotencyStore, withIdempotency } from "@/lib/boardroom/idempotency";
import { failureNotice, type FailedService } from "@/lib/boardroom/degraded";
import type { AdvisorName, Message } from "@/lib/types";

export const maxDuration = 60;

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
  const text = String(body.text || "").trim();
  if (!text) return jsonError("Message text is required.", 400);

  const mode = modeContext(body.mode);
  const channel = String(body.channel || "brainstorming");
  const activeAdvisor = ["Tony", "Russell", "Allen", "Chanos", "Andrej", "Calvina"].includes(channel)
    ? channel as AdvisorName
    : undefined;

  // Idempotency: a resent or double-clicked chat turn claims the same key and
  // replays the first response instead of re-running generation or re-inserting
  // rows (Developer 13,15,16,33). The whole mutation (conversation create,
  // DeepSeek, message + memory inserts, mode update) runs inside the claim, so a
  // duplicate bills DeepSeek zero times and writes nothing.
  const store = createSupabaseIdempotencyStore(session.supabase);
  const idempotencyKey = requestIdempotencyKey(req);

  let outcome;
  try {
    outcome = await withIdempotency(store, { workspaceId, scope: "chat", key: idempotencyKey, userId: session.userId }, async () => {
      // Server-side DeepSeek cost/usage bound (Developer 99): refuse before
      // spending when this workspace is over its rolling window cap. Inside the
      // claim so a replay never re-checks or re-bills.
      await assertDeepSeekBudget(session.supabase, workspaceId);

      return await runChatTurn();
    });
  } catch (error) {
    if (error instanceof BudgetExceededError) return jsonError(error.message, 429);
    if (error instanceof ChatTurnError) return NextResponse.json({ error: error.message, ...error.extra }, { status: error.status });
    // Degraded mode (Developer 81 to 83): never show a member a raw stack or
    // provider error. Say what failed in plain words and offer Retry.
    console.error("[boardroom chat] unhandled:", error);
    const notice = failureNotice(error, false);
    return NextResponse.json({ error: notice.message, retryable: true, failedService: notice.service }, { status: 503 });
  }

  if (outcome.kind === "in_flight") {
    return NextResponse.json({ error: "This message is already being processed.", duplicate: true }, { status: 409 });
  }
  return NextResponse.json(outcome.response);

  // The full chat-turn mutation, run exactly once per idempotency key.
  async function runChatTurn() {
  // Create or reuse conversation. A supplied id is reused only when it belongs
  // to this channel, so a 1:1 turn can never land in the main room or in
  // another advisor's room (WBR-373 Stream D, room isolation).
  let conversationId = String(body.conversationId || "");
  if (conversationId) {
    const { data: existing, error: existingError } = await session.supabase
      .from("boardroom_conversations").select("id,channel").eq("workspace_id", workspaceId).eq("id", conversationId).maybeSingle();
    if (existingError) throw degraded(existingError, "database");
    if (!conversationMatchesChannel(existing, channel)) conversationId = "";
  }
  const createdConversation = !conversationId;
  if (!conversationId) {
    const { data, error } = await session.supabase
      .from("boardroom_conversations")
      .insert({
        workspace_id: workspaceId,
        title: channel === "brainstorming" ? "Boardroom" : `${channel} 1:1`,
        channel,
        mode,
        created_by: session.userId
      })
      .select("*")
      .single();
    if (error) throw degraded(error, "database");
    conversationId = data.id;
  }

  // Observability: every turn, DeepSeek call and state write from here on is logged.
  const logger = createBoardroomLogger(session.supabase, { workspaceId, conversationId, userId: session.userId });
  if (createdConversation) {
    logger.stateWrite({ table: "boardroom_conversations", stage: "conversation_create", detail: { channel } });
  }

  // Load workspace context
  const [settings, profile, documents, memory, previousMessages, activeCard, ownerIsAdmin] = await Promise.all([
    session.supabase.from("boardroom_workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    session.supabase.from("boardroom_profiles").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    session.supabase.from("boardroom_documents").select("name,extracted_text").eq("workspace_id", workspaceId).eq("status", "ready").order("created_at", { ascending: false }).limit(8),
    session.supabase.from("boardroom_memory_entries").select("kind,content,metadata").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(40),
    session.supabase.from("boardroom_messages").select("*").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(24),
    body.cardId
      ? session.supabase.from("boardroom_advisor_cards").select("title,advisor,context,desired_output").eq("workspace_id", workspaceId).eq("id", String(body.cardId)).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    workspaceOwnerIsAdmin(session.supabase, workspaceId),
  ]);

  const loadError = settings.error || profile.error || documents.error || memory.error || previousMessages.error || activeCard.error;
  // Loaded newest first so a long conversation keeps its latest turns; the
  // engine reads them oldest first.
  previousMessages.data?.reverse();
  if (loadError) throw degraded(loadError, "database", { conversationId });

  // Save user message to DB. A Retry after a failed turn names the message it
  // already saved, so the member's words are reused rather than written twice.
  const retryId = body.retryUserMessageId ? String(body.retryUserMessageId) : "";
  const previousUserMessage = retryId
    ? (previousMessages.data || []).find(m => m.id === retryId && m.role === "user" && m.content === text)
    : null;
  let userMessage = previousUserMessage ?? null;
  if (!userMessage) {
    const { data: inserted, error: userMessageError } = await session.supabase
      .from("boardroom_messages")
      .insert({ workspace_id: workspaceId, conversation_id: conversationId, role: "user", speaker: "You", content: text, stage: "user_prompt" })
      .select("*")
      .single();
    if (userMessageError) throw degraded(userMessageError, "database", { conversationId });
    userMessage = inserted;
    logger.stateWrite({ table: "boardroom_messages", stage: "user_prompt", detail: { role: "user" } });
  } else {
    logger.stateWrite({ table: "boardroom_messages", stage: "user_prompt_retry", detail: { role: "user", reused: true } });
  }
  const history = ((previousMessages.data || []) as Message[]).filter(m => m.id !== userMessage?.id);

  // Safety boundary (WBR-373 Stream B): crisis or self-harm language skips every
  // advisor round and gets one plain, human answer that points to real help.
  const crisis = detectCrisis(text);
  if (crisis.tripped) {
    logger.safety({ category: crisis.category, patternId: crisis.patternId });
    const { data: safetyMessages, error: safetyError } = await session.supabase
      .from("boardroom_messages")
      .insert({
        workspace_id: workspaceId, conversation_id: conversationId, role: "assistant",
        speaker: "AI Boardroom", content: crisisResponse(profile.data?.preferred_name), stage: "safety_pause",
        metadata: { safety: { category: crisis.category } },
      })
      .select("*");
    if (safetyError) {
      await logger.flush();
      throw degraded(safetyError, "database", { conversationId, userMessageId: userMessage.id });
    }
    logger.stateWrite({ table: "boardroom_messages", stage: "safety_pause", detail: { role: "assistant" } });
    await logger.flush();
    return { conversationId, userMessage, messages: safetyMessages || [], cards: [], nextStage: "done", sessionState: null, safety: true };
  }

  const contextText = buildBoardroomContext({
    guardrails: settings.data?.guardrails || "",
    profile: profile.data,
    documents: documents.data || [],
    memory: memoryForChannel(memory.data || [], channel).slice(0, 8),
    recentMessages: previousMessages.data || [],
    activeCard: activeCard.data
  });

  try {
    // Run Tony intake only (or full 1:1 for advisor channels)
    const result = await runTonyIntake({
      userPrompt: text,
      context: contextText,
      history,
      mode,
      clientApiKey: body.clientApiKey ? String(body.clientApiKey) : undefined,
      activeAdvisor,
      tonyOnly: body.tonyOnly === true,
      ceoName: profile.data?.preferred_name || "CEO",
      audience: ownerIsAdmin ? "owner" : "member",
      log: logger,
    });

    // Record each conversation turn the engine produced.
    for (const turn of result.turns) {
      logger.turn({ stage: turn.stage, speaker: turn.speaker, detail: { length: turn.content.length } });
    }

    // Save Tony's message(s) to DB
    const messageRows = result.turns.map(turn => ({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      role: "assistant",
      speaker: turn.speaker,
      content: turn.content,
      stage: turn.stage,
    }));

    const { data: insertedMessages, error: messageError } = await session.supabase
      .from("boardroom_messages").insert(messageRows).select("*");
    if (messageError) {
      logger.stateWrite({ table: "boardroom_messages", status: "error", stage: "assistant_turns", detail: { error: messageError.message, count: messageRows.length } });
      await logger.flush();
      throw degraded(messageError, "database", { conversationId, userMessageId: userMessage.id });
    }
    logger.stateWrite({ table: "boardroom_messages", stage: "assistant_turns", detail: { count: messageRows.length } });

    // For 1:1 sessions or done sessions, also save memory
    if (result.nextStage === "done" || result.nextStage === "clarify") {
      const lastMsg = result.turns.at(-1);
      if (lastMsg) {
        await session.supabase.from("boardroom_memory_entries").insert({
          workspace_id: workspaceId,
          kind: "session_summary",
          content: `Prompt: ${text.slice(0, 300)}\nResponse: ${guardMemoryContent(lastMsg.content.slice(0, 800), memberEvidence(history, text), logger)}`,
          metadata: { conversationId, channel, source: "chat_route" }
        }).throwOnError();
        logger.stateWrite({ table: "boardroom_memory_entries", stage: "session_summary" });
      }
    }

    await session.supabase.from("boardroom_conversations").update({ mode }).eq("workspace_id", workspaceId).eq("id", conversationId);
    logger.stateWrite({ table: "boardroom_conversations", stage: "mode_update" });

    await logger.flush();
    return {
      conversationId,
      userMessage,
      messages: insertedMessages || [],
      cards: [],
      nextStage: result.nextStage,
      sessionState: result.sessionState,
    };

  } catch (error) {
    if (error instanceof ChatTurnError) throw error;
    const message = error instanceof Error ? error.message : "Boardroom error.";
    const notice = failureNotice(error, true);
    logger.stateWrite({ table: "boardroom_messages", status: "error", stage: "error", detail: { error: message, failedService: notice.service } });
    await logger.flush();
    throw degraded(error, notice.service, { conversationId, userMessageId: userMessage.id });
  }
  }
}

// A failure inside the idempotent chat turn, carrying the HTTP status to return.
// Thrown rather than returned so withIdempotency releases the claimed key and a
// genuine retry can run.
class ChatTurnError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ChatTurnError";
    this.status = status;
    this.extra = extra;
  }
}

// Turns a DeepSeek or Supabase failure into the plain notice a member sees,
// carrying what the client needs to retry without losing or doubling the
// message. The raw error goes to the server console only.
function degraded(error: unknown, service: FailedService, ctx: { conversationId?: string; userMessageId?: string } = {}) {
  console.error("[boardroom chat]", error instanceof Error ? error.message : (error as { message?: string })?.message ?? error);
  const notice = failureNotice(error, Boolean(ctx.userMessageId), service);
  return new ChatTurnError(notice.message, 503, {
    retryable: true,
    failedService: notice.service,
    conversationId: ctx.conversationId ?? null,
    userMessageId: ctx.userMessageId ?? null,
  });
}

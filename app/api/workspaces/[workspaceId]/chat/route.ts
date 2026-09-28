import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";
import { buildBoardroomContext } from "@/lib/boardroom/context";
import { runTonyIntake } from "@/lib/boardroom/engine";
import { modeContext } from "@/lib/boardroom/mode";
import { createBoardroomLogger } from "@/lib/boardroom/logging";
import { assertDeepSeekBudget, BudgetExceededError } from "@/lib/boardroom/budget";
import type { AdvisorName, Message } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  // Server-side DeepSeek cost/usage bound (Developer 99): refuse before spending
  // when this workspace is over its rolling window cap.
  try {
    await assertDeepSeekBudget(authed.supabase, workspaceId);
  } catch (error) {
    if (error instanceof BudgetExceededError) return jsonError(error.message, 429);
    throw error;
  }

  const body = await req.json();
  const text = String(body.text || "").trim();
  if (!text) return jsonError("Message text is required.", 400);

  const mode = modeContext(body.mode);
  const channel = String(body.channel || "brainstorming");
  const activeAdvisor = ["Tony", "Russell", "Allen", "Chanos", "Andrej", "Calvina"].includes(channel)
    ? channel as AdvisorName
    : undefined;

  // Create or reuse conversation
  let conversationId = String(body.conversationId || "");
  if (!conversationId) {
    const { data, error } = await authed.supabase
      .from("boardroom_conversations")
      .insert({
        workspace_id: workspaceId,
        title: channel === "brainstorming" ? "Boardroom" : `${channel} 1:1`,
        channel,
        mode,
        created_by: authed.userId
      })
      .select("*")
      .single();
    if (error) return jsonError(error.message, 500);
    conversationId = data.id;
  }

  // Observability: every turn, DeepSeek call and state write from here on is logged.
  const logger = createBoardroomLogger(authed.supabase, { workspaceId, conversationId, userId: authed.userId });
  if (!String(body.conversationId || "")) {
    logger.stateWrite({ table: "boardroom_conversations", stage: "conversation_create", detail: { channel } });
  }

  // Load workspace context
  const [settings, profile, documents, memory, previousMessages, activeCard] = await Promise.all([
    authed.supabase.from("boardroom_workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    authed.supabase.from("boardroom_profiles").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    authed.supabase.from("boardroom_documents").select("name,extracted_text").eq("workspace_id", workspaceId).eq("status", "ready").order("created_at", { ascending: false }).limit(8),
    authed.supabase.from("boardroom_memory_entries").select("kind,content").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(8),
    authed.supabase.from("boardroom_messages").select("*").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(24),
    body.cardId
      ? authed.supabase.from("boardroom_advisor_cards").select("title,advisor,context,desired_output").eq("workspace_id", workspaceId).eq("id", String(body.cardId)).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);

  const loadError = settings.error || profile.error || documents.error || memory.error || previousMessages.error || activeCard.error;
  if (loadError) return jsonError(loadError.message, 500);

  // Save user message to DB
  const { data: userMessage, error: userMessageError } = await authed.supabase
    .from("boardroom_messages")
    .insert({ workspace_id: workspaceId, conversation_id: conversationId, role: "user", speaker: "You", content: text, stage: "user_prompt" })
    .select("*")
    .single();
  if (userMessageError) return jsonError(userMessageError.message, 500);
  logger.stateWrite({ table: "boardroom_messages", stage: "user_prompt", detail: { role: "user" } });

  const contextText = buildBoardroomContext({
    guardrails: settings.data?.guardrails || "",
    profile: profile.data,
    documents: documents.data || [],
    memory: memory.data || [],
    recentMessages: previousMessages.data || [],
    activeCard: activeCard.data
  });

  try {
    // Run Tony intake only (or full 1:1 for advisor channels)
    const result = await runTonyIntake({
      userPrompt: text,
      context: contextText,
      history: (previousMessages.data || []) as Message[],
      mode,
      clientApiKey: body.clientApiKey ? String(body.clientApiKey) : undefined,
      activeAdvisor,
      tonyOnly: body.tonyOnly === true,
      ceoName: profile.data?.preferred_name || "CEO",
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

    const { data: insertedMessages, error: messageError } = await authed.supabase
      .from("boardroom_messages").insert(messageRows).select("*");
    if (messageError) {
      logger.stateWrite({ table: "boardroom_messages", status: "error", stage: "assistant_turns", detail: { error: messageError.message, count: messageRows.length } });
      await logger.flush();
      return jsonError(messageError.message, 500);
    }
    logger.stateWrite({ table: "boardroom_messages", stage: "assistant_turns", detail: { count: messageRows.length } });

    // For 1:1 sessions or done sessions, also save memory
    if (result.nextStage === "done" || result.nextStage === "clarify") {
      const lastMsg = result.turns.at(-1);
      if (lastMsg) {
        await authed.supabase.from("boardroom_memory_entries").insert({
          workspace_id: workspaceId,
          kind: "session_summary",
          content: `Prompt: ${text.slice(0, 300)}\nResponse: ${lastMsg.content.slice(0, 800)}`,
          metadata: { conversationId, source: "chat_route" }
        }).throwOnError();
        logger.stateWrite({ table: "boardroom_memory_entries", stage: "session_summary" });
      }
    }

    await authed.supabase.from("boardroom_conversations").update({ mode }).eq("workspace_id", workspaceId).eq("id", conversationId);
    logger.stateWrite({ table: "boardroom_conversations", stage: "mode_update" });

    await logger.flush();
    return NextResponse.json({
      conversationId,
      userMessage,
      messages: insertedMessages || [],
      cards: [],
      nextStage: result.nextStage,
      sessionState: result.sessionState,
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : "Boardroom error.";
    logger.stateWrite({ table: "boardroom_messages", status: "error", stage: "error", detail: { error: message } });
    await authed.supabase.from("boardroom_messages").insert({
      workspace_id: workspaceId, conversation_id: conversationId,
      role: "system", speaker: "System", content: message, stage: "error"
    });
    await logger.flush();
    return jsonError(message, 500);
  }
}

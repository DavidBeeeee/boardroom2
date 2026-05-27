import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";
import { buildBoardroomContext } from "@/lib/boardroom/context";
import { runBoardroomEngine } from "@/lib/boardroom/engine";
import { modeContext } from "@/lib/boardroom/mode";
import type { AdvisorCard, AdvisorName, Message } from "@/lib/types";

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const body = await req.json();
  const text = String(body.text || "").trim();
  if (!text) return jsonError("Message text is required.", 400);

  const mode = modeContext(body.mode);
  const channel = String(body.channel || "brainstorming");
  const activeAdvisor = ["Tony", "Russell", "Allen", "Chanos", "Andrej", "Calvina"].includes(channel) ? channel as AdvisorName : undefined;

  let conversationId = String(body.conversationId || "");
  if (!conversationId) {
    const { data, error } = await authed.supabase
      .from("conversations")
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

  const [settings, documents, memory, previousMessages, activeCard] = await Promise.all([
    authed.supabase.from("workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    authed.supabase.from("documents").select("name,extracted_text").eq("workspace_id", workspaceId).eq("status", "ready").order("created_at", { ascending: false }).limit(8),
    authed.supabase.from("memory_entries").select("kind,content").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(8),
    authed.supabase.from("messages").select("*").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(24),
    body.cardId
      ? authed.supabase.from("advisor_cards").select("title,advisor,context,desired_output").eq("workspace_id", workspaceId).eq("id", String(body.cardId)).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);

  const loadError = settings.error || documents.error || memory.error || previousMessages.error || activeCard.error;
  if (loadError) return jsonError(loadError.message, 500);

  const { data: userMessage, error: userMessageError } = await authed.supabase
    .from("messages")
    .insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      role: "user",
      speaker: "You",
      content: text,
      stage: "user_prompt"
    })
    .select("*")
    .single();
  if (userMessageError) return jsonError(userMessageError.message, 500);

  const contextText = buildBoardroomContext({
    guardrails: settings.data?.guardrails || "",
    documents: documents.data || [],
    memory: memory.data || [],
    recentMessages: previousMessages.data || [],
    activeCard: activeCard.data
  });

  try {
    const generated = await runBoardroomEngine({
      userPrompt: text,
      context: contextText,
      history: previousMessages.data as Message[] || [],
      mode,
      clientApiKey: body.clientApiKey ? String(body.clientApiKey) : undefined,
      activeAdvisor
    });

    const messageRows = generated.turns.map((turn) => ({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      role: "assistant",
      speaker: turn.speaker,
      content: turn.content,
      stage: turn.stage
    }));
    const { data: insertedMessages, error: messageError } = await authed.supabase.from("messages").insert(messageRows).select("*");
    if (messageError) return jsonError(messageError.message, 500);

    const sourceMessageId = insertedMessages?.find((m) => m.stage === "tony_close")?.id || insertedMessages?.at(-1)?.id || null;
    let insertedCards: AdvisorCard[] = [];
    if (generated.cards.length) {
      const { data: cards, error: cardError } = await authed.supabase
        .from("advisor_cards")
        .insert(generated.cards.map((card) => ({
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
          external_target: card.externalTarget
        })))
        .select("*");
      if (cardError) return jsonError(cardError.message, 500);
      insertedCards = cards as AdvisorCard[];
    }

    const summary = generated.turns.find((turn) => turn.stage === "tony_close")?.content || generated.turns.at(-1)?.content || "";
    await authed.supabase.from("memory_entries").insert({
      workspace_id: workspaceId,
      kind: "session_summary",
      content: summary.slice(0, 1800),
      metadata: { conversationId, source: "chat_route" }
    });
    await authed.supabase.from("conversations").update({ mode }).eq("workspace_id", workspaceId).eq("id", conversationId);

    return NextResponse.json({
      conversationId,
      userMessage,
      messages: insertedMessages || [],
      cards: insertedCards,
      usedServerKey: !!process.env.DEEPSEEK_API_KEY
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Boardroom error.";
    await authed.supabase.from("messages").insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      role: "system",
      speaker: "System",
      content: message,
      stage: "error"
    });
    return jsonError(message, 500);
  }
}

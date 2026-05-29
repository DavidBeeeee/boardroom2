import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";
import { buildBoardroomContext } from "@/lib/boardroom/context";
import { runTonyIntake } from "@/lib/boardroom/engine";
import { modeContext } from "@/lib/boardroom/mode";
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

  // Load workspace context
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

  // Save user message to DB
  const { data: userMessage, error: userMessageError } = await authed.supabase
    .from("messages")
    .insert({ workspace_id: workspaceId, conversation_id: conversationId, role: "user", speaker: "You", content: text, stage: "user_prompt" })
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
    // Run Tony intake only (or full 1:1 for advisor channels)
    const result = await runTonyIntake({
      userPrompt: text,
      context: contextText,
      history: previousMessages.data as Message[] || [],
      mode,
      clientApiKey: body.clientApiKey ? String(body.clientApiKey) : undefined,
      activeAdvisor,
      tonyOnly: body.tonyOnly === true,
    });

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
      .from("messages").insert(messageRows).select("*");
    if (messageError) return jsonError(messageError.message, 500);

    // For 1:1 sessions or done sessions, also save memory
    if (result.nextStage === "done" || result.nextStage === "clarify") {
      const lastMsg = result.turns.at(-1);
      if (lastMsg) {
        await authed.supabase.from("memory_entries").insert({
          workspace_id: workspaceId,
          kind: "session_summary",
          content: `Prompt: ${text.slice(0, 300)}\nResponse: ${lastMsg.content.slice(0, 800)}`,
          metadata: { conversationId, source: "chat_route" }
        }).throwOnError();
      }
    }

    await authed.supabase.from("conversations").update({ mode }).eq("workspace_id", workspaceId).eq("id", conversationId);

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
    await authed.supabase.from("messages").insert({
      workspace_id: workspaceId, conversation_id: conversationId,
      role: "system", speaker: "System", content: message, stage: "error"
    });
    return jsonError(message, 500);
  }
}

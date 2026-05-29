import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";
import { buildBoardroomContext } from "@/lib/boardroom/context";
import { runAdvisorRound, runChanosRound, runTonyClose, normalizeCards } from "@/lib/boardroom/engine";
import type { SessionState } from "@/lib/boardroom/engine";
import { modeContext } from "@/lib/boardroom/mode";
import type { AdvisorCard, Message } from "@/lib/types";

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
  const conversationId = String(body.conversationId || "");
  const nextStage = String(body.nextStage || "");
  const sessionState = body.sessionState as SessionState;
  const mode = modeContext(body.mode);

  if (!conversationId || !nextStage || !sessionState) {
    return jsonError("Missing conversationId, nextStage, or sessionState.", 400);
  }

  // Load fresh context and history
  const [settings, documents, memory, previousMessages] = await Promise.all([
    authed.supabase.from("workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    authed.supabase.from("documents").select("name,extracted_text").eq("workspace_id", workspaceId).eq("status", "ready").order("created_at", { ascending: false }).limit(8),
    authed.supabase.from("memory_entries").select("kind,content").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(8),
    authed.supabase.from("messages").select("*").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(30),
  ]);

  const contextText = buildBoardroomContext({
    guardrails: settings.data?.guardrails || "",
    documents: documents.data || [],
    memory: memory.data || [],
    recentMessages: previousMessages.data || [],
    activeCard: null,
  });

  const stageInput = {
    context: contextText,
    history: previousMessages.data as Message[] || [],
    mode,
    clientApiKey: body.clientApiKey ? String(body.clientApiKey) : undefined,
    sessionState,
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
      return jsonError(`Unknown stage: ${nextStage}`, 400);
    }

    // Save this stage's messages to DB
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

    // Save cards and memory on final close
    let insertedCards: AdvisorCard[] = [];
    if (nextStage === "tony_close") {
      if (result.cards.length) {
        const sourceMessageId = insertedMessages?.find(m => m.stage === "tony_close")?.id || null;
        const { data: cards, error: cardError } = await authed.supabase
          .from("advisor_cards")
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
      }

      // Save session summary to memory
      const closeContent = result.turns.find(t => t.stage === "tony_close")?.content || "";
      if (closeContent) {
        await authed.supabase.from("memory_entries").insert({
          workspace_id: workspaceId,
          kind: "session_summary",
          content: [
            `Prompt: ${sessionState.userPrompt.slice(0, 300)}`,
            sessionState.tension ? `Tension: ${sessionState.tension}` : "",
            `Advisors: ${sessionState.selectedAdvisors.join(", ")}`,
            result.cards.length ? `Cards: ${result.cards.map(c => c.title).join(" | ")}` : "",
            `Decision: ${closeContent.slice(0, 800)}`,
          ].filter(Boolean).join("\n"),
          metadata: { conversationId, tension: sessionState.tension, source: "stage_route" }
        });
      }
    }

    return NextResponse.json({
      messages: insertedMessages || [],
      cards: insertedCards,
      nextStage: result.nextStage,
      sessionState: result.sessionState,
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : "Stage error.";
    await authed.supabase.from("messages").insert({
      workspace_id: workspaceId, conversation_id: conversationId,
      role: "system", speaker: "System", content: message, stage: "error"
    });
    return jsonError(message, 500);
  }
}

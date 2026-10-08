import { NextRequest, NextResponse } from "next/server";
import { toLastConversation } from "@/lib/boardroom/lapse";
import { budgetNotice, budgetRule, checkDeepSeekBudget } from "@/lib/boardroom/budget";
import { createRequestSupabase, ensureWorkspaceMember, jsonError, WorkspaceAccessError, workspaceLocked } from "@/lib/supabase/server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return workspaceLocked();
    return jsonError(error instanceof Error ? error.message : "Could not check Boardroom access.", 500);
  }

  const [workspace, documents, conversations, cards, settings, profile, decisions, lastUserMessage, budgetStatus] = await Promise.all([
    authed.supabase.from("boardroom_workspaces").select("id,name,slug,created_at").eq("id", workspaceId).single(),
    authed.supabase.from("boardroom_documents").select("id,workspace_id,name,mime_type,storage_path,byte_size,status,error,created_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }),
    authed.supabase.from("boardroom_conversations").select("id,workspace_id,title,channel,mode,created_at,updated_at").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }),
    authed.supabase.from("boardroom_advisor_cards").select("*").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }),
    authed.supabase.from("boardroom_workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    authed.supabase.from("boardroom_profiles").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    authed.supabase.from("boardroom_messages").select("conversation_id").eq("workspace_id", workspaceId).eq("stage", "tony_close").contains("metadata", { decision_reached: true }),
    authed.supabase.from("boardroom_messages").select("conversation_id,content,created_at").eq("workspace_id", workspaceId).eq("role", "user").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    checkDeepSeekBudget(authed.supabase, workspaceId),
  ]);

  const error = workspace.error || documents.error || conversations.error || cards.error || settings.error || profile.error || decisions.error || lastUserMessage.error;
  if (error) return jsonError(error.message, 500);

  // Lapse awareness (WBR-373 Stream C): the member's most recent message and the
  // room it was in, so the app can welcome back someone who has been away 21+ days.
  const lastChannel = (conversations.data || []).find(c => c.id === lastUserMessage.data?.conversation_id)?.channel || "brainstorming";
  const lastConversation = toLastConversation(lastUserMessage.data, lastChannel);

  return NextResponse.json({
    workspace: workspace.data,
    documents: documents.data || [],
    conversations: conversations.data || [],
    decisionReachedConversationIds: [...new Set((decisions.data || []).map(row => row.conversation_id))],
    cards: cards.data || [],
    settings: settings.data,
    profile: profile.data,
    lastConversation,
    budget: { rule: budgetRule(budgetStatus), notice: budgetNotice(budgetStatus) },
  });
}

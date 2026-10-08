import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError, WorkspaceAccessError, workspaceLocked } from "@/lib/supabase/server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ workspaceId: string; conversationId: string }> }) {
  const { workspaceId, conversationId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return workspaceLocked();
    return jsonError(error instanceof Error ? error.message : "Could not check Boardroom access.", 500);
  }

  const [conversation, messages] = await Promise.all([
    authed.supabase.from("boardroom_conversations").select("*").eq("workspace_id", workspaceId).eq("id", conversationId).single(),
    authed.supabase.from("boardroom_messages").select("*").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: true })
  ]);

  const error = conversation.error || messages.error;
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ conversation: conversation.data, messages: messages.data || [] });
}

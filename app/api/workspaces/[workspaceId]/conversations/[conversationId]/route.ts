import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ workspaceId: string; conversationId: string }> }) {
  const { workspaceId, conversationId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const [conversation, messages] = await Promise.all([
    authed.supabase.from("boardroom_conversations").select("*").eq("workspace_id", workspaceId).eq("id", conversationId).single(),
    authed.supabase.from("boardroom_messages").select("*").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: true })
  ]);

  const error = conversation.error || messages.error;
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ conversation: conversation.data, messages: messages.data || [] });
}

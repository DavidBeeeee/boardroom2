import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const [messages, conversations, cards, memory] = await Promise.all([
    authed.supabase.from("messages").delete().eq("workspace_id", workspaceId),
    authed.supabase.from("conversations").delete().eq("workspace_id", workspaceId),
    authed.supabase.from("advisor_cards").delete().eq("workspace_id", workspaceId),
    authed.supabase.from("memory_entries").delete().eq("workspace_id", workspaceId)
  ]);
  const error = messages.error || conversations.error || cards.error || memory.error;
  if (error) return jsonError(error.message, 500);

  await authed.supabase
    .from("workspace_settings")
    .update({ fresh_start_count: 1 })
    .eq("workspace_id", workspaceId);

  return NextResponse.json({
    cleared: ["messages", "conversations", "advisor_cards", "memory_entries"],
    preserved: ["documents", "workspace_settings", "workspace_members"]
  });
}

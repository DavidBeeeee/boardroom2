import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError, WorkspaceAccessError, workspaceLocked } from "@/lib/supabase/server";

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return workspaceLocked();
    return jsonError(error instanceof Error ? error.message : "Could not check Boardroom access.", 500);
  }

  for (const table of [
    "boardroom_messages",
    "boardroom_advisor_cards",
    "boardroom_memory_entries",
    "boardroom_conversations"
  ]) {
    const { error } = await authed.supabase.from(table).delete().eq("workspace_id", workspaceId);
    if (error) return jsonError(error.message, 500);
  }

  await authed.supabase
    .from("boardroom_workspace_settings")
    .update({ fresh_start_count: (await authed.supabase.from("boardroom_workspace_settings").select("fresh_start_count").eq("workspace_id", workspaceId).single()).data?.fresh_start_count + 1 || 1 })
    .eq("workspace_id", workspaceId);

  return NextResponse.json({
    cleared: ["messages", "conversations", "advisor_cards", "memory_entries"],
    preserved: ["profile", "documents", "workspace_settings", "workspace_members"]
  });
}

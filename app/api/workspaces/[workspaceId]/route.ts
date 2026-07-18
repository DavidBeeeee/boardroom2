import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const [workspace, documents, conversations, cards, settings] = await Promise.all([
    authed.supabase.from("boardroom_workspaces").select("id,name,slug,created_at").eq("id", workspaceId).single(),
    authed.supabase.from("boardroom_documents").select("id,workspace_id,name,mime_type,storage_path,byte_size,status,error,created_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }),
    authed.supabase.from("boardroom_conversations").select("id,workspace_id,title,channel,mode,created_at,updated_at").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }),
    authed.supabase.from("boardroom_advisor_cards").select("*").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }),
    authed.supabase.from("boardroom_workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle()
  ]);

  const error = workspace.error || documents.error || conversations.error || cards.error || settings.error;
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    workspace: workspace.data,
    documents: documents.data || [],
    conversations: conversations.data || [],
    cards: cards.data || [],
    settings: settings.data
  });
}

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

  const { data, error } = await authed.supabase
    .from("messages")
    .select("speaker,content,stage,created_at,conversations(title,channel)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) return jsonError(error.message, 500);
  const text = [
    `AI Boardroom Export`,
    `Workspace: ${workspaceId}`,
    `Exported: ${new Date().toISOString()}`,
    ``,
    ...(data || []).map((m) => `[${m.created_at}] ${m.speaker} (${m.stage})\n${m.content}\n`)
  ].join("\n");

  return new NextResponse(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="boardroom-${workspaceId}.txt"`
    }
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ workspaceId: string; cardId: string }> }) {
  const { workspaceId, cardId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const body = await req.json();
  const patch: Record<string, unknown> = {};
  for (const key of ["status", "label", "artifact", "external_target"] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  const { data, error } = await authed.supabase
    .from("advisor_cards")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("id", cardId)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ card: data });
}

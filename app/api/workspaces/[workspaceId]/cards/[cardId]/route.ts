import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError, WorkspaceAccessError, workspaceLocked } from "@/lib/supabase/server";
import { parseExpectedVersion, updateCardWithVersion } from "@/lib/boardroom/concurrency";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ workspaceId: string; cardId: string }> }) {
  const { workspaceId, cardId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return workspaceLocked();
    return jsonError(error instanceof Error ? error.message : "Could not check Boardroom access.", 500);
  }

  const body = await req.json();
  const patch: Record<string, unknown> = {};
  for (const key of ["status", "label", "artifact", "external_target"] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) return jsonError("No editable card fields were provided.", 400);

  // Optimistic concurrency (Developer 9,18,20): when the client sends the card
  // version it read, a write that names a stale version matches zero rows and is
  // refused with the current card, rather than silently clobbering a concurrent
  // edit. A client that sends no version keeps the old last-writer-wins behavior.
  const expectedVersion = parseExpectedVersion(body.expectedVersion);

  const result = await updateCardWithVersion(authed.supabase, { workspaceId, cardId, patch, expectedVersion });

  if ("error" in result && result.error) return jsonError(result.error.message, 500);

  if (result.kind === "stale") {
    // Either the version moved on (a concurrent edit won) or the card is gone.
    // Return the current row so the client can reconcile without guessing.
    const { data: current } = await authed.supabase
      .from("boardroom_advisor_cards")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("id", cardId)
      .maybeSingle();
    if (!current) return jsonError("Card not found.", 404);
    return NextResponse.json(
      { error: "This card changed since you loaded it. Reloaded the latest.", conflict: "version", card: current },
      { status: 409 },
    );
  }

  return NextResponse.json({ card: result.row });
}

import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";

function profileText(body: Record<string, unknown>, key: string, max: number) {
  return String(body[key] || "").trim().slice(0, max);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const body = await req.json() as Record<string, unknown>;
  const preferredName = profileText(body, "preferred_name", 80);
  if (!preferredName) return jsonError("Tell the Boardroom what to call you.", 400);

  const { data, error } = await authed.supabase
    .from("boardroom_profiles")
    .upsert({
      workspace_id: workspaceId,
      preferred_name: preferredName,
      role_title: profileText(body, "role_title", 120),
      business_name: profileText(body, "business_name", 160),
      business_description: profileText(body, "business_description", 2000),
      ideal_customer: profileText(body, "ideal_customer", 1200),
      offers: profileText(body, "offers", 1600),
      current_goals: profileText(body, "current_goals", 1600),
      constraints: profileText(body, "constraints", 1600),
      additional_context: profileText(body, "additional_context", 1600),
      onboarding_complete: true,
    }, { onConflict: "workspace_id" })
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ profile: data });
}

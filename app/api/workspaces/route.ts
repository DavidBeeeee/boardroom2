import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, jsonError, workspaceLocked } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  const { data, error } = await authed.supabase.rpc("boardroom_ensure_workspace");

  if (error) {
    if (error.message.toLowerCase().includes("access required")) return workspaceLocked();
    return jsonError(error.message, 500);
  }
  return NextResponse.json({ workspaces: data || [] });
}

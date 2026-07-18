import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, jsonError } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  const { data, error } = await authed.supabase.rpc("boardroom_ensure_workspace");

  if (error) return jsonError(error.message, error.message.toLowerCase().includes("access required") ? 403 : 500);
  return NextResponse.json({ workspaces: data || [] });
}

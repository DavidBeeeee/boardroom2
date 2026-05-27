import { NextRequest, NextResponse } from "next/server";
import { createRequestSupabase, jsonError } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  const { data, error } = await authed.supabase
    .from("workspaces")
    .select("id,name,slug,created_at")
    .order("created_at", { ascending: true });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ workspaces: data || [] });
}

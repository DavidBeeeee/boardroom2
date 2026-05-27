import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export type AuthedSupabase = {
  supabase: SupabaseClient;
  userId: string;
  token: string;
};

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function createRequestSupabase(req: NextRequest): Promise<AuthedSupabase | NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return jsonError("Missing Supabase environment variables.", 500);

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!token) return jsonError("Missing Supabase bearer token.", 401);

  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return jsonError("Invalid or expired session.", 401);
  return { supabase, userId: data.user.id, token };
}

export function createServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error("Missing Supabase service-role env vars.");
  return createClient(url, service, { auth: { persistSession: false } });
}

export async function ensureWorkspaceMember(supabase: SupabaseClient, workspaceId: string) {
  const { data, error } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Workspace not found or not accessible.");
}

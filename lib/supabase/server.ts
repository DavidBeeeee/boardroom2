import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { normalizeIdempotencyKey } from "@/lib/boardroom/idempotency";

export type AuthedSupabase = {
  supabase: SupabaseClient;
  userId: string;
  token: string;
};

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// The idempotency key for a member-initiated write. A stable client-supplied
// `Idempotency-Key` header makes a resent request a no-op; when it is absent or
// malformed we fall back to a random key, which simply means this request is not
// deduplicated (old-client-safe) rather than failing it.
export function requestIdempotencyKey(req: NextRequest): string {
  return normalizeIdempotencyKey(req.headers.get("idempotency-key")) ?? randomUUID();
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

// The defined lockout response (WBR-373 Stream C). Every workspace route returns
// this instead of the raw "Workspace access denied." text, and the app renders
// it as the lockout screen whenever it sees code "boardroom_locked".
export const BOARDROOM_LOCKED_CODE = "boardroom_locked";
export const BOARDROOM_LOCKED_MESSAGE = "Your AI Boardroom access is managed in Studio, and this account does not have it right now.";

export function workspaceLocked() {
  return NextResponse.json({ error: BOARDROOM_LOCKED_MESSAGE, code: BOARDROOM_LOCKED_CODE }, { status: 403 });
}

export class WorkspaceAccessError extends Error {
  constructor(message = BOARDROOM_LOCKED_MESSAGE) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

// Server-side owner check: true only when this workspace belongs to one of
// David's admin accounts (boardroom_workspace_owner_is_admin, security definer).
// Any error or missing function answers false, so a member always gets the
// clean personas rather than David's.
export async function workspaceOwnerIsAdmin(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("boardroom_workspace_owner_is_admin", { target_workspace: workspaceId });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function ensureWorkspaceMember(supabase: SupabaseClient, workspaceId: string) {
  // Entitlement first: a lapsed or revoked Studio grant locks every route, not
  // only the workspace list.
  const access = await supabase.rpc("boardroom_has_access");
  if (access.error) throw access.error;
  if (access.data !== true) throw new WorkspaceAccessError();
  const { data, error } = await supabase
    .from("boardroom_workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new WorkspaceAccessError();
}

import type { SupabaseClient } from "@supabase/supabase-js";

// AI Boardroom optimistic concurrency (WO-20261002-evening, Stream A;
// Developer 9,18,20).
//
// Advisor cards are the rows two members can edit at once: triaging a card to
// active, done or trash. Without versioning the later write silently overwrites
// the earlier one with no record of the conflict. Each card now carries a
// `version` that a database trigger bumps on every update. A client reads a card
// at version N and writes back naming N; if anyone has written in between, the
// row is already at N+1, the version-guarded update matches zero rows, and the
// write is refused as stale instead of clobbering.

export type VersionedUpdate<T> =
  | { kind: "updated"; row: T }
  | { kind: "stale" };

// Parse a caller-supplied expected version. Absent or malformed means "no
// optimistic check requested" (null), which callers may allow for backward
// compatibility; a present value must be a positive integer.
export function parseExpectedVersion(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Interpret the rows returned by a version-guarded update. Postgres returns the
// updated rows; an empty result means the WHERE version = expected matched
// nothing, i.e. the row moved on and this write is stale.
export function interpretVersionedUpdate<T>(rows: T[] | null | undefined): VersionedUpdate<T> {
  if (rows && rows.length > 0) return { kind: "updated", row: rows[0] };
  return { kind: "stale" };
}

// Apply a version-guarded update to a boardroom_advisor_cards row. When
// expectedVersion is null the update is unguarded (the row is still matched by
// id + workspace), preserving the pre-versioning behavior for old clients.
export async function updateCardWithVersion<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  input: {
    workspaceId: string;
    cardId: string;
    patch: Record<string, unknown>;
    expectedVersion: number | null;
  },
): Promise<VersionedUpdate<T> & { error?: { message: string } }> {
  let query = supabase
    .from("boardroom_advisor_cards")
    .update(input.patch)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.cardId);

  if (input.expectedVersion !== null) {
    query = query.eq("version", input.expectedVersion);
  }

  const { data, error } = await query.select("*");
  if (error) return { kind: "stale", error: { message: error.message } };
  return interpretVersionedUpdate<T>(data as T[] | null);
}

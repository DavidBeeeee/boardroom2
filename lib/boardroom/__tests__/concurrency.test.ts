import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseExpectedVersion,
  interpretVersionedUpdate,
  updateCardWithVersion,
} from "../concurrency.ts";

test("parseExpectedVersion accepts positive integers, rejects the rest", () => {
  assert.equal(parseExpectedVersion(1), 1);
  assert.equal(parseExpectedVersion("7"), 7);
  assert.equal(parseExpectedVersion(undefined), null); // no check requested
  assert.equal(parseExpectedVersion(null), null);
  assert.equal(parseExpectedVersion(""), null);
  assert.equal(parseExpectedVersion(0), null);
  assert.equal(parseExpectedVersion(-3), null);
  assert.equal(parseExpectedVersion(1.5), null);
  assert.equal(parseExpectedVersion("abc"), null);
});

test("interpretVersionedUpdate: rows means updated, empty means stale", () => {
  assert.deepEqual(interpretVersionedUpdate([{ id: "c1", version: 2 }]), {
    kind: "updated",
    row: { id: "c1", version: 2 },
  });
  assert.deepEqual(interpretVersionedUpdate([]), { kind: "stale" });
  assert.deepEqual(interpretVersionedUpdate(null), { kind: "stale" });
  assert.deepEqual(interpretVersionedUpdate(undefined), { kind: "stale" });
});

// A fake Supabase query builder that mirrors a version-guarded update against a
// single stored row: the update only "matches" when every .eq() filter matches,
// including version when supplied. This is exactly the WHERE the route builds.
function fakeCardsClient(stored: { id: string; workspace_id: string; version: number; status: string }) {
  return {
    from() {
      const filters: Record<string, unknown> = {};
      let pendingPatch: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        update(patch: Record<string, unknown>) {
          pendingPatch = patch;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        select() {
          const matches =
            filters.workspace_id === stored.workspace_id &&
            filters.id === stored.id &&
            (filters.version === undefined || filters.version === stored.version);
          if (!matches) return Promise.resolve({ data: [], error: null });
          // Apply the patch and bump the version, as the DB trigger would.
          Object.assign(stored, pendingPatch, { version: stored.version + 1 });
          return Promise.resolve({ data: [{ ...stored }], error: null });
        },
      };
      return builder;
    },
  };
}

test("a fresh version-guarded update succeeds and the stored row advances", async () => {
  const stored = { id: "c1", workspace_id: "ws-1", version: 1, status: "suggested" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await updateCardWithVersion(fakeCardsClient(stored) as any, {
    workspaceId: "ws-1",
    cardId: "c1",
    patch: { status: "done" },
    expectedVersion: 1,
  });
  assert.equal(result.kind, "updated");
  assert.equal(stored.version, 2);
  assert.equal(stored.status, "done");
});

test("a stale version-guarded update is refused and clobbers nothing", async () => {
  // The row already advanced to version 2 (someone else wrote first).
  const stored = { id: "c1", workspace_id: "ws-1", version: 2, status: "active" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await updateCardWithVersion(fakeCardsClient(stored) as any, {
    workspaceId: "ws-1",
    cardId: "c1",
    patch: { status: "trash" }, // the stale write we must reject
    expectedVersion: 1, // what this client last read
  });
  assert.equal(result.kind, "stale");
  // The concurrent write did not take effect.
  assert.equal(stored.status, "active");
  assert.equal(stored.version, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeIdempotencyKey,
  withIdempotency,
  type ClaimResult,
  type IdempotencyStore,
} from "../idempotency.ts";

// An in-memory store with the same claim/complete/release semantics as the
// Supabase-backed one: a unique (workspace, scope, key) is claimed once; a
// second claim sees the existing row; release removes an in_progress claim.
function memoryStore() {
  const rows = new Map<string, { id: string; status: "in_progress" | "completed"; response: unknown }>();
  let seq = 0;
  const k = (ws: string, scope: string, key: string) => `${ws}|${scope}|${key}`;
  const store: IdempotencyStore = {
    async claim({ workspaceId, scope, key }): Promise<ClaimResult> {
      const id = k(workspaceId, scope, key);
      const existing = rows.get(id);
      if (existing) return { state: "exists", status: existing.status, response: existing.response };
      const rowId = `row-${++seq}`;
      rows.set(id, { id: rowId, status: "in_progress", response: null });
      return { state: "claimed", id: rowId };
    },
    async complete(id, response) {
      for (const row of rows.values()) {
        if (row.id === id) {
          row.status = "completed";
          row.response = response;
        }
      }
    },
    async release(id) {
      for (const [key, row] of rows.entries()) {
        if (row.id === id && row.status === "in_progress") rows.delete(key);
      }
    },
  };
  return { store, rows };
}

const ctx = { workspaceId: "ws-1", scope: "chat", key: "key-abc-123", userId: "u-1" };

test("normalizeIdempotencyKey accepts a sane token and rejects junk", () => {
  assert.equal(normalizeIdempotencyKey("a1b2c3d4-ef56"), "a1b2c3d4-ef56");
  assert.equal(normalizeIdempotencyKey("  trimmed-key-value  "), "trimmed-key-value");
  assert.equal(normalizeIdempotencyKey("short"), null); // < 8 chars
  assert.equal(normalizeIdempotencyKey("has spaces here"), null);
  assert.equal(normalizeIdempotencyKey("bad/chars!"), null);
  assert.equal(normalizeIdempotencyKey(123 as unknown), null);
  assert.equal(normalizeIdempotencyKey("x".repeat(201)), null);
});

test("a resent request is a no-op: work runs once and no second DeepSeek call", async () => {
  const { store } = memoryStore();
  let deepseekCalls = 0;
  let inserts = 0;
  const work = async () => {
    deepseekCalls += 1;
    inserts += 3; // user message + assistant turns + memory
    return { ok: true, messages: deepseekCalls };
  };

  const first = await withIdempotency(store, ctx, work);
  assert.equal(first.kind, "fresh");
  assert.deepEqual(first.kind === "fresh" ? first.response : null, { ok: true, messages: 1 });

  // The same key arrives again (double-click / network retry).
  const second = await withIdempotency(store, ctx, work);
  assert.equal(second.kind, "replay");
  assert.deepEqual(second.kind === "replay" ? second.response : null, { ok: true, messages: 1 });

  // The whole point: generation ran exactly once and no new rows were written.
  assert.equal(deepseekCalls, 1, "DeepSeek must not be billed a second time");
  assert.equal(inserts, 3, "no duplicate message/card/memory rows");
});

test("different keys run independently", async () => {
  const { store } = memoryStore();
  let calls = 0;
  const work = async () => ({ n: ++calls });
  const a = await withIdempotency(store, { ...ctx, key: "key-aaaa-111" }, work);
  const b = await withIdempotency(store, { ...ctx, key: "key-bbbb-222" }, work);
  assert.equal(a.kind, "fresh");
  assert.equal(b.kind, "fresh");
  assert.equal(calls, 2);
});

test("a duplicate while the first is still in flight is reported, not re-run", async () => {
  const { store } = memoryStore();
  // Pre-claim the key to simulate the first request still running.
  await store.claim({ workspaceId: ctx.workspaceId, scope: ctx.scope, key: ctx.key, userId: ctx.userId });
  let ran = false;
  const outcome = await withIdempotency(store, ctx, async () => {
    ran = true;
    return { ok: true };
  });
  assert.equal(outcome.kind, "in_flight");
  assert.equal(ran, false, "the work must not run while the first claim is in flight");
});

test("a failed work releases the key so a genuine retry can run", async () => {
  const { store, rows } = memoryStore();
  await assert.rejects(
    withIdempotency(store, ctx, async () => {
      throw new Error("generation failed");
    }),
    /generation failed/,
  );
  assert.equal(rows.size, 0, "the claimed key is released after a failure");

  // Retry with the same key now succeeds and runs fresh.
  const retry = await withIdempotency(store, ctx, async () => ({ ok: true }));
  assert.equal(retry.kind, "fresh");
});

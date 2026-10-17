import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRateLimit, rateConfig, RateLimitedError, rateLimitedBody, type RateScope, type RateStore } from "../ratelimit.ts";

// WBR-373, Developer 97: the burst rate limit refuses with the same notice
// shape degraded mode uses, says when the member can send again, and fails
// open when its own counter is unreadable.

function memoryStore(): RateStore & { events: { scope: RateScope; at: number }[]; clock: { now: number } } {
  const events: { scope: RateScope; at: number }[] = [];
  const clock = { now: Date.parse("2026-10-16T22:00:00Z") };
  return {
    events,
    clock,
    async recent({ scope, sinceIso }) {
      const since = Date.parse(sinceIso);
      return events.filter(e => e.scope === scope && e.at >= since).map(e => e.at);
    },
    async record({ scope }) {
      events.push({ scope, at: clock.now });
    },
  };
}

const who = { workspaceId: "ws", userId: "u" };

test("chat: the ninth message inside a minute is refused with the degraded-notice shape", async () => {
  const store = memoryStore();
  const { max, windowSeconds } = rateConfig("chat");
  assert.equal(max, 8);
  assert.equal(windowSeconds, 60);
  for (let i = 0; i < max; i += 1) {
    await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now);
    store.clock.now += 2_000;
  }
  // 16 seconds after the first message: it ages out in 44 seconds.
  const refused = await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now).then(() => null, e => e);
  assert.ok(refused instanceof RateLimitedError);
  assert.equal(refused.retryAfterSeconds, 44);

  const body = rateLimitedBody(refused);
  assert.deepEqual(Object.keys(body).sort(), ["error", "failedService", "retryAfterSeconds", "retryable"]);
  assert.equal(body.retryable, true);
  assert.equal(body.failedService, "rate_limit");
  assert.match(body.error, /You can send again in about 44 seconds\./);
  assert.match(body.error, /back in the box below/);
  assert.match(body.error, /Retry/);
  assert.ok(!body.error.includes("—"), "no em dashes");
  assert.equal(store.events.length, max, "a refused request is not counted");
});

test("chat: the room opens again once the oldest message ages out", async () => {
  const store = memoryStore();
  for (let i = 0; i < 8; i += 1) await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now);
  store.clock.now += 61_000;
  await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now);
  assert.equal(store.events.length, 9);
});

test("stage: a normal session's stages never reach the stage cap", async () => {
  const store = memoryStore();
  for (let i = 0; i < 6; i += 1) await assertRateLimit(store, { ...who, scope: "chat_stage" }, store.clock.now);
  await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now);
  assert.equal(store.events.length, 7);
});

test("stage: a refused stage says what was kept", async () => {
  const store = memoryStore();
  for (let i = 0; i < 30; i += 1) await assertRateLimit(store, { ...who, scope: "chat_stage" }, store.clock.now);
  const refused = await assertRateLimit(store, { ...who, scope: "chat_stage" }, store.clock.now).then(() => null, e => e);
  assert.ok(refused instanceof RateLimitedError);
  assert.match(refused.message, /Everything said so far is saved\./);
});

test("env tunes the window and caps without a deploy", async () => {
  process.env.BOARDROOM_RATE_MAX_CHAT = "2";
  process.env.BOARDROOM_RATE_WINDOW_SECONDS = "10";
  try {
    const store = memoryStore();
    await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now);
    await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now);
    const refused = await assertRateLimit(store, { ...who, scope: "chat" }, store.clock.now).then(() => null, e => e);
    assert.ok(refused instanceof RateLimitedError);
    assert.equal(refused.retryAfterSeconds, 10);
  } finally {
    delete process.env.BOARDROOM_RATE_MAX_CHAT;
    delete process.env.BOARDROOM_RATE_WINDOW_SECONDS;
  }
});

test("fails open when the counter cannot be read", async () => {
  const broken: RateStore = {
    async recent() { throw new Error("relation boardroom_request_events does not exist"); },
    async record() { throw new Error("unreachable"); },
  };
  const original = console.error;
  console.error = () => {};
  try {
    await assertRateLimit(broken, { ...who, scope: "chat" });
  } finally {
    console.error = original;
  }
});

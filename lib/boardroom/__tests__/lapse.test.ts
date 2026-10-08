import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationMatchesChannel, lapseState, memoryForChannel, returnLine } from "../lapse.ts";

const now = new Date("2026-10-07T12:00:00Z");
const last = (daysAgo: number) => ({
  conversationId: "c1", channel: "brainstorming", snippet: "Should I raise my price to $497?",
  at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
});

test("21 days without a conversation is a lapse; 20 is a quiet week", () => {
  assert.equal(lapseState(last(20), now).lapsed, false);
  assert.equal(lapseState(last(21), now).lapsed, true);
  assert.equal(lapseState(null, now).lapsed, false);
});

test("the return line is warm and names the last conversation", () => {
  const line = returnLine(lapseState(last(30), now), "Margaret");
  assert.ok(line);
  assert.match(line!, /Welcome back, Margaret/);
  assert.match(line!, /4 weeks/);
  assert.match(line!, /Should I raise my price to \$497\?/);
  assert.ok(!line!.includes("—"));
  assert.equal(returnLine(lapseState(last(5), now), "Margaret"), null);
});

test("a 1:1 room sees only its own memory and the main room never sees a 1:1's", () => {
  const entries = [
    { id: "main-tagged", metadata: { channel: "brainstorming" } },
    { id: "legacy", metadata: {} },
    { id: "calvina", metadata: { channel: "Calvina" } },
    { id: "russell", metadata: { channel: "Russell" } },
  ];
  assert.deepEqual(memoryForChannel(entries, "brainstorming").map(e => e.id), ["main-tagged", "legacy"]);
  assert.deepEqual(memoryForChannel(entries, "Calvina").map(e => e.id), ["calvina"]);
  assert.deepEqual(memoryForChannel(entries, "Russell").map(e => e.id), ["russell"]);
});

test("a conversation id is reused only inside its own channel", () => {
  assert.equal(conversationMatchesChannel({ channel: "brainstorming" }, "Calvina"), false);
  assert.equal(conversationMatchesChannel({ channel: "Calvina" }, "Russell"), false);
  assert.equal(conversationMatchesChannel({ channel: "Calvina" }, "Calvina"), true);
  assert.equal(conversationMatchesChannel(null, "brainstorming"), false);
});

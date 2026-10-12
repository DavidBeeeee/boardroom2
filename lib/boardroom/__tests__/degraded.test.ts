import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, failureNotice, stageFailureNotice } from "../degraded.ts";

// WBR-373 continuation, Developer 81 to 83: when DeepSeek or Supabase is down
// the member keeps their message, hears plainly what failed, and can retry.

const deepseekDown = new Error("DeepSeek error 503: Service Unavailable upstream connect error");
const supabaseDown = { message: "FetchError: request to https://x.supabase.co/rest/v1/boardroom_messages failed", code: "PGRST000" };

test("a DeepSeek outage is named as the AI service", () => {
  assert.equal(classifyFailure(deepseekDown), "ai");
  assert.equal(classifyFailure(new Error("DeepSeek returned an empty response.")), "ai");
});

test("a Supabase outage, as an Error or a PostgREST error object, is named as the database", () => {
  assert.equal(classifyFailure(supabaseDown), "database");
  assert.equal(classifyFailure(new Error("Connection terminated due to connection timeout")), "database");
});

test("the notice says the message is saved only when it was", () => {
  const saved = failureNotice(deepseekDown, true);
  assert.match(saved.message, /AI service/);
  assert.match(saved.message, /Your message is saved\./);
  assert.match(saved.message, /Retry/);
  const unsaved = failureNotice(supabaseDown, false, "database");
  assert.match(unsaved.message, /database/);
  assert.match(unsaved.message, /back in the box below/);
  assert.ok(!/is saved/.test(unsaved.message));
});

test("no raw provider error, status code or em dash reaches the member", () => {
  for (const notice of [failureNotice(deepseekDown, true), failureNotice(supabaseDown, false), stageFailureNotice(deepseekDown), stageFailureNotice(supabaseDown, "database"), failureNotice(new Error("boom"), true)]) {
    assert.ok(!/503|PGRST|supabase\.co|upstream|boom/i.test(notice.message), notice.message);
    assert.ok(!notice.message.includes("—"));
    assert.equal(notice.retryable, true);
  }
});

test("a failed stage says earlier turns are kept and Retry continues", () => {
  assert.match(stageFailureNotice(deepseekDown).message, /Everything said so far is saved\. Press Retry to continue/);
});

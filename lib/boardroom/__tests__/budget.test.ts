import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetNotice, budgetRule } from "../budget.ts";

const status = (calls: number, tokens = 0) => ({ windowHours: 24, calls, maxCalls: 400, tokens, maxTokens: 3_000_000 });

test("the member is told the budget rule up front, in plain words", () => {
  const rule = budgetRule(status(0));
  assert.match(rule, /rolling 24 hours/);
  assert.match(rule, /8 to 12 advisor calls/);
  assert.ok(!rule.includes("—"));
});

test("a warning appears at 75% of either cap, never before", () => {
  assert.equal(budgetNotice(status(299)), null);
  assert.match(budgetNotice(status(300))!, /about 75%/);
  assert.match(budgetNotice(status(10, 2_400_000))!, /about 80%/);
  assert.match(budgetNotice(status(400))!, /used all/);
  for (const n of [300, 400]) assert.ok(!budgetNotice(status(n))!.includes("—"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crisisResponse, detectCrisis } from "../safety.ts";

// WBR-373 Stream B. The evaluation file is the contract for the crisis check.
const { cases } = JSON.parse(readFileSync(new URL("./safety-cases.json", import.meta.url), "utf8")) as {
  cases: { text: string; trip: boolean; category?: string }[];
};

test("the evaluation file has at least ten cases, both kinds", () => {
  assert.ok(cases.length >= 10);
  assert.ok(cases.some(c => c.trip));
  assert.ok(cases.some(c => !c.trip));
});

for (const c of cases) {
  test(`${c.trip ? "trips" : "does not trip"}: ${c.text}`, () => {
    const result = detectCrisis(c.text);
    assert.equal(result.tripped, c.trip);
    if (c.trip && result.tripped && c.category) assert.equal(result.category, c.category);
  });
}

test("the crisis response is plain, points to help, and has no em dashes", () => {
  const reply = crisisResponse("Margaret");
  assert.match(reply, /^Margaret, /);
  assert.match(reply, /988/);
  assert.match(reply, /emergency/);
  assert.ok(!reply.includes("—"));
  assert.ok(!/Tony|Russell|Chanos|Calvina/.test(reply), "no advisor voice in a safety reply");
});

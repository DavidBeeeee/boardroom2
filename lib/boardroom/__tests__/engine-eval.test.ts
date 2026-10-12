import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardMemoryContent, runTonyClose, runTonyIntake, setLlmTransportForTests, type SessionState } from "../engine.ts";
import { classifyMemberInput } from "../input-kind.ts";
import { PROPOSAL_PREFIX } from "../claims.ts";
import { createBoardroomLogger } from "../logging.ts";
import { detectCrisis } from "../safety.ts";
import { modeContext } from "../mode.ts";

// WBR-373, Developer 45 and 51 to 57. Every case runs through the real engine
// stages with DeepSeek stubbed at the transport. The room's routing is
// asserted, not the prose. Any network call fails the suite.

type EngineCase = { id: string; kind: string; text: string; model: string; expect: string };
type ClaimCase = {
  id: string;
  member: string[];
  card: { title: string; context: string; desiredOutput: string };
  expectUnsupported: boolean;
};
const { cases, claims } = JSON.parse(readFileSync(new URL("./engine-cases.json", import.meta.url), "utf8")) as {
  cases: EngineCase[];
  claims: ClaimCase[];
};

// No live DeepSeek: any fetch during this suite is a failure.
let networkCalls = 0;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network call attempted during engine evaluation");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  setLlmTransportForTests(null);
});

const MODEL_REPLIES: Record<string, string> = {
  // The model ignores the instruction and starts rounds with several questions.
  route_many_questions: "Love it! What is your offer? Who is it for? How much do you charge?\n\n@Russell what's the hook? @Allen what's the next action?\n```json\n{\"selectedAdvisors\":[\"Russell\",\"Allen\"],\"advisorQuestions\":{\"Russell\":\"Hook?\",\"Allen\":\"Next action?\"},\"tension\":\"growth\"}\n```",
  no_question: "Big energy. Let's get the team on it.\n```json\n{\"selectedAdvisors\":[\"Russell\"],\"advisorQuestions\":{},\"tension\":\"scope\"}\n```",
  route_plain: "Here is my read, and here is who I'm bringing in. @Russell take the numbers.\n```json\n{\"selectedAdvisors\":[\"Russell\",\"Allen\"],\"advisorQuestions\":{\"Russell\":\"Run the numbers.\"},\"tension\":\"price versus volume\"}\n```",
  clarify_plain: "Before I bring anyone in, tell me how many clients you have today.",
  garbage: "\u0000{not json",
};

let calls = 0;
const prompts: string[] = [];
function stub(reply: string) {
  calls = 0;
  prompts.length = 0;
  setLlmTransportForTests(async (messages) => {
    calls += 1;
    prompts.push(messages.filter(m => m.role === "system").map(m => m.content).join("\n"));
    return reply;
  });
}

const mode = modeContext({ depth: "normal", lane: "business" });

test("the evaluation set has at least fourteen cases, two of each of the seven kinds", () => {
  assert.ok(cases.length >= 14);
  for (const kind of ["vague", "broad", "hard_to_measure", "conflicting", "concept_distinction", "filler", "unusual"]) {
    assert.ok(cases.filter(c => c.kind === kind).length >= 2, `two ${kind} cases`);
  }
  assert.ok(claims.length >= 4);
});

for (const c of cases) {
  test(`engine case ${c.id} (${c.kind}): ${c.expect}`, async () => {
    assert.equal(classifyMemberInput(c.text).kind, c.kind, "classified as its kind");
    assert.equal(detectCrisis(c.text).tripped, false, "never trips the crisis check");

    stub(MODEL_REPLIES[c.model]);
    const result = await runTonyIntake({ userPrompt: c.text, context: "CONTEXT", history: [], mode, ceoName: "Margaret" });
    const content = result.turns.map(t => t.content).join("\n");
    assert.ok(!content.includes("—"), "no em dashes in member copy");

    if (c.expect === "one_clarifying_question") {
      assert.equal(result.nextStage, "clarify");
      assert.equal(result.sessionState, null, "no advisor rounds start");
      assert.equal(result.turns.length, 1);
      assert.equal(result.turns[0].speaker, "Tony");
      assert.equal(result.turns[0].stage, "tony_clarify");
      assert.equal((content.match(/\?/g) ?? []).length, 1, "exactly one question");
      assert.ok(!/@(Russell|Allen|Calvina|Andrej)/.test(content), "no advisor is called");
      assert.match(prompts[0], /Ask exactly ONE clarifying question/);
    } else if (c.expect === "short_prompt_no_model_call") {
      assert.equal(calls, 0, "no model call for filler or unusual input");
      assert.equal(result.nextStage, "clarify");
      assert.equal(result.sessionState, null);
      assert.equal(result.turns.length, 1);
      assert.ok(content.length < 220, "a short prompt, not a round");
    } else if (c.expect === "names_conflict") {
      assert.match(content, /pull against each other|conflict|tension/i);
      if (result.sessionState) assert.match(result.sessionState.tension, /^Conflict: /);
      assert.match(prompts[0], /contains a conflict between/);
    } else if (c.expect.startsWith("guidance:")) {
      assert.ok(prompts[0].includes(c.expect.slice("guidance:".length)), "Tony is told what to pin down");
    } else if (c.expect === "routes_to_advisors") {
      assert.equal(result.nextStage, "advisor_round");
      assert.ok(result.sessionState && result.sessionState.selectedAdvisors.length >= 1);
    } else {
      assert.fail(`unknown expectation ${c.expect}`);
    }
  });
}

// A logger backed by a fake Supabase client, so the real row shape is checked.
function capturingLogger() {
  const rows: Array<Record<string, unknown>> = [];
  const supabase = { from: () => ({ insert: (row: Record<string, unknown>) => { rows.push(row); return Promise.resolve({ error: null }); } }) };
  const logger = createBoardroomLogger(supabase as never, { workspaceId: "ws", conversationId: "conv", userId: "u" });
  return { rows, logger };
}

for (const c of claims) {
  test(`invented-progress case ${c.id}: ${c.expectUnsupported ? "rewritten as a proposal and logged" : "left alone"}`, async () => {
    const closeJson = JSON.stringify({ decision: "Move.", actionCards: [{ ...c.card, advisor: "Allen", workType: "draft" }] });
    stub(`THE CALL: we move this week, and here is the sequence for the room to follow.\n\`\`\`json\n${closeJson}\n\`\`\``);
    const { rows, logger } = capturingLogger();
    const history = c.member.slice(0, -1).map(content => ({ role: "user" as const, speaker: "You", content, stage: "user_prompt" }));
    const state: SessionState = {
      userPrompt: c.member.at(-1)!, tonyIntakeMessage: "Read", selectedAdvisors: ["Allen"], advisorQuestions: {}, tension: "t",
      allTurns: [{ speaker: "Tony", stage: "tony_intake", content: "Read" }], currentRound: 2, currentChanosRound: 2,
    };
    const result = await runTonyClose({ context: "CONTEXT", history, mode, sessionState: state, log: logger });
    await logger.flush();
    const card = result.cards[0];
    const claimRows = rows.filter(r => r.event_type === "unsupported_claim");

    if (c.expectUnsupported) {
      assert.ok(`${card.title}\n${card.context}\n${card.desiredOutput}`.includes(PROPOSAL_PREFIX), "written as a proposal");
      assert.equal(card.status, "suggested");
      assert.equal(claimRows.length, 1, "one unsupported_claim row");
      const serialized = JSON.stringify(claimRows[0]);
      for (const said of [...c.member, c.card.context]) assert.ok(!serialized.includes(said), "no member or claim text in the log");
      assert.deepEqual(Object.keys(claimRows[0].detail as object).sort(), ["claims", "rewrittenAsProposal", "target", "unsupported"]);
    } else {
      assert.ok(!JSON.stringify(card).includes(PROPOSAL_PREFIX), "a supported or planned step is not rewritten");
      assert.equal(claimRows.length, 0);
    }
  });
}

test("invented-progress guard on a workspace memory write", async () => {
  const { rows, logger } = capturingLogger();
  const out = guardMemoryContent("You signed 12 clients and closed the beta. Next, you will email them.", ["How do I get my first client?"], logger);
  await logger.flush();
  assert.ok(out.startsWith(PROPOSAL_PREFIX));
  assert.ok(out.includes("Next, you will email them."), "the plan sentence is untouched");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, "unsupported_claim");
  assert.ok(!JSON.stringify(rows[0]).includes("first client"));
});

test("zero network calls to DeepSeek across the whole evaluation", () => {
  assert.equal(networkCalls, 0);
});

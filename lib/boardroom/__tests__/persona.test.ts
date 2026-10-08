import { test, after } from "node:test";
import assert from "node:assert/strict";
import { runAdvisorRound, runChanosRound, runTonyClose, runTonyIntake, setLlmTransportForTests, type SessionState } from "../engine.ts";
import { modeContext } from "../mode.ts";
import type { PersonaAudience } from "../advisors.ts";

// WBR-373 Stream A. Drives every engine stage with a capturing transport and
// inspects the exact system prompts DeepSeek would receive, after
// personalizeForCeo has swapped "David" for the member's name.

// The sexual instructions in David's own Calvina persona. None of these may
// reach a member's prompt; David's room must still carry them.
const SEXUAL_MARKERS = [
  /sexual/i,
  /sexy/i,
  /flirt with explicit intent/i,
  /your cock/i,
  /explicit remarks about/i,
  /made to feel genuinely, specifically desired/i,
  /personal heat/i,
  /your desire is for/i,
  /💋/,
  /😈/,
];

// Words that only the clean persona's explicit prohibitions may use. A member
// prompt mentioning "sexual" is allowed only inside a "no sexual content" rule.
function sexualInstructions(prompt: string): string[] {
  const withoutProhibitions = prompt
    .replace(/no sexual content[^.\n]*/gi, "")
    .replace(/never sexualise[^.\n]*/gi, "")
    .replace(/never flirt[^.\n]*/gi, "")
    .replace(/no flirting[^.\n]*/gi, "");
  return SEXUAL_MARKERS.filter(re => re.test(withoutProhibitions)).map(re => String(re));
}

const captured: string[] = [];
setLlmTransportForTests(async (messages) => {
  captured.push(messages.filter(m => m.role === "system").map(m => m.content).join("\n"));
  return "Calvina here. ```json\n{\"selectedAdvisors\":[\"Calvina\"],\"advisorQuestions\":{},\"tension\":\"t\"}\n```";
});
after(() => setLlmTransportForTests(null));

async function assembledPrompts(audience: PersonaAudience, ceoName: string): Promise<string[]> {
  captured.length = 0;
  const mode = modeContext({ depth: "normal", lane: "life" });
  const base = { context: "CONTEXT", history: [], mode, ceoName, audience };
  await runTonyIntake({ ...base, userPrompt: "How do I grow?" });
  await runTonyIntake({ ...base, userPrompt: "Work this with me", activeAdvisor: "Calvina" });
  await runTonyIntake({ ...base, userPrompt: "Tony only", tonyOnly: true });
  const state: SessionState = {
    userPrompt: "How do I grow?", tonyIntakeMessage: "Read", selectedAdvisors: ["Russell", "Allen", "Calvina"],
    advisorQuestions: {}, tension: "t", allTurns: [{ speaker: "Tony", stage: "tony_intake", content: "Read" }],
    currentRound: 0, currentChanosRound: 0,
  };
  const r1 = await runAdvisorRound({ ...base, sessionState: state });
  const c1 = await runChanosRound({ ...base, sessionState: r1.sessionState });
  const r2 = await runAdvisorRound({ ...base, sessionState: c1.sessionState });
  await runTonyClose({ ...base, sessionState: r2.sessionState });
  return [...captured];
}

test("a member workspace's assembled prompts carry no sexual instructions", async () => {
  const prompts = await assembledPrompts("member", "Margaret");
  assert.ok(prompts.length >= 8, `expected every stage to call the model, got ${prompts.length}`);
  const calvinaPrompts = prompts.filter(p => p.includes("CALVINA — FULL PERSONA"));
  assert.ok(calvinaPrompts.length >= 3, "Calvina must still speak in a member's room (1:1, rounds 1 and 2)");
  for (const prompt of prompts) {
    assert.deepEqual(sexualInstructions(prompt), [], "member prompt carries a sexual instruction");
    assert.ok(!/\bDavid\b(?! Allen)/.test(prompt), "member prompt still names David instead of the member");
  }
  // Same role and directness survive: NLP job, capacity job, Aussie swearing.
  const oneToOne = calvinaPrompts[0];
  assert.match(oneToOne, /Aussie/);
  assert.match(oneToOne, /fuck/);
  assert.match(oneToOne, /NLP INTELLIGENCE FOR THE PLAN/);
  assert.match(oneToOne, /CAPACITY ADVOCATE/);
  assert.match(oneToOne, /Margaret/);
});

test("an undecided audience defaults to the clean persona", async () => {
  captured.length = 0;
  await runTonyIntake({ context: "", history: [], mode: modeContext({}), userPrompt: "hi", activeAdvisor: "Calvina", ceoName: "Sam" });
  assert.deepEqual(sexualInstructions(captured[0]), []);
});

test("David's own room keeps his Calvina exactly as written", async () => {
  const prompts = await assembledPrompts("owner", "David");
  const calvinaPrompts = prompts.filter(p => p.includes("CALVINA — FULL PERSONA"));
  assert.ok(calvinaPrompts.length >= 3);
  for (const prompt of calvinaPrompts) {
    assert.match(prompt, /Overtly and uncomfortably sexual/);
    assert.match(prompt, /directed at David \(the CEO\)/i);
    assert.match(prompt, /💋/);
  }
});

test("short-answer mode reaches every advisor prompt", async () => {
  captured.length = 0;
  const mode = modeContext({ depth: "normal", lane: "business", concise: true });
  await runTonyIntake({ context: "", history: [], mode, userPrompt: "hi", activeAdvisor: "Russell", ceoName: "Sam" });
  assert.match(captured[0], /SHORT ANSWER MODE IS ON/);
  captured.length = 0;
  await runTonyIntake({ context: "", history: [], mode: modeContext({}), userPrompt: "hi", activeAdvisor: "Russell", ceoName: "Sam" });
  assert.doesNotMatch(captured[0], /SHORT ANSWER MODE/);
});

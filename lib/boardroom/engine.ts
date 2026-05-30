import type { AdvisorName, BoardroomTurn, GeneratedCard, Message, ModeContext } from "@/lib/types";
import { ALL_ADVISORS, formatAdvisorVoiceContract, formatAdvisorVoicePacket, BOARDROOM_GUARDRAILS } from "./advisors";
import { callDeepSeek, type ChatMessage } from "./deepseek";

// ── Session State (passed between frontend and API stages) ────────────────────

export type SessionState = {
  userPrompt: string;
  tonyIntakeMessage: string;
  selectedAdvisors: AdvisorName[];
  advisorQuestions: Record<string, string>;
  tension: string;
  allTurns: BoardroomTurn[];      // every turn so far this session
  currentRound: number;           // how many advisor rounds completed
  currentChanosRound: number;     // how many chanos rounds completed
};

export type StageResult = {
  turns: BoardroomTurn[];
  cards: GeneratedCard[];
  tension: string;
  nextStage: "advisor_round" | "chanos" | "tony_close" | "done";
  sessionState: SessionState;
};

// ── Utilities ──────────────────────────────────────────────────────────────────

export function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as T;
  return JSON.parse(text) as T;
}

export function canonicalAdvisor(name: unknown): AdvisorName {
  const clean = String(name ?? "").trim().toLowerCase();
  if (clean === "jim" || clean === "james") return "Chanos";
  const match = (["Tony", ...ALL_ADVISORS] as AdvisorName[]).find(n => n.toLowerCase() === clean);
  return match ?? "Tony";
}

export function historyMessages(history: Pick<Message, "role" | "speaker" | "content" | "stage">[]): ChatMessage[] {
  return history.slice(-12).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.role === "user" ? m.content : `${m.speaker}: ${m.content}`,
  }));
}

async function llm(messages: ChatMessage[], clientApiKey?: string): Promise<string> {
  return callDeepSeek(messages, clientApiKey);
}

async function structured<T>(messages: ChatMessage[], clientApiKey: string | undefined, fallback: T): Promise<T> {
  const raw = await llm(messages, clientApiKey);
  try { return parseJson<T>(raw); }
  catch { return fallback; }
}

export function turnsToContext(turns: BoardroomTurn[]): string {
  if (!turns.length) return "None yet.";
  return turns.map(t => `${t.speaker}: ${t.content}`).join("\n\n");
}

export function normalizeCards(cards: GeneratedCard[], mode: ModeContext, decision: string): GeneratedCard[] {
  return (cards ?? [])
    .filter((c): c is GeneratedCard => Boolean(c?.title))
    .map(c => ({
      type: c.type ?? "local_doc",
      workType: c.workType ?? "manual",
      title: c.title.slice(0, 160),
      advisor: canonicalAdvisor(c.advisor),
      priority: Number(c.priority ?? 3),
      status: c.status ?? "suggested",
      context: c.context ?? "",
      desiredOutput: c.desiredOutput ?? "Create the requested artifact or working draft.",
      label: c.label ?? "",
      sourceDecision: c.sourceDecision ?? decision,
      inputs: c.inputs ?? {},
      externalTarget: c.externalTarget ?? "",
    }))
    .slice(0, mode.cardLimit);
}

function nextStageFor(state: SessionState, mode: ModeContext): StageResult["nextStage"] {
  const numRounds = mode.depth === "quick" ? 1 : mode.depth === "normal" ? 2 : 3;
  const chanosRoundsNeeded = mode.depth === "quick" ? 1 : 2;

  // Need more advisor rounds?
  if (state.currentRound < numRounds && state.currentChanosRound >= state.currentRound) {
    return "advisor_round";
  }
  // Need a Chanos round?
  if (state.currentChanosRound < chanosRoundsNeeded && state.currentRound > state.currentChanosRound) {
    return "chanos";
  }
  // All rounds done?
  const allAdvisorsDone = state.currentRound >= numRounds;
  const allChanosDone = state.currentChanosRound >= chanosRoundsNeeded;
  if (allAdvisorsDone && allChanosDone) {
    return "tony_close";
  }
  // Fallback
  return "tony_close";
}

// ── STAGE 1: Tony Intake ──────────────────────────────────────────────────────

// Detect if the last assistant message was a tony_intake (clarification)
// If so, this user message is a follow-up answer — don't treat as a new question
function isFollowUpToClarification(history: Pick<Message, "role" | "speaker" | "content" | "stage">[]): boolean {
  const assistantMessages = history.filter(h => h.role === "assistant");
  const lastAssistant = assistantMessages.at(-1) as (typeof assistantMessages[0] & { stage?: string }) | undefined;
  return lastAssistant?.stage === "tony_intake";
}

export async function runTonyIntake(input: {
  userPrompt: string;
  context: string;
  history: Pick<Message, "role" | "speaker" | "content" | "stage">[];
  mode: ModeContext;
  clientApiKey?: string;
  tonyOnly?: boolean;
  activeAdvisor?: AdvisorName;
}): Promise<{ turns: BoardroomTurn[]; sessionState: SessionState | null; nextStage: StageResult["nextStage"] | "done" | "clarify" | "one_to_one" }> {

  // 1:1 advisor session — run and finish immediately
  if (input.activeAdvisor) {
    const result = await runAdvisorOneToOne(input.activeAdvisor, input);
    return { turns: result.turns, sessionState: null, nextStage: "done" };
  }

  const baseHistory = historyMessages(input.history);
  const isFollowUp = isFollowUpToClarification(input.history as Pick<Message, "role" | "speaker" | "content" | "stage">[]);

  // Tony-only — one pass and done
  if (input.tonyOnly && !isFollowUp) {
    const raw = await llm([
      {
        role: "system",
        content: `${BOARDROOM_GUARDRAILS}\n\n${formatAdvisorVoicePacket("Tony", "tony_only", input.mode)}\n${formatAdvisorVoiceContract("Tony", "tony_only")}\n${input.context}\n\nHandle this directly. Short, direct, no essay.`
      },
      ...baseHistory,
      { role: "user", content: input.userPrompt }
    ], input.clientApiKey);

    return {
      turns: [{ speaker: "Tony", stage: "tony_only", content: raw }],
      sessionState: null,
      nextStage: "done"
    };
  }

  const fallback = {
    speaker: "Tony" as const,
    path: "route" as const,
    message: "David, I have the signal. Let me bring the right people in.",
    selectedAdvisors: [input.mode.laneAdvisor] as AdvisorName[],
    advisorQuestions: {} as Record<string, string>,
    includeAndrej: false,
    tension: "What's the real constraint?",
  };

  // Two-step approach: Tony writes his message as plain text FIRST,
  // then outputs a small routing JSON. This prevents JSON-breaking special chars.
  const rawTonyResponse = await llm([
    {
      role: "system",
      content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "intake", input.mode)}
${formatAdvisorVoiceContract("Tony", "intake")}

${input.context}

You are reading the CEO's message.

${isFollowUp
  ? `CRITICAL: Your previous message asked a clarifying question. The CEO just answered it. You MUST route now — do NOT ask another question.`
  : `DEFAULT: Route immediately. Give your honest read and call in the right advisors.
Only add a clarifying question if you genuinely cannot pick any advisor without one more fact.`
}

Advisor rules:
- Business/money/launch: Russell + Allen, add Calvina if mindset matters
- Life/identity/emotions: Calvina + Allen
- Technical/code/AI: Andrej + Russell
- "everyone" or "full table": Russell + Allen + Calvina (+ Andrej if technical)
- Chanos is ALWAYS separate — never list him in selectedAdvisors
- Default: ${input.mode.laneAdvisor}

Write your response in TWO parts separated by ---ROUTING---

PART 1: Your message to David (100-180 words, use **bold** and emojis, no --- dividers, no ## headers, speak like Tony)

---ROUTING---

PART 2: JSON routing block only (no other text):
{"path":"route","selectedAdvisors":["Russell","Allen"],"advisorQuestions":{"Russell":"question","Allen":"question"},"tension":"one sentence"}`
    },
    ...baseHistory,
    { role: "user", content: input.userPrompt }
  ], input.clientApiKey);

  // Split on the routing separator
  const separatorIdx = rawTonyResponse.indexOf("---ROUTING---");
  let tonyMessage = separatorIdx > 0
    ? rawTonyResponse.slice(0, separatorIdx).trim()
    : rawTonyResponse.trim();
  const routingRaw = separatorIdx > 0
    ? rawTonyResponse.slice(separatorIdx + 13).trim()
    : "";

  // Parse routing JSON
  let routing = fallback;
  if (routingRaw) {
    try { routing = { ...fallback, ...parseJson<typeof fallback>(routingRaw) }; }
    catch { /* keep fallback */ }
  }

  // If Tony didn't write a real message, use his routing signal
  if (!tonyMessage || tonyMessage.length < 20) {
    tonyMessage = routing.message || fallback.message;
  }

  const intake = { ...routing, message: tonyMessage };

  const turns: BoardroomTurn[] = [{ speaker: "Tony", stage: "tony_intake", content: intake.message }];

  if (intake.path === "clarify") {
    return { turns, sessionState: null, nextStage: "clarify" };
  }

  let selectedAdvisors: AdvisorName[] = (intake.selectedAdvisors ?? [])
    .map(canonicalAdvisor)
    .filter((a): a is AdvisorName => a !== "Tony" && a !== "Chanos");

  // Always have at least the lane advisor — never let an empty room happen
  if (!selectedAdvisors.length) {
    selectedAdvisors = [input.mode.laneAdvisor];
  }

  const sessionState: SessionState = {
    userPrompt: input.userPrompt,
    tonyIntakeMessage: intake.message,
    selectedAdvisors,
    advisorQuestions: intake.advisorQuestions ?? {},
    tension: intake.tension || "",
    allTurns: turns,
    currentRound: 0,
    currentChanosRound: 0,
  };

  return {
    turns,
    sessionState,
    nextStage: nextStageFor(sessionState, input.mode),
  };
}

// ── STAGE 2: Advisor Group Round ──────────────────────────────────────────────

export async function runAdvisorRound(input: {
  context: string;
  history: Pick<Message, "role" | "speaker" | "content" | "stage">[];
  mode: ModeContext;
  clientApiKey?: string;
  sessionState: SessionState;
}): Promise<StageResult> {
  const { sessionState, mode } = input;
  const round = sessionState.currentRound + 1;
  const roundLabel = round === 1 ? "first" : round === 2 ? "second" : "third";
  const advisors = sessionState.selectedAdvisors;
  const baseHistory = historyMessages(input.history);

  const fallback = { turns: advisors.map(a => ({ speaker: a, message: fallbackAdvisorTurn(a) })) };

  const payload = await structured<{ turns: { speaker: string; message: string }[] }>(
    [{
      role: "system",
      content: `${BOARDROOM_GUARDRAILS}

ACTIVE ADVISORS: ${advisors.join(", ")}

${advisors.map(a => `${formatAdvisorVoicePacket(a, `round_${round}`, mode)}\n${formatAdvisorVoiceContract(a, `round_${round}`)}`).join("\n\n---\n\n")}

${input.context}

USER'S QUESTION: ${sessionState.userPrompt}

TONY'S READ: ${sessionState.tonyIntakeMessage}

${sessionState.allTurns.length > 1 ? `PREVIOUS DISCUSSION:\n${turnsToContext(sessionState.allTurns.slice(1))}` : ""}

TONY'S QUESTIONS FOR THIS ${roundLabel.toUpperCase()} ROUND:
${advisors.map(a => `${a}: ${sessionState.advisorQuestions[a] || "Give your full perspective from your lane."}`).join("\n")}

ROUND ${round} CONTRACT:
- Each advisor responds at FULL intensity. No hedging.
- Round 2+ advisors MUST directly respond to previous turns and Chanos's critique by name.
- Agree only if you genuinely agree and say exactly why. Challenge everything else.
- NO --- dividers. NO ## headers. This is Slack, not a report.
- Each turn: 150-300 words max. Voice over volume.

Return JSON only:
{ "turns": [${advisors.map(a => `{"speaker":"${a}","message":"..."}`).join(",")}] }`
    },
    ...baseHistory,
    { role: "user", content: sessionState.userPrompt }
  ], input.clientApiKey, fallback);

  const turns: BoardroomTurn[] = [];
  for (const t of (payload.turns ?? [])) {
    const advisor = canonicalAdvisor(t.speaker);
    if (advisor === "Tony" || advisor === "Chanos") continue;
    turns.push({ speaker: advisor, stage: `advisor_round_${round}`, content: String(t.message || fallbackAdvisorTurn(advisor)) });
  }

  const newState: SessionState = {
    ...sessionState,
    allTurns: [...sessionState.allTurns, ...turns],
    currentRound: round,
  };

  return {
    turns,
    cards: [],
    tension: sessionState.tension,
    nextStage: nextStageFor(newState, mode),
    sessionState: newState,
  };
}

// ── STAGE 3: Chanos Solo ──────────────────────────────────────────────────────

export async function runChanosRound(input: {
  context: string;
  history: Pick<Message, "role" | "speaker" | "content" | "stage">[];
  mode: ModeContext;
  clientApiKey?: string;
  sessionState: SessionState;
}): Promise<StageResult> {
  const { sessionState, mode } = input;
  const round = sessionState.currentChanosRound + 1;
  const baseHistory = historyMessages(input.history);

  const raw = await llm([{
    role: "system",
    content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Chanos", `chanos_round_${round}`, mode)}
${formatAdvisorVoiceContract("Chanos", `chanos_round_${round}`)}

${input.context}

USER'S QUESTION: ${sessionState.userPrompt}

TONY'S READ: ${sessionState.tonyIntakeMessage}

DISCUSSION SO FAR:
${turnsToContext(sessionState.allTurns.slice(1))}

You are Chanos. Round ${round} critique. Short the plan.

Structure: name the promotional narrative → find the fatal assumption → audit the math or execution → name the ONE red flag Tony must resolve.

NO --- dividers. NO ## headers. 150-300 words. Speak like a villain, not an essayist.`
  },
  ...baseHistory,
  { role: "user", content: sessionState.userPrompt }
  ], input.clientApiKey);

  const turn: BoardroomTurn = { speaker: "Chanos", stage: `chanos_round_${round}`, content: raw };

  const newState: SessionState = {
    ...sessionState,
    allTurns: [...sessionState.allTurns, turn],
    currentChanosRound: round,
  };

  return {
    turns: [turn],
    cards: [],
    tension: sessionState.tension,
    nextStage: nextStageFor(newState, mode),
    sessionState: newState,
  };
}

// ── STAGE 4: Tony Close ───────────────────────────────────────────────────────

export async function runTonyClose(input: {
  context: string;
  history: Pick<Message, "role" | "speaker" | "content" | "stage">[];
  mode: ModeContext;
  clientApiKey?: string;
  sessionState: SessionState;
}): Promise<StageResult> {
  const { sessionState, mode } = input;
  const baseHistory = historyMessages(input.history);

  const fallbackDecision = "Take the smallest action that tests the real constraint.";

  const close = await structured<{
    speaker: "Tony";
    decision: string;
    decisionBrief: Record<string, string>;
    message: string;
    actionCards: GeneratedCard[];
  }>([{
    role: "system",
    content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "close", mode)}
${formatAdvisorVoiceContract("Tony", "close")}

${input.context}

USER'S QUESTION: ${sessionState.userPrompt}

FULL DISCUSSION:
${turnsToContext(sessionState.allTurns)}

CORE TENSION: ${sessionState.tension}

Close the session. Make the call.

CONTRACT:
- Reconcile the strongest argument AND Chanos's red flag. Both must visibly shape the decision.
- Name the tension explicitly.
- Write like a COO who just sat in a hard room — not a consultant summarizing.
- Suggest 0-${mode.cardLimit} Advisor Work Cards. Specific, actionable, one task each.
- NO --- dividers. NO ## headers. Use **bold** for key phrases inline.

Return JSON only:
{
  "speaker": "Tony",
  "decision": "one clear specific decision",
  "decisionBrief": {
    "whyThisCall": "why, naming the tension and how it was resolved",
    "notDoing": "what we're explicitly not doing",
    "nextPhysicalAction": "one thing in the next 20 minutes",
    "artifactToCreate": "specific document to create",
    "checkpoint": "how you'll know it worked"
  },
  "message": "**DECISION**\\n[decision]\\n\\n**WHY THIS IS THE CALL**\\n[why]\\n\\n**WHAT WE ARE NOT DOING**\\n[not doing]\\n\\n**NEXT PHYSICAL ACTION**\\n[action]\\n\\n**ARTIFACT TO CREATE**\\n[artifact]\\n\\n**CHECKPOINT**\\n[checkpoint]",
  "actionCards": [{"title":"...","advisor":"Russell","workType":"draft","context":"...","desiredOutput":"..."}]
}`
  },
  ...baseHistory,
  { role: "user", content: sessionState.userPrompt }
  ], input.clientApiKey, {
    speaker: "Tony" as const,
    decision: fallbackDecision,
    decisionBrief: {
      whyThisCall: `The room surfaced: ${turnsToContext(sessionState.allTurns.slice(1)).slice(0, 400)}`,
      notDoing: "Adding complexity before validating the core assumption.",
      nextPhysicalAction: "Open a document and draft the artifact the room pointed toward.",
      artifactToCreate: "Session follow-up artifact",
      checkpoint: "The move worked if it produces a real artifact or a named constraint."
    },
    message: "",
    actionCards: [],
  });

  const turn: BoardroomTurn = {
    speaker: "Tony",
    stage: "tony_close",
    content: close.message || formatClose(close),
  };

  return {
    turns: [turn],
    cards: normalizeCards(close.actionCards ?? [], mode, close.decision),
    tension: sessionState.tension,
    nextStage: "done",
    sessionState: { ...sessionState, allTurns: [...sessionState.allTurns, turn] },
  };
}

// ── 1:1 Advisor Session ───────────────────────────────────────────────────────

async function runAdvisorOneToOne(
  advisor: AdvisorName,
  input: { userPrompt: string; context: string; history: Pick<Message, "role" | "speaker" | "content" | "stage">[]; mode: ModeContext; clientApiKey?: string; }
) {
  const raw = await llm([
    {
      role: "system",
      content: `${BOARDROOM_GUARDRAILS}\n\n${formatAdvisorVoicePacket(advisor, "one_to_one", input.mode)}\n${formatAdvisorVoiceContract(advisor, "one_to_one")}\n${input.context}\n\n1:1 work session. Build the actual artifact with them. No --- dividers. No ## headers.`
    },
    ...historyMessages(input.history),
    { role: "user", content: input.userPrompt }
  ], input.clientApiKey);

  return {
    turns: [{ speaker: advisor, stage: "advisor_one_to_one", content: raw }],
    cards: [] as GeneratedCard[],
    tension: "",
  };
}

// ── Legacy wrapper (used by 1:1 sessions via old route) ───────────────────────

export async function runBoardroomEngine(input: {
  userPrompt: string;
  context: string;
  history: Pick<Message, "role" | "speaker" | "content" | "stage">[];
  mode: ModeContext;
  clientApiKey?: string;
  activeAdvisor?: AdvisorName;
  tonyOnly?: boolean;
}) {
  if (input.activeAdvisor) {
    const raw = await llm([
      {
        role: "system",
        content: `${BOARDROOM_GUARDRAILS}\n\n${formatAdvisorVoicePacket(input.activeAdvisor, "one_to_one", input.mode)}\n${formatAdvisorVoiceContract(input.activeAdvisor, "one_to_one")}\n${input.context}\n\n1:1 work session. Build the actual artifact with them. No --- dividers. No ## headers.`
      },
      ...historyMessages(input.history),
      { role: "user", content: input.userPrompt }
    ], input.clientApiKey);
    return { turns: [{ speaker: input.activeAdvisor, stage: "advisor_one_to_one", content: raw }], cards: [] as GeneratedCard[], tension: "" };
  }
  return { turns: [] as BoardroomTurn[], cards: [] as GeneratedCard[], tension: "" };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatClose(close: { decision: string; decisionBrief: Record<string, string> }): string {
  return [
    "**DECISION**", close.decision, "",
    "**WHY THIS IS THE CALL**", close.decisionBrief.whyThisCall, "",
    "**WHAT WE ARE NOT DOING**", close.decisionBrief.notDoing, "",
    "**NEXT PHYSICAL ACTION**", close.decisionBrief.nextPhysicalAction, "",
    "**ARTIFACT TO CREATE**", close.decisionBrief.artifactToCreate, "",
    "**CHECKPOINT**", close.decisionBrief.checkpoint,
  ].join("\n");
}

function fallbackAdvisorTurn(advisor: AdvisorName): string {
  const fallbacks: Record<AdvisorName, string> = {
    Tony: "David, turn this signal into one concrete decision, one next action, one artifact.",
    Russell: "The commercial path needs to be concrete: one audience, one hook, one offer, one conversion event. If we can't name all four, it's still theater. 🎣",
    Allen: "What does done look like? Strip it until the first move takes 20 minutes or less. ✅",
    Chanos: "The plan fails if distribution, proof, cash conversion, or delivery capacity is assumed instead of verified. Kill the fantasy math. 🩸",
    Andrej: "Build only where tooling changes throughput. If the bottleneck is trust or offer clarity, no app fixes that. 🤖",
    Calvina: "Listen to the language underneath the strategy. If the sentence installs panic, the action will wobble. Shift the internal frame first. 💋",
  };
  return fallbacks[advisor];
}

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

  type RoutingData = {
    selectedAdvisors: AdvisorName[];
    advisorQuestions: Record<string, string>;
    tension: string;
  };

  const fallbackRouting: RoutingData = {
    selectedAdvisors: [input.mode.laneAdvisor],
    advisorQuestions: {},
    tension: "What's the real constraint?",
  };

  // Tony writes ONE message that does everything:
  // his read of the situation + tags each advisor + asks them a specific question.
  // Then outputs a small JSON block for routing metadata.
  const rawTonyResponse = await llm([
    {
      role: "system",
      content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "intake", input.mode)}
${formatAdvisorVoiceContract("Tony", "intake")}

${input.context}

${isFollowUp ? `The CEO just answered your question. Route now.` : ""}

Write ONE message that does ALL of this:
1. Give your honest, sharp read of the situation — name the real constraint or the real question underneath the question
2. Name who you're bringing in and specifically WHY each person
3. Ask each advisor a direct specific question — like you're tagging them in Slack: "@Russell — I need you to show me the math on..." "@Allen — what's the first 20-minute action that..." "@Calvina — what's the internal block that..."

Advisor rules:
- Business/money/launch: Russell + Allen always, Calvina if mindset/identity is relevant
- Life/identity/emotions: Calvina + Allen
- Technical/code/AI: Andrej + Russell
- "everyone"/"full table": Russell + Allen + Calvina (+ Andrej if technical)
- Chanos is ALWAYS separate — NEVER include him here
- Default if unclear: ${input.mode.laneAdvisor}

OUTPUT FORMAT — write Tony's message first (120-200 words, full personality, bold, emojis, tag advisors with @Name), then the JSON block:

\`\`\`json
{"selectedAdvisors":["Russell","Allen"],"advisorQuestions":{"Russell":"specific question","Allen":"specific question"},"tension":"one sentence naming the core tension"}
\`\`\``
    },
    ...baseHistory,
    { role: "user", content: input.userPrompt }
  ], input.clientApiKey);

  // Extract routing JSON from the code block
  let routing = fallbackRouting;
  try { routing = { ...fallbackRouting, ...parseJson<RoutingData>(rawTonyResponse) }; }
  catch { /* keep fallback */ }

  // Extract Tony's message = everything before the first ```
  const codeBlockIdx = rawTonyResponse.indexOf("```");
  let tonyMessage = codeBlockIdx > 0
    ? rawTonyResponse.slice(0, codeBlockIdx).trim()
    : rawTonyResponse.replace(/\{[\s\S]*\}/, "").trim();

  if (!tonyMessage || tonyMessage.length < 20) {
    tonyMessage = "David, I have the signal. Let me bring the right people in.";
  }

  const turns: BoardroomTurn[] = [{ speaker: "Tony", stage: "tony_intake", content: tonyMessage }];

  let selectedAdvisors: AdvisorName[] = (routing.selectedAdvisors ?? [])
    .map(canonicalAdvisor)
    .filter((a): a is AdvisorName => a !== "Tony" && a !== "Chanos");

  if (!selectedAdvisors.length) {
    selectedAdvisors = [input.mode.laneAdvisor];
  }

  const sessionState: SessionState = {
    userPrompt: input.userPrompt,
    tonyIntakeMessage: tonyMessage,
    selectedAdvisors,
    advisorQuestions: routing.advisorQuestions ?? {},
    tension: routing.tension || "",
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

  const previousContext = sessionState.allTurns.length > 1
    ? `PREVIOUS DISCUSSION:\n${turnsToContext(sessionState.allTurns.slice(1))}`
    : "";

  // Build a summary of the most recent round's turns for advisors to respond to
  const lastRoundTurns = sessionState.allTurns.filter(
    t => t.stage === `advisor_round_${round - 1}` || t.stage === `chanos_round_${round - 1}`
  );
  const lastRoundContext = lastRoundTurns.length
    ? `WHAT WAS JUST SAID (round ${round - 1} — this is what you are responding to):\n${turnsToContext(lastRoundTurns)}`
    : "";

  // Run each advisor in parallel as plain text — no JSON, no parsing failures
  const advisorResponses = await Promise.all(
    advisors.map(async (advisor) => {
      const isRound1 = round === 1;
      const message = await llm([
        {
          role: "system",
          content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket(advisor, `round_${round}`, mode)}
${formatAdvisorVoiceContract(advisor, `round_${round}`)}

${input.context}

ORIGINAL QUESTION (background only): ${sessionState.userPrompt}
TONY'S READ: ${sessionState.tonyIntakeMessage}

${isRound1
  ? `TONY'S QUESTION FOR YOU: ${sessionState.advisorQuestions[advisor] || "Give your full perspective from your lane."}\n\nAnswer from your lane. This is round 1 — give your best take on the situation.`
  : `${lastRoundContext}

YOUR TASK FOR ROUND ${round}:
You are NOT re-answering the original question. You are responding to what was just said in round ${round - 1} above.

- What specifically do you AGREE with from the last round, and why?
- What specifically do you CHALLENGE or think is WRONG, and why?
- What NEW angle, number, or move can you add that NOBODY has named yet?

If you find yourself saying the same thing as your previous round, STOP and find the new insight. The room has already heard your round 1 position. What changed? What did Chanos or another advisor say that forces you to revise, sharpen, or fight back?

Name the other advisors by name when you respond to them.`
}

Write as ${advisor}. Plain text only — no JSON, no code blocks.
150-300 words. Full personality. Bold key phrases. Emojis. No --- dividers. No ## headers.`
        },
        ...baseHistory,
        { role: "user", content: sessionState.userPrompt }
      ], input.clientApiKey);

      return { advisor, message: message || fallbackAdvisorTurn(advisor) };
    })
  );

  const turns: BoardroomTurn[] = advisorResponses.map(({ advisor, message }) => ({
    speaker: advisor,
    stage: `advisor_round_${round}`,
    content: message,
  }));

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

  // Get the most recent advisor round turns — this is what Chanos is critiquing
  const latestAdvisorRound = sessionState.allTurns.filter(
    t => t.stage === `advisor_round_${round}`
  );
  const latestAdvisorContext = latestAdvisorRound.length
    ? `WHAT THE ADVISORS JUST SAID IN ROUND ${round} — THIS IS WHAT YOU ARE SHORTING:\n${turnsToContext(latestAdvisorRound)}`
    : `DISCUSSION SO FAR:\n${turnsToContext(sessionState.allTurns.slice(1))}`;

  const raw = await llm([{
    role: "system",
    content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Chanos", `chanos_round_${round}`, mode)}
${formatAdvisorVoiceContract("Chanos", `chanos_round_${round}`)}

${input.context}

ORIGINAL QUESTION (background only): ${sessionState.userPrompt}
TONY'S READ: ${sessionState.tonyIntakeMessage}

${latestAdvisorContext}

You are Chanos. Your job is to SHORT THE ADVISORS' ARGUMENTS FROM ROUND ${round} ABOVE — not to respond to the original question again.

${round > 1 ? `You already made your round ${round - 1} critique. Do NOT repeat it. Find the NEW fatal assumption in what the advisors just said in round ${round}.` : ""}

Structure:
1. Name the specific thing an advisor just said that you're shorting (quote them by name)
2. Find the fatal assumption in their NEW argument
3. Audit the specific math or claim they just made
4. Name the ONE red flag Tony must resolve before the close

NO --- dividers. NO ## headers. 150-300 words. Villain energy, not essay energy.`
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

  // Tony writes his close as rich free-form markdown, then a small JSON block for cards only.
  // This prevents the JSON-breaking problem from long rich text in JSON strings.
  const rawClose = await llm([{
    role: "system",
    content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "close", mode)}
${formatAdvisorVoiceContract("Tony", "close")}

${input.context}

ORIGINAL QUESTION: ${sessionState.userPrompt}

FULL BOARDROOM DISCUSSION — READ ALL OF IT BEFORE YOU WRITE ANYTHING:
${turnsToContext(sessionState.allTurns)}

CORE TENSION IDENTIFIED: ${sessionState.tension}

You are Tony. You just sat in a hard room. You heard every advisor, every challenge, every Chanos critique. Now you make the call.

YOUR CLOSE MUST:
- Be LONGER and RICHER than a typical message — this is your synthesis of everything the room produced
- Name the strongest argument that won AND the Chanos red flag that constrained it — both must be visible
- Make a specific, real decision — not a platitude, a call
- Give a sequenced action plan, not just one step — this is your final word, make it count
- Use **bold** for key phrases, emojis naturally, section breaks with blank lines
- Sound like a decisive COO who just ran a hard meeting, not a consultant writing a summary
- NO --- dividers between sections. NO ## headers. Write in your voice, not report format.

FORMAT — write your full close first, then the cards JSON block:

[Write Tony's full close here — 300-500 words. Use this structure naturally in your own voice:
THE CALL: one sharp sentence naming the decision
WHY THIS IS THE CALL: reconcile the room — name who was right, what the tension was, how it resolves
WHAT WE ARE NOT DOING: name the tempting paths explicitly ruled out
THE SEQUENCE: 3-5 specific ordered actions with timeframes, not just one next step
THE CHECKPOINT: how David will know this worked]

\`\`\`json
{"decision":"one clear decision sentence","actionCards":[{"title":"specific card title","advisor":"Russell","workType":"draft","context":"why this matters","desiredOutput":"what to create"}]}
\`\`\``
  },
  ...baseHistory,
  { role: "user", content: sessionState.userPrompt }
  ], input.clientApiKey);

  // Extract Tony's close message — everything before the ```json block
  const codeBlockIdx = rawClose.indexOf("```");
  let closeMessage = codeBlockIdx > 0
    ? rawClose.slice(0, codeBlockIdx).trim()
    : rawClose.trim();

  if (!closeMessage || closeMessage.length < 50) {
    closeMessage = formatClose({
      decision: "Take the smallest action that tests the real constraint.",
      decisionBrief: {
        whyThisCall: `The room surfaced key tension: ${sessionState.tension}`,
        notDoing: "Adding complexity before validating the core assumption.",
        nextPhysicalAction: "Take the first physical action the room identified.",
        artifactToCreate: "Session follow-up artifact",
        checkpoint: "The move worked if it produces a real artifact or a named constraint."
      }
    });
  }

  // Extract cards from JSON block
  let cards: GeneratedCard[] = [];
  let decision = "Move forward with the plan the room identified.";
  try {
    const parsed = parseJson<{ decision?: string; actionCards?: GeneratedCard[] }>(rawClose);
    if (parsed.decision) decision = parsed.decision;
    if (parsed.actionCards) cards = parsed.actionCards;
  } catch { /* no cards if JSON fails */ }

  const turn: BoardroomTurn = {
    speaker: "Tony",
    stage: "tony_close",
    content: closeMessage,
  };

  return {
    turns: [turn],
    cards: normalizeCards(cards, mode, decision),
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

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
  return lastAssistant?.stage === "tony_clarify";
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

  // ── FOLLOW-UP PATH: Tony already asked a clarifying question, now route ────────
  // Run a dedicated focused routing call — no long essay, just call the team + JSON.
  if (isFollowUp) {
    const rawRouting = await llm([
      {
        role: "system",
        content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "intake", input.mode)}
${formatAdvisorVoiceContract("Tony", "intake")}

${input.context}

The CEO just answered your clarifying question. You now have enough to route.

Write a SHORT message (60-100 words max) — acknowledge what you just learned, name exactly who you're calling in and the specific question for each. No long read of the situation — David just gave you the info. Just call the team.

Advisor rules:
- Business/money/launch: Russell + Allen always, Calvina if mindset/identity is relevant
- Life/identity/emotions: Calvina + Allen
- Technical/code/AI: Andrej + Russell
- "everyone"/"full table": Russell + Allen + Calvina (+ Andrej if technical)
- Chanos is ALWAYS separate — NEVER include him here

OUTPUT FORMAT — brief Tony message first, then the JSON block:

\`\`\`json
{"selectedAdvisors":["Russell","Allen"],"advisorQuestions":{"Russell":"specific question","Allen":"specific question"},"tension":"one sentence naming the core tension"}
\`\`\``
      },
      ...baseHistory,
      { role: "user", content: input.userPrompt }
    ], input.clientApiKey);

    let routingData = fallbackRouting;
    try { routingData = { ...fallbackRouting, ...parseJson<RoutingData>(rawRouting) }; }
    catch { /* keep fallback */ }

    const codeIdx = rawRouting.indexOf("```");
    let routingMessage = codeIdx > 0
      ? rawRouting.slice(0, codeIdx).trim()
      : rawRouting.replace(/\{[\s\S]*\}/, "").trim();
    if (!routingMessage || routingMessage.length < 10) {
      routingMessage = "Got it. Bringing in the team now.";
    }

    const routingTurn: BoardroomTurn = { speaker: "Tony", stage: "tony_intake", content: routingMessage };

    let selectedFromFollowUp: AdvisorName[] = (routingData.selectedAdvisors ?? [])
      .map(canonicalAdvisor)
      .filter((a): a is AdvisorName => a !== "Tony" && a !== "Chanos");

    const mentionedInRouting = (["Russell", "Allen", "Calvina", "Andrej"] as AdvisorName[])
      .filter(name => routingMessage.includes(`@${name}`));
    if (mentionedInRouting.length > selectedFromFollowUp.length) {
      selectedFromFollowUp = mentionedInRouting;
    }
    if (!selectedFromFollowUp.length) selectedFromFollowUp = [input.mode.laneAdvisor];

    const followUpState: SessionState = {
      userPrompt: input.userPrompt,
      tonyIntakeMessage: routingMessage,
      selectedAdvisors: selectedFromFollowUp,
      advisorQuestions: routingData.advisorQuestions ?? {},
      tension: routingData.tension || "",
      allTurns: [routingTurn],
      currentRound: 0,
      currentChanosRound: 0,
    };

    return {
      turns: [routingTurn],
      sessionState: followUpState,
      nextStage: nextStageFor(followUpState, input.mode),
    };
  }

  // ── INITIAL PATH: Tony decides — clarify or route ─────────────────────────────
  // Tony can either ask ONE clarifying question (no JSON) or route immediately (with JSON).
  // We detect which path he took by whether a ```json block appears in his response.
  const rawTonyResponse = await llm([
    {
      role: "system",
      content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "intake", input.mode)}
${formatAdvisorVoiceContract("Tony", "intake")}

${input.context}

DECISION — do you have enough information to route this to the advisors right now?

IF YOU NEED ONE PIECE OF INFORMATION FIRST:
Write ONLY a direct question to David. Stay in full Tony voice. No advisor tags. No JSON block. One focused question that gets you what you need to route properly. Keep it under 150 words.
(When David answers, you will call the team.)

IF YOU HAVE ENOUGH TO ROUTE NOW:
Write ONE message that does ALL of this:
1. Give your honest, sharp read of the situation — name the real constraint or the real question underneath the question
2. Name who you're bringing in and specifically WHY each person
3. Ask each advisor a direct specific question — like you're tagging them in Slack:
   - @Russell: math, offer structure, hooks, conversion mechanics
   - @Allen: next physical action, open loops, what breaks at scale
   - @Calvina: ALWAYS ask her TWO things — (1) what NLP language or frame should Russell use for THIS specific avatar/offer, and (2) what's the capacity constraint this plan puts on the CEO that we need to account for
   - @Andrej: only for genuine technical questions

Advisor rules:
- Business/money/launch: Russell + Allen always, Calvina if mindset/identity is relevant
- Life/identity/emotions: Calvina + Allen
- Technical/code/AI: Andrej + Russell
- "everyone"/"full table": Russell + Allen + Calvina (+ Andrej if technical)
- Chanos is ALWAYS separate — NEVER include him here
- Default if unclear: ${input.mode.laneAdvisor}

If routing: write Tony's message first (120-200 words, full personality, bold, emojis, tag advisors with @Name), then the JSON block:

\`\`\`json
{"selectedAdvisors":["Russell","Allen"],"advisorQuestions":{"Russell":"specific question","Allen":"specific question"},"tension":"one sentence naming the core tension"}
\`\`\``
    },
    ...baseHistory,
    { role: "user", content: input.userPrompt }
  ], input.clientApiKey);

  // ── CLARIFY PATH: Tony asked a question, no JSON block present ────────────────
  const hasJsonBlock = rawTonyResponse.includes("```");
  if (!hasJsonBlock) {
    const clarifyMessage = rawTonyResponse.trim();
    return {
      turns: [{ speaker: "Tony", stage: "tony_clarify", content: clarifyMessage }],
      sessionState: null,
      nextStage: "clarify",
    };
  }

  // ── ROUTE PATH: Tony included JSON, proceed as normal ────────────────────────
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

  // Fallback: if JSON parsing gave fewer advisors than Tony @-mentioned in his message,
  // extract from @-mentions. This covers cases where the JSON block was malformed or cut off.
  const mentionedInText = (["Russell", "Allen", "Calvina", "Andrej"] as AdvisorName[])
    .filter(name => tonyMessage.includes(`@${name}`));
  if (mentionedInText.length > selectedAdvisors.length) {
    selectedAdvisors = mentionedInText;
  }

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

      // Extract this specific advisor's previous turns so we can show them exactly
      // what they said before — making repetition impossible to miss
      const myPreviousTurns = sessionState.allTurns.filter(
        t => t.speaker === advisor && t.stage.startsWith("advisor_round_")
      );
      const myPreviousContent = myPreviousTurns.length
        ? `YOUR PREVIOUS TURNS IN THIS SESSION (DO NOT REPEAT ANY OF THIS):\n${myPreviousTurns.map((t, i) => `[Round ${i + 1}]: ${t.content.slice(0, 400)}...`).join("\n\n")}`
        : "";

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
  ? `TONY'S QUESTION FOR YOU: "${sessionState.advisorQuestions[advisor] || "Give your full perspective from your lane."}"

MANDATORY OPENING: Your very first sentence must quote Tony's question and answer it directly. Format: "Tony asked me [question] — [your direct answer]." Do not open with your name, a greeting, or a general observation. Answer the question first, then give your full take from your lane.`
  : `${lastRoundContext}

${myPreviousContent}

YOUR TASK FOR ROUND ${round} — READ THIS CAREFULLY:
You are NOT re-answering the original question.
You are NOT repeating anything from your previous turns above.

STEP 1 — ADDRESS CHANOS FIRST: Find what Chanos said in the round above that targeted your argument or your lane. You MUST respond to it directly — either tear down why he's wrong with specific new logic or evidence he didn't account for, OR acknowledge the flaw and rebuild your recommendation on stronger ground. Do not ignore Chanos. He named a flaw in your position. The room is watching how you handle it.

STEP 2 — ADVANCE THE ROOM: After addressing Chanos, engage with at least one other advisor by name. Build on something they said that you can extend, or push back on a claim with a specific counter-argument. The goal is that by round ${round}, the room is closer to a real answer than it was in round ${round - 1}.

If your first sentence resembles anything in your previous turns above, DELETE IT and find a different angle.`
}

CRITICAL: Write ONLY your own response as ${advisor}. Do NOT reproduce the conversation above. Do NOT write as other advisors. Do NOT output a transcript. Write ONLY what ${advisor} says next.

Plain text only — no JSON, no code blocks.
150-300 words. Full personality. Bold key phrases. Emojis. No --- dividers. No ## headers.`
        },
        { role: "user", content: `You are ${advisor}. Respond now in ${advisor}'s voice only. Do not reproduce the conversation history. Write your response:` }
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

  // Get the most recent advisor round turns — this is what Chanos is critiquing
  const latestAdvisorRound = sessionState.allTurns.filter(
    t => t.stage === `advisor_round_${round}`
  );
  const latestAdvisorContext = latestAdvisorRound.length
    ? `WHAT THE ADVISORS JUST SAID IN ROUND ${round} — SHORT THESE SPECIFIC ARGUMENTS:\n${turnsToContext(latestAdvisorRound)}`
    : `DISCUSSION SO FAR:\n${turnsToContext(sessionState.allTurns.slice(1))}`;

  // Show Chanos his own previous critiques so he can't repeat them
  const myPreviousCritiques = sessionState.allTurns.filter(
    t => t.speaker === "Chanos" && t.stage.startsWith("chanos_round_")
  );
  const chanosPreviousContent = myPreviousCritiques.length
    ? `YOUR PREVIOUS CRITIQUES (DO NOT REPEAT — find NEW fatal assumptions):\n${myPreviousCritiques.map((t, i) => `[Chanos Round ${i + 1}]: ${t.content.slice(0, 400)}...`).join("\n\n")}`
    : "";

  const raw = await llm([{
    role: "system",
    content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Chanos", `chanos_round_${round}`, mode)}
${formatAdvisorVoiceContract("Chanos", `chanos_round_${round}`)}

${input.context}

ORIGINAL QUESTION (background only): ${sessionState.userPrompt}
TONY'S READ: ${sessionState.tonyIntakeMessage}

${latestAdvisorContext}

${chanosPreviousContent}

You are Chanos. SHORT EVERY ADVISOR WHO SPOKE IN ROUND ${round} ABOVE — not just the math, not just Russell. Everyone.

${round > 1 ? `Your previous critiques are shown above. Do NOT repeat them. The advisors have pivoted — find the NEW fatal assumption in their LATEST arguments, not their earlier ones.` : ""}

MANDATORY STRUCTURE — go through each advisor in turn:
- **Russell**: where does his math break? What unverified assumption is buried in his conversion rates, audience size, or offer price?
- **Allen**: what fatal assumption is hiding in his execution plan? What does done state assume that hasn't been proven? What open loop does his "next physical action" depend on that he didn't name?
- **Calvina**: what unverified claim is she making about the avatar's psychology or David's capacity? What does her NLP frame assume about how the customer thinks or behaves?
- **Andrej** (if present): what does his technical solution assume about resources, data, or implementation time that hasn't been measured?

Do not spend all your time on one person. The room has multiple fatal assumptions running in parallel — name them all.

End with the ONE red flag Tony must resolve before close — the single most fatal assumption across the whole room that if wrong, collapses everything else.

CRITICAL: Write ONLY Chanos's response. Do NOT reproduce the conversation above. Do NOT write as other advisors. Do NOT output a transcript. Write ONLY what Chanos says next.

NO --- dividers. NO ## headers. 200-350 words. Prosecutorial and precise — find the flaw in every argument, not just the obvious one.`
  },
  { role: "user", content: "You are Chanos. Short the advisors now. Write only Chanos's response:" }
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

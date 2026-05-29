import type { AdvisorName, BoardroomTurn, GeneratedCard, Message, ModeContext } from "@/lib/types";
import { ALL_ADVISORS, formatAdvisorVoiceContract, formatAdvisorVoicePacket, BOARDROOM_GUARDRAILS } from "./advisors";
import { callDeepSeek, type ChatMessage } from "./deepseek";

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as T;
  return JSON.parse(text) as T;
}

function canonicalAdvisor(name: unknown): AdvisorName {
  const clean = String(name ?? "").trim().toLowerCase();
  if (clean === "jim" || clean === "james") return "Chanos";
  const match = (["Tony", ...ALL_ADVISORS] as AdvisorName[]).find(n => n.toLowerCase() === clean);
  return match ?? "Tony";
}

function historyMessages(history: Pick<Message, "role" | "speaker" | "content">[]): ChatMessage[] {
  return history.slice(-8).map(m => ({
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

function turnsToContext(turns: BoardroomTurn[]): string {
  if (!turns.length) return "None yet.";
  return turns.map(t => `${t.speaker} [${t.stage.replace(/_/g, " ")}]: ${t.content}`).join("\n\n");
}

function normalizeCards(cards: GeneratedCard[], mode: ModeContext, decision: string): GeneratedCard[] {
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

// ── Main Engine ───────────────────────────────────────────────────────────────

export async function runBoardroomEngine(input: {
  userPrompt: string;
  context: string;
  history: Pick<Message, "role" | "speaker" | "content">[];
  mode: ModeContext;
  clientApiKey?: string;
  activeAdvisor?: AdvisorName;
  tonyOnly?: boolean;
}) {
  // 1:1 advisor session
  if (input.activeAdvisor) {
    return runAdvisorOneToOne(input.activeAdvisor, input);
  }

  const baseHistory = historyMessages(input.history);
  const ctx = input.context;
  const key = input.clientApiKey;
  const mode = input.mode;

  // ── STEP 1: TONY CLARIFICATION ────────────────────────────────────────────
  // Tony reads the message, gives his initial take, asks what he needs to know.
  // Returns path: "clarify" (needs more info) or "route" (ready to call the room)

  const clarifyFallback = {
    speaker: "Tony" as const,
    path: "route" as const,
    message: "David, I have the signal. Let me bring in the right people.",
    selectedAdvisors: [mode.laneAdvisor] as AdvisorName[],
    advisorQuestions: {} as Record<string, string>,
    includeAndrej: false,
    tension: "What's the real constraint here?",
  };

  const tonyRead = await structured<{
    speaker: "Tony";
    path: "clarify" | "route";
    message: string;
    selectedAdvisors: AdvisorName[];
    advisorQuestions: Record<string, string>;
    includeAndrej: boolean;
    tension: string;
  }>(
    [
      {
        role: "system",
        content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "clarification", mode)}
${formatAdvisorVoiceContract("Tony", "clarification")}

${ctx}

You are reading the CEO's message for the first time. Give your immediate, honest read of what's really going on. Then decide:

- If you need more clarity before calling the room: path = "clarify". Ask ONE specific question that gets you what you need. Make your read compelling enough that the CEO WANTS to answer.
- If you have enough to route: path = "route". Tell the CEO what you're seeing and explain exactly who you're calling in and WHY — what specific question you're putting to each advisor.

When selecting advisors:
- You decide who is needed. Not everyone is needed every time.
- Andrej ONLY if there is a genuine technical/AI/code/systems question. If unclear, leave him out.
- Chanos is ALWAYS called separately — do not include him in selectedAdvisors.
- For "call everyone" or "full table" requests: include all of Russell, Allen, Andrej, Calvina.
- For life/personal questions: lean toward Calvina and Allen. For business/marketing: Russell and Allen. For risk: Chanos will come separately.

Return JSON only:
{
  "speaker": "Tony",
  "path": "clarify|route",
  "message": "Tony's full visible message — his read + clarifying question OR his read + who he's calling and why",
  "selectedAdvisors": ["Russell", "Allen"],
  "advisorQuestions": {
    "Russell": "specific question Tony is putting to Russell",
    "Allen": "specific question Tony is putting to Allen"
  },
  "includeAndrej": false,
  "tension": "one sentence naming the core tension or unknown"
}`
      },
      ...baseHistory,
      { role: "user", content: input.userPrompt }
    ],
    key,
    clarifyFallback
  );

  const turns: BoardroomTurn[] = [];
  turns.push({ speaker: "Tony", stage: "tony_intake", content: tonyRead.message });

  // If Tony needs clarification, stop here and wait for the next user message
  if (tonyRead.path === "clarify") {
    return { turns, cards: [] as GeneratedCard[], tension: tonyRead.tension };
  }

  // Normalize selected advisors — Chanos is always separate, never in the group
  const selectedAdvisors: AdvisorName[] = (tonyRead.selectedAdvisors ?? [])
    .map(canonicalAdvisor)
    .filter((a): a is AdvisorName => a !== "Tony" && a !== "Chanos");

  // Tony-only or very simple questions — skip the room
  if (input.tonyOnly || selectedAdvisors.length === 0) {
    return { turns, cards: [] as GeneratedCard[], tension: "" };
  }

  const tension = tonyRead.tension || "What's the real constraint?";
  const advisorQuestions = tonyRead.advisorQuestions ?? {};
  let roundHistory: BoardroomTurn[] = [];

  // ── DEBATE ROUNDS ─────────────────────────────────────────────────────────
  // Quick: 1 round. Normal: 2 rounds. Deep: 3 rounds.
  const numRounds = mode.depth === "quick" ? 1 : mode.depth === "normal" ? 2 : 3;
  // Chanos runs separately after each round (except no 3rd Chanos in deep)
  const chanosRounds = mode.depth === "quick" ? 1 : 2;

  for (let round = 1; round <= numRounds; round++) {
    // ── GROUP ADVISOR ROUND ──────────────────────────────────────────────────
    const roundLabel = round === 1 ? "first" : round === 2 ? "second" : "third";

    const groupPayload = await structured<{
      turns: { speaker: string; message: string }[];
    }>(
      [
        {
          role: "system",
          content: `${BOARDROOM_GUARDRAILS}

You are facilitating the ${roundLabel} round of advisor discussion in the Boardroom.

ACTIVE ADVISORS THIS ROUND: ${selectedAdvisors.join(", ")}

${selectedAdvisors.map(a => `${formatAdvisorVoicePacket(a, `round_${round}`, mode)}\n${formatAdvisorVoiceContract(a, `round_${round}`)}`).join("\n\n---\n\n")}

${ctx}

ORIGINAL QUESTION: ${input.userPrompt}

TONY'S READ: ${tonyRead.message}

${round > 1 ? `PREVIOUS DISCUSSION:\n${turnsToContext(roundHistory)}` : ""}

TONY'S SPECIFIC QUESTIONS FOR THIS ROUND:
${selectedAdvisors.map(a => `${a}: ${advisorQuestions[a] || "Give your full perspective from your lane."}`).join("\n")}

CONTRACT FOR THIS ROUND:
- Each advisor responds in character at full intensity — no softening, no hedging
- Advisors in round 2+ must directly respond to what was said in round 1, including Chanos's critique
- Advisors can agree with each other's round 1 points if they genuinely agree — but they must say why
- Advisors should challenge, refine, or build on each other's positions
- Order matters: each advisor has heard the previous advisor's response in this same call
- Respond only as the named advisors. Tony and Chanos do not speak here.

Return JSON only:
{
  "turns": [
    ${selectedAdvisors.map(a => `{"speaker": "${a}", "message": "${a}'s full response"}`).join(",\n    ")}
  ]
}`
        },
        ...baseHistory,
        { role: "user", content: input.userPrompt }
      ],
      key,
      { turns: selectedAdvisors.map(a => ({ speaker: a, message: `[${a} — round ${round} response]` })) }
    );

    for (const t of (groupPayload.turns ?? [])) {
      const advisor = canonicalAdvisor(t.speaker);
      if (advisor === "Tony" || advisor === "Chanos") continue;
      const turn: BoardroomTurn = {
        speaker: advisor,
        stage: `advisor_round_${round}`,
        content: String(t.message || `[${advisor} — no response]`),
      };
      roundHistory.push(turn);
      turns.push(turn);
    }

    // ── CHANOS ROUND ──────────────────────────────────────────────────────────
    // Chanos always runs separately after each round (up to chanosRounds)
    if (round <= chanosRounds) {
      const chanosRaw = await llm(
        [
          {
            role: "system",
            content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Chanos", `chanos_round_${round}`, mode)}
${formatAdvisorVoiceContract("Chanos", `chanos_round_${round}`)}

${ctx}

ORIGINAL QUESTION: ${input.userPrompt}

TONY'S READ: ${tonyRead.message}

ADVISOR DISCUSSION SO FAR:
${turnsToContext(roundHistory)}

You are Chanos. This is your round ${round} critique. You have heard what the advisors just said. Now you short it.

Build your short thesis:
1. Name the promotional narrative or optimistic assumption in the advisor discussion
2. Find the fatal assumption — what has to be true for their plan to work that nobody has verified
3. Audit the unit economics or execution reality
4. Name the ONE red flag Tony must resolve before making the final call

Be specific. Be hostile to the plan. Be precise. End with your red flag.`
          },
          ...baseHistory,
          { role: "user", content: input.userPrompt }
        ],
        key
      );

      const chanosTurn: BoardroomTurn = {
        speaker: "Chanos",
        stage: `chanos_round_${round}`,
        content: chanosRaw,
      };
      roundHistory.push(chanosTurn);
      turns.push(chanosTurn);
    }
  }

  // ── TONY CLOSE ────────────────────────────────────────────────────────────
  const closeResult = await structured<{
    speaker: "Tony";
    decision: string;
    decisionBrief: Record<string, string>;
    message: string;
    actionCards: GeneratedCard[];
  }>(
    [
      {
        role: "system",
        content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket("Tony", "close", mode)}
${formatAdvisorVoiceContract("Tony", "close")}

${ctx}

ORIGINAL QUESTION: ${input.userPrompt}

FULL BOARDROOM DISCUSSION:
${turnsToContext(roundHistory)}

CORE TENSION IDENTIFIED: ${tension}

You are Tony closing this session. You have heard everything. Now you make the call.

CONTRACT FOR YOUR CLOSE:
- Acknowledge the strongest argument from the advisors AND Chanos's red flag. Both must influence your decision.
- Do not dismiss Chanos. His critique must change, constrain, or sharpen the call in some visible way.
- Name the tension explicitly. The best closes have a real "and here's what made it hard" moment.
- The Decision Brief should feel like a COO who sat in a hard room and made a real call, not a consultant summarizing a meeting.
- Suggest 0-${mode.cardLimit} Advisor Work Cards. Cards are specific, actionable work portals — one task, one advisor, one clear output. Not vague. Not generic.
- Do not claim anything was sent, published, purchased, or already done.

Return JSON only:
{
  "speaker": "Tony",
  "decision": "one clear, specific decision",
  "decisionBrief": {
    "whyThisCall": "the argument that won, and how Chanos's red flag shaped or constrained it",
    "notDoing": "the specific tempting paths we are explicitly not taking and why",
    "nextPhysicalAction": "one thing the CEO can do in the next 20 minutes",
    "artifactToCreate": "the specific document, draft, script, or output to create",
    "checkpoint": "how the CEO will know this move worked"
  },
  "message": "**DECISION**\\n[decision]\\n\\n**WHY THIS IS THE CALL**\\n[why]\\n\\n**WHAT WE ARE NOT DOING**\\n[not doing]\\n\\n**NEXT PHYSICAL ACTION**\\n[action]\\n\\n**ARTIFACT TO CREATE**\\n[artifact]\\n\\n**CHECKPOINT**\\n[checkpoint]",
  "actionCards": [
    {
      "title": "specific, concrete work card title",
      "advisor": "Russell",
      "workType": "draft",
      "context": "what decision this came from and why it matters now",
      "desiredOutput": "exactly what the CEO and advisor should produce together"
    }
  ]
}`
      },
      ...baseHistory,
      { role: "user", content: input.userPrompt }
    ],
    key,
    {
      speaker: "Tony" as const,
      decision: "Take the smallest action that tests the real constraint.",
      decisionBrief: {
        whyThisCall: `The room surfaced: ${turnsToContext(roundHistory).slice(0, 500)}`,
        notDoing: "Adding complexity before validating the core assumption.",
        nextPhysicalAction: "Open a blank document and draft the artifact the room pointed toward.",
        artifactToCreate: "Boardroom session follow-up artifact",
        checkpoint: "The move worked if it produces a real artifact, a real reply, or a named constraint."
      },
      message: "",
      actionCards: [],
    }
  );

  const closeTurn: BoardroomTurn = {
    speaker: "Tony",
    stage: "tony_close",
    content: closeResult.message || formatClose(closeResult),
  };
  turns.push(closeTurn);

  return {
    turns,
    cards: normalizeCards(closeResult.actionCards ?? [], mode, closeResult.decision),
    tension,
  };
}

// ── 1:1 Advisor Session ───────────────────────────────────────────────────────

async function runAdvisorOneToOne(
  advisor: AdvisorName,
  input: {
    userPrompt: string;
    context: string;
    history: Pick<Message, "role" | "speaker" | "content">[];
    mode: ModeContext;
    clientApiKey?: string;
  }
) {
  const raw = await llm(
    [
      {
        role: "system",
        content: `${BOARDROOM_GUARDRAILS}

${formatAdvisorVoicePacket(advisor, "one_to_one", input.mode)}
${formatAdvisorVoiceContract(advisor, "one_to_one")}

${input.context}

You are in a 1:1 work session with the CEO. This is implementation mode — help them create the actual artifact, draft, plan, or output. Do not just advise. Build with them. Do not claim to send, publish, delete, cancel, or buy anything.`
      },
      ...historyMessages(input.history),
      { role: "user", content: input.userPrompt }
    ],
    input.clientApiKey
  );

  return {
    turns: [{ speaker: advisor, stage: "advisor_one_to_one", content: raw }],
    cards: [] as GeneratedCard[],
    tension: "",
  };
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

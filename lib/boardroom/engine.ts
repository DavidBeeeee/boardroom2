import type { AdvisorName, BoardroomTurn, GeneratedCard, Message, ModeContext } from "@/lib/types";
import { ALL_ADVISORS, formatAdvisorVoiceContract, formatAdvisorVoicePacket } from "./advisors";
import { callDeepSeek, type ChatMessage } from "./deepseek";

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
  const match = (["Tony", ...ALL_ADVISORS] as AdvisorName[]).find(
    (n) => n.toLowerCase() === clean
  );
  return match ?? "Tony";
}

function requestedAdvisors(text: string): AdvisorName[] {
  const hits = [...text.matchAll(/@(Tony|Russell|Russel|Allen|Chanos|Jim|James|Andrej|Calvina)\b/gi)]
    .map((m) => canonicalAdvisor(m[1]))
    .filter((name): name is AdvisorName => name !== "Tony");
  if (/\b(everyone|all advisors|full table|whole team|full boardroom)\b/i.test(text)) {
    return ALL_ADVISORS;
  }
  return [...new Set(hits)];
}

function meaningfulDecision(text: string): boolean {
  return /\b(plan|strategy|decide|decision|should i|what should|make money|revenue|client|lead|offer|conversion|launch|sell|business|pricing|funnel|risk|architecture|technical|app|code|build|implement|life decision|urgent)\b/i.test(text);
}

function shouldRunTonyOnly(text: string): boolean {
  // Short factual questions, greetings, or simple requests Tony can handle alone
  if (text.length < 60) return true;
  if (/^(hi|hello|hey|what is|what are|who is|how do|can you|tell me|remind me|what does|define|explain|summarize)/i.test(text.trim())) return true;
  if (meaningfulDecision(text)) return false;
  return false;
}

function normalizeAdvisorSelection(
  names: unknown,
  mode: ModeContext,
  userPrompt: string
): AdvisorName[] {
  const explicit = requestedAdvisors(userPrompt);
  let selected: AdvisorName[] = Array.isArray(names)
    ? (names.map(canonicalAdvisor).filter((name) => name !== "Tony") as AdvisorName[])
    : [];
  if (explicit.length) selected = explicit;
  if (!selected.length) selected = [mode.laneAdvisor];
  if (meaningfulDecision(userPrompt) && !selected.includes("Chanos")) {
    selected.push("Chanos");
  }
  return [...new Set(selected)].slice(0, mode.depth === "deep" ? 5 : 3);
}

function historyMessages(history: Pick<Message, "role" | "speaker" | "content">[]): ChatMessage[] {
  return history.slice(-8).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.role === "user" ? m.content : `${m.speaker}: ${m.content}`,
  }));
}

async function structured<T>(
  messages: ChatMessage[],
  clientApiKey: string | undefined,
  fallback: T
): Promise<T> {
  const raw = await callDeepSeek(messages, clientApiKey);
  try {
    return parseJson<T>(raw);
  } catch {
    return fallback;
  }
}

export async function runBoardroomEngine(input: {
  userPrompt: string;
  context: string;
  history: Pick<Message, "role" | "speaker" | "content">[];
  mode: ModeContext;
  clientApiKey?: string;
  activeAdvisor?: AdvisorName;
  tonyOnly?: boolean;
}) {
  if (input.activeAdvisor) {
    return runAdvisorOneToOne(input.activeAdvisor, input);
  }

  const baseHistory = historyMessages(input.history);

  // Tony-only mode: skip the full room, Tony handles it alone
  if (input.tonyOnly || shouldRunTonyOnly(input.userPrompt)) {
    return runTonyOnlySession(input.userPrompt, input.context, baseHistory, input.mode, input.clientApiKey);
  }

  // Quick mode: single combined call instead of sequential API calls
  if (input.mode.depth === "quick") {
    return runQuickSession(input.userPrompt, input.context, baseHistory, input.mode, input.clientApiKey);
  }

  // Normal / Deep: full sequential pipeline
  return runFullSession(input, baseHistory);
}

async function runTonyOnlySession(
  userPrompt: string,
  context: string,
  baseHistory: ChatMessage[],
  mode: ModeContext,
  clientApiKey?: string
) {
  const raw = await callDeepSeek(
    [
      {
        role: "system",
        content: `You are Tony in David Bee's AI Boardroom, handling this one yourself.
${formatAdvisorVoicePacket("Tony", "tony_only", mode)}
${formatAdvisorVoiceContract("Tony", "tony_only")}
${context}

Give David a direct, useful answer. If this is a real decision, close with a one-line next action. Keep it tight.`,
      },
      ...baseHistory,
      { role: "user", content: userPrompt },
    ],
    clientApiKey
  );

  return {
    turns: [{ speaker: "Tony" as AdvisorName, stage: "tony_only", content: raw }],
    cards: [] as GeneratedCard[],
  };
}

async function runQuickSession(
  userPrompt: string,
  context: string,
  baseHistory: ChatMessage[],
  mode: ModeContext,
  clientApiKey?: string
) {
  const laneAdvisor = mode.laneAdvisor;

  const raw = await callDeepSeek(
    [
      {
        role: "system",
        content: `You are running a Quick Boardroom session for David Bee.
${formatAdvisorVoicePacket("Tony", "quick", mode)}
${context}

Write a tight response in this exact format — no extra commentary:

**Tony:** [2-3 sentence intake and routing]

**${laneAdvisor}:** [sharp lane-specific insight, 2-4 sentences]

**DECISION:** [one clear sentence]
**NEXT ACTION:** [one physical action David can take in the next 20 minutes]`,
      },
      ...baseHistory,
      { role: "user", content: userPrompt },
    ],
    clientApiKey
  );

  return {
    turns: [{ speaker: "Tony" as AdvisorName, stage: "tony_close", content: raw }],
    cards: [] as GeneratedCard[],
  };
}

async function runFullSession(
  input: {
    userPrompt: string;
    context: string;
    history: Pick<Message, "role" | "speaker" | "content">[];
    mode: ModeContext;
    clientApiKey?: string;
  },
  baseHistory: ChatMessage[]
) {
  const turns: BoardroomTurn[] = [];

  const tonyIntakeFallback = {
    speaker: "Tony" as const,
    path: "delegate" as const,
    message:
      "David, I have the signal. I am bringing in the voices that can create useful tension, then I will reconcile it into a real call.",
    selectedAdvisors: [input.mode.laneAdvisor] as AdvisorName[],
    reason: "Fallback routing by lane.",
    needsChallenge: meaningfulDecision(input.userPrompt),
  };

  const tonyIntake = await structured<{
    speaker: "Tony";
    path: "diagnose" | "delegate" | "decide";
    message: string;
    selectedAdvisors: AdvisorName[];
    reason: string;
    needsChallenge: boolean;
  }>(
    [
      {
        role: "system",
        content: `You are Tony, COO and final synthesizer for David Bee's AI Boardroom.
${formatAdvisorVoicePacket("Tony", "intake", input.mode)}
${formatAdvisorVoiceContract("Tony", "intake")}
${input.context}

Choose the meeting path. Return JSON only:
{"speaker":"Tony","path":"diagnose|delegate|decide","message":"visible Tony intake under 170 words","selectedAdvisors":["Russell"],"reason":"why","needsChallenge":false}

Rules: honor explicit @Advisor tags; include Chanos for real decisions/risk; do not write other advisor speeches; do not create cards in intake.`,
      },
      ...baseHistory,
      { role: "user", content: input.userPrompt },
    ],
    input.clientApiKey,
    tonyIntakeFallback
  );

  const selectedAdvisors =
    tonyIntake.path === "delegate"
      ? normalizeAdvisorSelection(tonyIntake.selectedAdvisors, input.mode, input.userPrompt)
      : [];

  turns.push({ speaker: "Tony", stage: "tony_intake", content: tonyIntake.message });

  if (tonyIntake.path === "diagnose") {
    return { turns, cards: [] as GeneratedCard[] };
  }

  const advisorTurns: BoardroomTurn[] = [];

  for (const advisor of selectedAdvisors) {
    const advisorFallback = {
      speaker: advisor,
      message: fallbackAdvisorTurn(advisor),
    };

    const payload = await structured<{ speaker: AdvisorName; message: string }>(
      [
        {
          role: "system",
          content: `You are ${advisor} in David Bee's AI Boardroom.
${formatAdvisorVoicePacket(advisor, "advisor_turn", input.mode)}
${formatAdvisorVoiceContract(advisor, "advisor_turn")}
${input.context}

Tony's intake: ${tonyIntake.message}
Previous advisor turns:
${advisorTurns.map((t) => `${t.speaker}: ${t.content}`).join("\n\n") || "None."}

Return JSON only: {"speaker":"${advisor}","message":"one clean message from ${advisor} only"}`,
        },
        ...baseHistory,
        { role: "user", content: input.userPrompt },
      ],
      input.clientApiKey,
      advisorFallback
    );

    const turn: BoardroomTurn = {
      speaker: advisor,
      stage: "advisor_turn",
      content: String(payload.message || fallbackAdvisorTurn(advisor)),
    };
    advisorTurns.push(turn);
    turns.push(turn);
  }

  const closeFallback = fallbackClose(input.userPrompt, advisorTurns);

  const close = await structured<{
    speaker: "Tony";
    decision: string;
    decisionBrief: Record<string, string>;
    message: string;
    actionCards: GeneratedCard[];
  }>(
    [
      {
        role: "system",
        content: `You are Tony, closing David Bee's AI Boardroom.
${formatAdvisorVoicePacket("Tony", "close", input.mode)}
${formatAdvisorVoiceContract("Tony", "close")}
${input.context}

Advisor turns:
${advisorTurns.map((t) => `${t.speaker}: ${t.content}`).join("\n\n") || "No advisor turns."}

Close with a real Decision Brief. Return JSON only:
{
  "speaker":"Tony",
  "decision":"one clear decision",
  "decisionBrief":{"whyThisCall":"...","notDoing":"...","nextPhysicalAction":"...","artifactToCreate":"...","checkpoint":"..."},
  "message":"**DECISION**\\n...\\n\\n**WHY THIS IS THE CALL**\\n...\\n\\n**WHAT WE ARE NOT DOING**\\n...\\n\\n**NEXT PHYSICAL ACTION**\\n...\\n\\n**ARTIFACT TO CREATE**\\n...\\n\\n**CHECKPOINT**\\n...",
  "actionCards":[]
}

Suggest 0-${input.mode.cardLimit} Advisor Work Cards only when they open useful 1:1 implementation sessions. Use existing advisor names only.`,
      },
      ...baseHistory,
      { role: "user", content: input.userPrompt },
    ],
    input.clientApiKey,
    closeFallback
  );

  turns.push({
    speaker: "Tony",
    stage: "tony_close",
    content: close.message || formatClose(close),
  });

  return {
    turns,
    cards: normalizeCards(close.actionCards ?? [], input.mode, close.decision),
  };
}

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
  const raw = await callDeepSeek(
    [
      {
        role: "system",
        content: `You are ${advisor} in a 1:1 Advisor Work session for David Bee.
${formatAdvisorVoicePacket(advisor, "one_to_one", input.mode)}
${formatAdvisorVoiceContract(advisor, "one_to_one")}
${input.context}

Help create the artifact or decision in your lane. Do not claim to send, publish, delete, cancel, or buy anything.`,
      },
      ...historyMessages(input.history),
      { role: "user", content: input.userPrompt },
    ],
    input.clientApiKey
  );

  return {
    turns: [{ speaker: advisor, stage: "advisor_one_to_one", content: raw }],
    cards: [] as GeneratedCard[],
  };
}

function fallbackAdvisorTurn(advisor: AdvisorName): string {
  const fallbacks: Record<AdvisorName, string> = {
    Tony: "David, the move is to turn the signal into one concrete decision, one next action, and one artifact that proves progress.",
    Russell:
      "The commercial path has to become concrete: one audience, one hook, one offer, one conversion event, and one proof loop. If we cannot name those, the plan is still theater.",
    Allen:
      "This becomes real when we define done and choose the next visible physical action. Strip it down until David can do the first move in 20 minutes or less.",
    Chanos:
      "Short thesis: the plan fails if the distribution, proof, cash conversion, or delivery capacity is assumed instead of verified. Kill the fantasy math before it kills the week.",
    Andrej:
      "Technically, I would only build where tooling changes throughput. If the bottleneck is trust or offer clarity, no app architecture fixes that.",
    Calvina:
      "Mate, listen to the language underneath the strategy. If the sentence installs panic, the action will wobble. Shift the internal frame, then take one grounded move.",
  };
  return fallbacks[advisor];
}

function fallbackClose(userPrompt: string, advisorTurns: BoardroomTurn[]) {
  return {
    speaker: "Tony" as const,
    decision: "Create the smallest artifact that tests the real constraint.",
    decisionBrief: {
      whyThisCall: `The room surfaced enough signal to act. ${advisorTurns
        .map((t) => `${t.speaker}: ${t.content}`)
        .join(" ")
        .slice(0, 800)}`,
      notDoing:
        "We are not adding integrations, inventing proof, or turning this into vague homework.",
      nextPhysicalAction:
        "Open a blank doc and draft the artifact named by the strongest advisor input.",
      artifactToCreate: "Boardroom Decision Follow-Up Artifact",
      checkpoint:
        "The move worked if it creates a real artifact, reply, constraint, or useful no.",
    },
    message: "",
    actionCards: [
      {
        title: "Create the Boardroom follow-up artifact",
        advisor: "Tony" as AdvisorName,
        workType: "execution",
        context: `Follow-up from: ${userPrompt.slice(0, 220)}`,
        desiredOutput: "A concrete artifact that proves the decision moved.",
      },
    ] as GeneratedCard[],
  };
}

function formatClose(close: { decision: string; decisionBrief: Record<string, string> }): string {
  return [
    "**DECISION**",
    close.decision,
    "",
    "**WHY THIS IS THE CALL**",
    close.decisionBrief.whyThisCall,
    "",
    "**WHAT WE ARE NOT DOING**",
    close.decisionBrief.notDoing,
    "",
    "**NEXT PHYSICAL ACTION**",
    close.decisionBrief.nextPhysicalAction,
    "",
    "**ARTIFACT TO CREATE**",
    close.decisionBrief.artifactToCreate,
    "",
    "**CHECKPOINT**",
    close.decisionBrief.checkpoint,
  ].join("\n");
}

function normalizeCards(
  cards: GeneratedCard[],
  mode: ModeContext,
  decision: string
): GeneratedCard[] {
  return cards
    .filter((card): card is GeneratedCard => Boolean(card?.title))
    .map((card) => ({
      type: card.type ?? "local_doc",
      workType: card.workType ?? "manual",
      title: card.title.slice(0, 160),
      advisor: canonicalAdvisor(card.advisor),
      priority: Number(card.priority ?? 3),
      status: card.status ?? "suggested",
      context: card.context ?? "",
      desiredOutput: card.desiredOutput ?? "Create the requested artifact or working draft.",
      label: card.label ?? "",
      sourceDecision: card.sourceDecision ?? decision,
      inputs: card.inputs ?? {},
      externalTarget: card.externalTarget ?? "",
    }))
    .slice(0, mode.cardLimit);
}

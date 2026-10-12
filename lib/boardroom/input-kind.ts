// AI Boardroom input classification (WO-20261011-evening, WBR-373, Developer 51 to 57).
//
// Real members do not type clean questions. Before this, every message went
// straight to Tony's routing call and whatever the model felt like doing was
// what the room did: a one-word "hmm" could start a full advisor round, and a
// vague "how do I grow?" could get four advisors arguing about a business the
// room knew nothing about. classifyMemberInput() reads the message first, with
// no model call, so runTonyIntake can decide the room's routing itself:
//
//   filler / unusual (URL, emoji)  -> a short prompt back, no model call
//   vague / broad                  -> exactly one clarifying question
//   conflicting                    -> the conflict is named, out loud
//   hard_to_measure / distinction  -> Tony is told what to pin down
//   other_language                 -> normal path, answered in their language
//
// It is a deliberately plain heuristic. The cases in
// __tests__/engine-cases.json are the contract: add a case before changing a rule.

export type InputKind =
  | "filler"
  | "unusual"
  | "vague"
  | "broad"
  | "conflicting"
  | "hard_to_measure"
  | "concept_distinction"
  | "clear";

export type InputClassification = {
  kind: InputKind;
  // For "unusual": what made it unusual.
  variant?: "url_only" | "emoji_only" | "other_language";
  // For "conflicting": the two things that pull against each other.
  conflict?: { a: string; b: string };
  // For "concept_distinction": which distinction the member is blurring.
  distinction?: "goal_vs_hope" | "decision_vs_preference";
};

const FILLER = new Set([
  "ok", "okay", "k", "kk", "hmm", "hm", "hmmm", "um", "uh", "idk", "lol", "test", "testing", "asdf", "hi", "hello", "hey",
  "yo", "sup", "?", "??", "???", "...", ".", "yes", "no", "yep", "nope", "sure", "thanks", "thank you", "cool", "nice", "whatever",
]);

const URL_ONLY = /^\s*<?(https?:\/\/|www\.)\S+>?\s*$/i;
const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]+$/u;

// Common function words from languages members are likely to write in.
const FOREIGN_WORDS = new Set([
  "el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "por", "para", "como", "cómo", "mis", "mi", "este", "esta", "puedo", "quiero", "negocio",
  "le", "les", "des", "et", "est", "je", "mon", "ma", "pour", "avec", "comment", "pas", "une", "dans",
  "o", "os", "um", "uma", "meu", "minha", "não", "é", "eu", "com",
  "der", "die", "das", "und", "ich", "nicht", "mein", "wie", "ist",
]);
const ENGLISH_WORDS = new Set(["the", "and", "i", "my", "to", "is", "how", "what", "do", "a", "of", "for", "with", "should", "want", "can"]);

// Pairs of goals that pull against each other. Either side may come first.
type ConflictRule = { a: RegExp; b: RegExp; labelA: string; labelB: string };
const CONFLICTS: ConflictRule[] = [
  {
    a: /\b(work(ing)? less|fewer hours|less time|more (free )?time|part[- ]time|take (the summer|time) off|step back)\b/,
    b: /\b(double|triple|10x|2x|3x|scale|grow|more (revenue|clients|customers|money|income|sales))\b/,
    labelA: "working less", labelB: "growing a lot",
  },
  {
    a: /\b(quit|leave)\s+my\s+(job|day job)\b/,
    b: /\b(keep|without losing|not lose|hold on to)\s+(my\s+)?(salary|income|paycheck|pay|security)\b/,
    labelA: "leaving the job", labelB: "keeping its income",
  },
  {
    a: /\b(premium|luxury|high[- ]ticket|raise (my )?prices?|charge more)\b/,
    b: /\b(cheap|cheaper|affordable|budget|lower (my )?prices?|discount|everyone can afford)\b/,
    labelA: "a premium price", labelB: "a low price",
  },
  {
    a: /\b(more (clients|customers|sales|leads|buyers))\b/,
    b: /\b(without|no|never|hate|don'?t want to (do|be)|not do)\s+(any\s+)?(sales|selling|marketing|social media|posting|calls|outreach|showing my face)\b/,
    labelA: "more clients", labelB: "no selling or marketing",
  },
  {
    a: /\b(launch|ship|go live)\b[^.?!]*\b(this week|tomorrow|today|asap|right now|immediately)\b/,
    b: /\b(perfect|polished|flawless|every detail)\b/,
    labelA: "launching now", labelB: "launching perfect",
  },
];

const BROAD = /\b(everything|all of it|my (whole|entire) (business|life|company|brand)|fix my life|from scratch|every (part|area|piece)|the whole thing|all aspects|where do i even start)\b/;
const VAGUE_MARKERS = /\b(grow|growth|better|succeed|success|help|stuck|something|stuff|things|improve|figure it out|what (should|do) i do|next level|make money|more money)\b/;
const HARD_TO_MEASURE = /\b(feel (more )?(successful|confident|fulfilled|aligned|free|seen|legit)|be (more )?(known|respected|impactful|visible|recognized)|make an impact|brand awareness|more visibility|more presence|be taken seriously|feel like (a )?(real|legit))\b/;
const GOAL_VS_HOPE = /\b(i hope|hopefully|i wish|someday|one day|it would be nice|fingers crossed)\b/;
const DECISION_VS_PREFERENCE = /\b(i (prefer|like|love|enjoy) (doing|to|making|working)|i'?d rather|i kind of want|leaning toward|i feel like doing)\b/;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
}

export function classifyMemberInput(raw: string): InputClassification {
  const text = String(raw ?? "").replace(/[’‘]/g, "'").trim();
  const lower = text.toLowerCase();
  const bare = lower.replace(/[!.,]+$/g, "").trim();

  if (!bare || FILLER.has(bare) || /^[\p{P}\s]+$/u.test(text) || /^(.)\1{3,}$/.test(bare)) return { kind: "filler" };
  if (URL_ONLY.test(text)) return { kind: "unusual", variant: "url_only" };
  if (EMOJI_ONLY.test(text)) return { kind: "unusual", variant: "emoji_only" };

  const ws = words(text);
  const foreign = ws.filter(w => FOREIGN_WORDS.has(w)).length;
  const english = ws.filter(w => ENGLISH_WORDS.has(w)).length;
  if (ws.length >= 3 && foreign >= 2 && english === 0) return { kind: "unusual", variant: "other_language" };

  for (const rule of CONFLICTS) {
    if (rule.a.test(lower) && rule.b.test(lower)) return { kind: "conflicting", conflict: { a: rule.labelA, b: rule.labelB } };
  }

  if (BROAD.test(lower)) return { kind: "broad" };
  // Too short and too generic to route: no number, no named thing, a vague verb.
  if (ws.length <= 9 && !/\d/.test(text) && VAGUE_MARKERS.test(lower)) return { kind: "vague" };
  if (HARD_TO_MEASURE.test(lower) && !/\d/.test(text)) return { kind: "hard_to_measure" };
  if (GOAL_VS_HOPE.test(lower)) return { kind: "concept_distinction", distinction: "goal_vs_hope" };
  if (DECISION_VS_PREFERENCE.test(lower)) return { kind: "concept_distinction", distinction: "decision_vs_preference" };
  return { kind: "clear" };
}

// The short reply for input the room cannot work with yet. No advisor round,
// no model call, no em dashes.
export function shortPromptFor(c: InputClassification, ceoName = "CEO"): string {
  const who = ceoName && ceoName.trim() && ceoName.trim() !== "CEO" ? `${ceoName.trim()}, ` : "";
  if (c.variant === "url_only") {
    return `${who}I see the link. What do you want the room to do with it? Tell me in a sentence what this page is and what decision it should help you make.`;
  }
  if (c.variant === "emoji_only") {
    return `${who}I felt that. Put it in words for me: what is on your mind right now that you want the room to work on?`;
  }
  return `${who}I'm here. What do you want the room to work on? One sentence is plenty: the goal, the problem, or the decision in front of you.`;
}

// The single clarifying question Tony falls back on when the model's own reply
// does not contain one.
export function fallbackClarifyFor(c: InputClassification, ceoName = "CEO"): string {
  const who = ceoName && ceoName.trim() && ceoName.trim() !== "CEO" ? `${ceoName.trim()}, ` : "";
  if (c.kind === "broad") return `${who}that is the whole mountain, and the room can only climb one face at a time. If only one thing changed in the next 30 days, which one would matter most?`;
  if (c.kind === "conflicting" && c.conflict) return `${who}you want ${c.conflict.a} and ${c.conflict.b}, and those pull against each other. If you could only have one this quarter, which wins?`;
  return `${who}before I bring anyone in: what result do you want, by when, and how will you know you got it?`;
}

// Extra instruction added to Tony's intake prompt for each kind.
export function intakeGuidanceFor(c: InputClassification): string {
  switch (c.kind) {
    case "vague":
    case "broad":
      return "INPUT CHECK: this message is too vague or too broad to route. Do NOT call the team. Ask exactly ONE clarifying question, with one question mark, and nothing else that ends in a question mark.";
    case "conflicting":
      return `INPUT CHECK: this message contains a conflict between ${c.conflict?.a} and ${c.conflict?.b}. Name that conflict plainly in your first two sentences before anything else. Do not quietly pick a side.`;
    case "hard_to_measure":
      return "INPUT CHECK: the goal here is hard to measure. Before routing, pin it to one observable signal (a number, a date, or a thing the member could point to). If you route, put that measurable signal in every advisor question.";
    case "concept_distinction":
      return c.distinction === "decision_vs_preference"
        ? "INPUT CHECK: the member stated a preference, not a decision. Say which it is and ask whether they want to decide it now."
        : "INPUT CHECK: the member stated a hope, not a goal. Say so kindly and turn it into a goal with a number and a date, or ask what it would take to commit to one.";
    case "unusual":
      return c.variant === "other_language"
        ? "INPUT CHECK: the member wrote in a language other than English. Reply in their language."
        : "";
    default:
      return "";
  }
}

// Keeps a clarify reply to exactly one question: everything up to and including
// the first question mark. Returns "" when there is no question to keep.
export function oneQuestion(text: string): string {
  const clean = String(text ?? "").replace(/```[\s\S]*?```/g, "").replace(/\{[\s\S]*\}/g, "").trim();
  const idx = clean.indexOf("?");
  if (idx < 0) return "";
  return clean.slice(0, idx + 1).trim();
}

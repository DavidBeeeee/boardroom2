// AI Boardroom safety boundary (WO-20261007-evening, WBR-373 Stream B).
//
// Before this, a member could write something frightening and the room would
// carry on debating offers and funnels around it. Every member message now
// passes through detectCrisis() before any advisor round runs. When it trips,
// the chat route skips the advisors entirely, answers once in plain language
// that points to real help, and logs a "safety" event to boardroom_logs (the
// category and pattern id only, never the member's words).
//
// This is a deliberately simple, conservative pattern check, not a classifier.
// It is tuned to catch clear first-person crisis and self-harm language and to
// leave ordinary business frustration ("this launch is killing me", "I'm dead
// in the water") alone. The evaluation cases in __tests__/safety-cases.json
// are the contract: add a case before changing a pattern.

export type CrisisCategory = "suicide" | "self_harm" | "harm_intent";

export type CrisisCheck =
  | { tripped: false }
  | { tripped: true; category: CrisisCategory; patternId: string };

type Pattern = { id: string; category: CrisisCategory; re: RegExp };

const PATTERNS: Pattern[] = [
  { id: "kill_myself", category: "suicide", re: /\b(kill|killing|off)\s+(my\s*self|myself)\b/ },
  { id: "suicide_word", category: "suicide", re: /\b(suicid(e|al)|end it all|take my (own )?life|end my (own )?life|ending my life)\b/ },
  { id: "want_to_die", category: "suicide", re: /\b(i\s+)?(want|wanna|wish(ed)?|going|plan(ning)?)\s+(to\s+)?(die|be dead)\b/ },
  { id: "not_be_here", category: "suicide", re: /\b(don'?t|do not)\s+want\s+to\s+(be here|be alive|live|wake up)( anymore| any more)?\b/ },
  { id: "better_off", category: "suicide", re: /\b(better off (dead|without me)|no (reason|point) (to|in) (live|living|being alive|going on))\b/ },
  { id: "cant_go_on", category: "suicide", re: /\b(can'?t|cannot)\s+(go on|keep going|do this)\s+(anymore|any more)\b.*\b(life|living|alive|die|myself)\b/ },
  { id: "self_harm", category: "self_harm", re: /\b(self[-\s]?harm(ing)?|hurt(ing)? myself|cut(ting)? myself|harm(ing)? myself|overdos(e|ing))\b/ },
  { id: "harm_others", category: "harm_intent", re: /\b(going to|gonna|want to|plan(ning)? to)\s+(kill|hurt|shoot|stab)\s+(him|her|them|someone|somebody|my (wife|husband|partner|kids?|family|boss))\b/ },
];

// Idioms that read like crisis language but are ordinary frustration. They
// are stripped before matching so "this is killing me" never trips.
const IDIOMS: RegExp[] = [
  /\bkilling it\b/g,
  /\b(this|it|that|work|the launch|the business)\s+is\s+killing\s+me\b/g,
  /\bdying to\b/g,
  /\bdead in the water\b/g,
  /\bkill (the|this|that) (offer|idea|launch|project|plan|funnel)\b/g,
  /\bcould kill for\b/g,
];

export function detectCrisis(text: string): CrisisCheck {
  let clean = String(text || "").toLowerCase().replace(/[’‘]/g, "'");
  for (const idiom of IDIOMS) clean = clean.replace(idiom, " ");
  for (const pattern of PATTERNS) {
    if (pattern.re.test(clean)) return { tripped: true, category: pattern.category, patternId: pattern.id };
  }
  return { tripped: false };
}

// The one reply a member gets when the check trips. Plain, human, no advisor
// voices, no persuasion, no em dashes.
export function crisisResponse(name?: string): string {
  const who = name && name.trim() && name.trim() !== "CEO" ? `${name.trim()}, ` : "";
  return [
    `${who}I'm going to stop the Boardroom here, because what you just wrote matters more than any plan we could make tonight.`,
    "",
    "If you are thinking about ending your life or hurting yourself, please talk to a real person right now. You don't have to have the right words.",
    "",
    "- **US and Canada:** call or text **988** (Suicide and Crisis Lifeline)",
    "- **UK and Ireland:** call **116 123** (Samaritans)",
    "- **Australia:** call **13 11 14** (Lifeline)",
    "- **Anywhere else:** findahelpline.com lists free, confidential lines in your country",
    "- **If you are in immediate danger:** call your local emergency number",
    "",
    "The advisors here are AI. They can help with a business, but they can't be there for you the way a person can. Please reach out to someone you trust, too.",
    "",
    "When you're ready, the Boardroom will still be here, and so will everything you've built in it.",
  ].join("\n");
}

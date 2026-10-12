// AI Boardroom invented-progress guard (WO-20261011-evening, WBR-373, Developer 45).
//
// An advisor could write "You already launched the waitlist and signed 12
// clients" onto a work card or into workspace memory when the member never said
// either thing, and the next session would treat it as history. Before any card
// or memory write records a completed step, outcome or number, guardClaims()
// checks it against what the member actually said in this conversation. When
// nothing supports it, the sentence is kept but rewritten as a proposal, and the
// caller logs an "unsupported_claim" row with counts only, never member text.
//
// Plain heuristic, conservative on purpose: a claim needs a completion verb
// about the member or the team, in the past tense, and not inside a plan
// ("will", "next", "once you"). Support means the member used the same verb
// stem and at least one of the same content words, and every number in the
// claim appears in something the member wrote.

export const PROPOSAL_PREFIX = "Proposal, not yet confirmed by you: ";

const COMPLETION = /\b(you|you've|you have|you've already|we|we've|we have|ceo|already)\b[^.!?\n]*?\b(finished|completed|launched|shipped|closed|signed|sent|built|published|booked|sold|hit|reached|landed|recorded|grew|doubled|tripled|wrote|created|hired)\b/i;
// "You made the right call" is not progress; "you made $4k" is.
const MONEY_CLAIM = /\b(you|you've|you have|we|we've|we have|already)\b[^.!?\n]*?\b(made|earned|generated|brought in)\b[^.!?\n]*\d/i;
const DONE_LABEL = /^\s*(completed|done|finished|achieved)\s*[:\-]/i;
const PLAN_MARKERS = /\b(will|should|need to|needs to|next|plan to|going to|once you|after you|when you|if you|until you|before you|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|the end|day)|goal|target|aim)\b/i;

const STEMS: Array<[RegExp, string[]]> = [
  [/\bfinished\b/i, ["finish", "done", "complet"]],
  [/\bcompleted\b/i, ["complet", "finish", "done"]],
  [/\blaunched\b/i, ["launch", "live"]],
  [/\bshipped\b/i, ["ship", "launch", "live"]],
  [/\bclosed\b/i, ["clos", "signed", "sold"]],
  [/\bsigned\b/i, ["sign", "clos"]],
  [/\bsent\b/i, ["sent", "send", "emailed", "messaged"]],
  [/\bbuilt\b/i, ["built", "build", "made", "created"]],
  [/\bpublished\b/i, ["publish", "posted", "live"]],
  [/\bbooked\b/i, ["book", "scheduled"]],
  [/\bsold\b/i, ["sold", "sell", "sale"]],
  [/\b(hit|reached|landed)\b/i, ["hit", "reach", "land", "got"]],
  [/\brecorded\b/i, ["record", "filmed"]],
  [/\b(made|earned|generated)\b/i, ["made", "earn", "generat", "brought in", "revenue"]],
  [/\b(grew|doubled|tripled)\b/i, ["grew", "grow", "doubl", "tripl"]],
  [/\bwrote\b/i, ["wrote", "write", "written", "drafted"]],
  [/\bcreated\b/i, ["creat", "made", "built"]],
  [/\bhired\b/i, ["hire", "hiring", "brought on"]],
];

const STOP = new Set([
  "already", "have", "with", "that", "this", "your", "their", "there", "from", "into", "about", "which", "what", "when", "been", "were",
  "they", "them", "then", "than", "just", "also", "first", "last", "week", "today", "yesterday", "month", "really", "very", "some",
  "finished", "completed", "launched", "shipped", "closed", "signed", "sent", "built", "published", "booked", "sold", "reached",
  "landed", "recorded", "earned", "generated", "doubled", "tripled", "wrote", "created", "hired", "made", "grew",
]);

function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*(?:\s?k\b)?/gi) ?? []).map(n => n.replace(/[,\s]/g, "").replace(/\.$/, "").toLowerCase());
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter(w => !STOP.has(w));
}

export type ClaimCheck = { claim: boolean; supported: boolean };

export function checkSentence(sentence: string, evidence: string): ClaimCheck {
  const s = sentence.trim();
  if (!s || s.startsWith(PROPOSAL_PREFIX)) return { claim: false, supported: true };
  const isClaim = (COMPLETION.test(s) || MONEY_CLAIM.test(s) || DONE_LABEL.test(s)) && !PLAN_MARKERS.test(s);
  if (!isClaim) return { claim: false, supported: true };

  const ev = evidence.toLowerCase();
  const evNumbers = new Set(numbersIn(ev));
  const numbersOk = numbersIn(s).every(n => evNumbers.has(n));

  const stems = STEMS.filter(([re]) => re.test(s)).flatMap(([, list]) => list);
  // A bare "Completed:" label needs the member to have said they finished something.
  const verbOk = (stems.length ? stems : ["done", "finish", "complet", "wrote", "drafted", "built", "made"]).some(stem => ev.includes(stem));

  const words = contentWords(s.replace(DONE_LABEL, ""));
  const wordOk = words.length === 0 || words.some(w => ev.includes(w.replace(/s$/, "")));

  return { claim: true, supported: numbersOk && verbOk && wordOk };
}

export type GuardResult = { text: string; claims: number; unsupported: number };

// Rewrites each unsupported claim sentence in `text` as a proposal. `evidence`
// is everything the member wrote in this conversation.
export function guardClaims(text: string, evidence: string | string[]): GuardResult {
  const ev = Array.isArray(evidence) ? evidence.join("\n") : evidence;
  let claims = 0;
  let unsupported = 0;
  const out = String(text ?? "").split(/(\n+)/).map(line => {
    if (/^\n+$/.test(line)) return line;
    return line.split(/(?<=[.!?])\s+/).map(sentence => {
      const check = checkSentence(sentence, ev);
      if (!check.claim) return sentence;
      claims += 1;
      if (check.supported) return sentence;
      unsupported += 1;
      const lead = sentence.match(/^(\s*[-*•]\s*|\s*\d+[.)]\s*)/)?.[0] ?? "";
      return `${lead}${PROPOSAL_PREFIX}${sentence.slice(lead.length)}`;
    }).join(" ");
  }).join("");
  return { text: out, claims, unsupported };
}

// The member's own words in a conversation: every user message plus the
// prompt being answered now.
export function memberEvidence(history: Array<{ role: string; content: string }>, ...extra: Array<string | undefined>): string[] {
  return [...history.filter(m => m.role === "user").map(m => m.content), ...extra.filter((x): x is string => Boolean(x))];
}

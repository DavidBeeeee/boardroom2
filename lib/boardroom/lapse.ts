// Lapse awareness and room isolation (WO-20261007-evening, WBR-373 Streams C and D).

// Certainty's documented rule, reused here: 21 days without a conversation is a
// lapse; anything shorter is a quiet week and gets no special treatment.
export const LAPSE_DAYS = 21;

export type LastConversation = {
  conversationId: string;
  channel: string;
  snippet: string;
  at: string;
};

export type LapseState =
  | { lapsed: false }
  | { lapsed: true; days: number; last: LastConversation };

export function lapseState(last: LastConversation | null, now = new Date()): LapseState {
  if (!last) return { lapsed: false };
  const at = new Date(last.at).getTime();
  if (!Number.isFinite(at)) return { lapsed: false };
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  return days >= LAPSE_DAYS ? { lapsed: true, days, last } : { lapsed: false };
}

function snippetOf(text: string, max = 90) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function toLastConversation(row: { conversation_id: string; content: string; created_at: string } | null, channel = "brainstorming"): LastConversation | null {
  if (!row) return null;
  return { conversationId: row.conversation_id, channel, snippet: snippetOf(row.content), at: row.created_at };
}

// The warm return line. Names what they last brought to the room. No em dashes.
export function returnLine(state: LapseState, name?: string): string | null {
  if (!state.lapsed) return null;
  const who = name && name.trim() && name.trim() !== "CEO" ? `, ${name.trim()}` : "";
  const weeks = Math.floor(state.days / 7);
  const gap = weeks >= 2 ? `${weeks} weeks` : `${state.days} days`;
  const room = state.last.channel === "brainstorming" ? "the Boardroom" : `your 1:1 with ${state.last.channel}`;
  return `Welcome back${who}. It's been ${gap} since your last conversation in ${room}, where you brought "${state.last.snippet}". Pick that thread back up, or start with whatever is on your mind today.`;
}

// ── Room isolation ───────────────────────────────────────────────────────────
//
// Memory entries carry metadata.channel (from today; older entries do not).
// A 1:1 room sees only its own memory; the main Boardroom never sees a 1:1
// room's memory. Untagged legacy entries are treated as main-room memory,
// which is where nearly all of them were written.
export function memoryForChannel<T extends { metadata?: Record<string, unknown> | null }>(entries: T[], channel: string): T[] {
  return entries.filter(entry => {
    const tagged = typeof entry.metadata?.channel === "string" ? String(entry.metadata.channel) : "brainstorming";
    return tagged === channel;
  });
}

// A conversation id from the client is only reused when it belongs to the
// channel being written to. Otherwise the turn starts a fresh conversation, so a
// stale or mismatched id can never land a 1:1 message in the main room.
export function conversationMatchesChannel(conversation: { channel?: string | null } | null, channel: string): boolean {
  return Boolean(conversation) && (conversation?.channel || "brainstorming") === channel;
}

import type { BoardroomTurn, Message } from "@/lib/types";

// Completion belongs to the saved closing turn, not to a stage request or a
// conversation that merely started the debate.
export function decisionMetadataForTurn(turn: Pick<BoardroomTurn, "stage" | "content">) {
  return turn.stage === "tony_close" && turn.content.trim()
    ? { decision_reached: true }
    : {};
}

export function isDecisionReachedMessage(message: Pick<Message, "stage" | "metadata">) {
  return message.stage === "tony_close" && message.metadata?.decision_reached === true;
}

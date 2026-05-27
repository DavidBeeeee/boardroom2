import type { DocumentRecord, Message } from "@/lib/types";
import { BOARDROOM_GUARDRAILS } from "./advisors";

type ContextInput = {
  guardrails?: string;
  documents: Pick<DocumentRecord, "name" | "extracted_text">[];
  memory: { kind: string; content: string }[];
  recentMessages: Pick<Message, "speaker" | "content" | "role">[];
  activeCard?: { title: string; advisor: string; context: string; desired_output: string } | null;
};

export function buildBoardroomContext(input: ContextInput) {
  const parts = [
    input.guardrails?.trim() || BOARDROOM_GUARDRAILS,
    "Source hierarchy: workspace guardrails and master business documents outrank project files, memory, and chat assumptions."
  ];

  if (input.memory.length) {
    parts.push(`BOARDROOM MEMORY:\n${input.memory.slice(0, 8).map((m) => `- ${m.kind}: ${m.content.slice(0, 900)}`).join("\n")}`);
  }

  if (input.documents.length) {
    parts.push(`WORKSPACE DOCUMENTS:\n${input.documents.slice(0, 6).map((doc) => `[${doc.name}]\n${doc.extracted_text.slice(0, 4500)}`).join("\n\n")}`);
  }

  if (input.activeCard) {
    parts.push(`ACTIVE ADVISOR WORK CARD:\nTitle: ${input.activeCard.title}\nAdvisor: ${input.activeCard.advisor}\nContext: ${input.activeCard.context}\nDesired output: ${input.activeCard.desired_output}`);
  }

  if (input.recentMessages.length) {
    parts.push(`RECENT THREAD:\n${input.recentMessages.slice(-10).map((m) => `${m.speaker}: ${m.content.slice(0, 1200)}`).join("\n\n")}`);
  }

  return parts.join("\n\n---\n\n");
}

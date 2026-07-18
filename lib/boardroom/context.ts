import type { BoardroomProfile, DocumentRecord, Message } from "@/lib/types";
import { BOARDROOM_GUARDRAILS } from "./advisors";

type ContextInput = {
  guardrails?: string;
  profile?: BoardroomProfile | null;
  documents: Pick<DocumentRecord, "name" | "extracted_text">[];
  memory: { kind: string; content: string; metadata?: Record<string, unknown> }[];
  recentMessages: Pick<Message, "speaker" | "content" | "role">[];
  activeCard?: { title: string; advisor: string; context: string; desired_output: string } | null;
};

export function buildBoardroomContext(input: ContextInput) {
  const parts = [
    input.guardrails?.trim() || BOARDROOM_GUARDRAILS,
    "Source hierarchy: workspace guardrails and master business documents outrank project files, memory, and chat assumptions."
  ];

  if (input.profile) {
    const profile = input.profile;
    const profileLines = [
      `Preferred name: ${profile.preferred_name}`,
      profile.role_title && `Role: ${profile.role_title}`,
      profile.business_name && `Business: ${profile.business_name}`,
      profile.business_description && `Business context: ${profile.business_description}`,
      profile.ideal_customer && `Ideal customer: ${profile.ideal_customer}`,
      profile.offers && `Offers: ${profile.offers}`,
      profile.current_goals && `Current goals: ${profile.current_goals}`,
      profile.constraints && `Constraints: ${profile.constraints}`,
      profile.additional_context && `Additional context: ${profile.additional_context}`,
    ].filter(Boolean);

    parts.push(
      `CURRENT CEO PROFILE (verified and specific to this workspace):\n${profileLines.join("\n")}\n\n` +
      `Address the CEO as ${profile.preferred_name || "CEO"}. Apply every advisor instruction and example to this CEO, their business, and their circumstances. Never assume this CEO is David or reuse another workspace's identity.`
    );
  }

  // Documents are verified workspace context.
  if (input.documents.length) {
    parts.push(
      `WORKSPACE DOCUMENTS (treat as verified business context):\n` +
      input.documents.slice(0, 6).map((doc) =>
        `[${doc.name}]\n${doc.extracted_text.slice(0, 20000)}`
      ).join("\n\n")
    );
  }

  // Active card is highest priority context in a 1:1.
  if (input.activeCard) {
    parts.push(
      `ACTIVE ADVISOR WORK CARD:\n` +
      `Title: ${input.activeCard.title}\n` +
      `Advisor: ${input.activeCard.advisor}\n` +
      `Context: ${input.activeCard.context}\n` +
      `Desired output: ${input.activeCard.desired_output}`
    );
  }

  // Session summaries — what's been decided before
  const sessionSummaries = input.memory
    .filter(m => m.kind === "session_summary")
    .slice(0, 5);

  if (sessionSummaries.length) {
    parts.push(
      `RECENT BOARDROOM DECISIONS:\n` +
      sessionSummaries.map((m, i) => `[Session ${sessionSummaries.length - i}]\n${m.content.slice(0, 600)}`).join("\n\n")
    );
  }

  // Other memory — patterns, corrections, morning briefs
  const otherMemory = input.memory
    .filter(m => m.kind !== "session_summary")
    .slice(0, 4);

  if (otherMemory.length) {
    parts.push(
      `BOARDROOM MEMORY:\n` +
      otherMemory.map(m => `[${m.kind}] ${m.content.slice(0, 500)}`).join("\n\n")
    );
  }

  // Recent conversation thread
  if (input.recentMessages.length) {
    parts.push(
      `RECENT THREAD:\n` +
      input.recentMessages.slice(-10).map((m) =>
        `${m.speaker}: ${m.content.slice(0, 1200)}`
      ).join("\n\n")
    );
  }

  return parts.join("\n\n---\n\n");
}

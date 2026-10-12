// AI Boardroom degraded mode (WBR-373 continuation, Developer 81, 82, 83).
//
// Before this, when DeepSeek or Supabase failed the member saw the raw error
// ("DeepSeek error 503: ...", a Postgres message) and had to retype their
// message to try again. Now the server keeps the member's message, says in one
// plain sentence which part failed, and the client offers Retry, which reuses
// the saved message instead of writing a second copy. The raw error still goes
// to boardroom_logs and the server console, never to the member.

export type FailedService = "ai" | "database" | "unknown";

export type FailureNotice = {
  service: FailedService;
  message: string;
  retryable: true;
};

const AI = /deepseek|api key|chat\/completions|empty response|could not be parsed/i;
const DATABASE = /supabase|postgres|postgrest|relation |violates|jwt|pgrst|connection|timeout|timed out|fetch failed|econn|network|socket/i;

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error ?? "");
}

export function classifyFailure(error: unknown): FailedService {
  const text = errorText(error);
  if (AI.test(text)) return "ai";
  if (DATABASE.test(text)) return "database";
  return "unknown";
}

// `messageSaved` says whether the member's message reached the database, so
// the copy never promises something that did not happen. No em dashes.
export function failureNotice(error: unknown, messageSaved: boolean, known?: FailedService): FailureNotice {
  const service = known ?? classifyFailure(error);
  const kept = messageSaved
    ? "Your message is saved."
    : "Your message was not sent, so it is back in the box below. Nothing is lost.";
  const what = service === "ai"
    ? "The advisors could not answer just now because the AI service they run on did not respond."
    : service === "database"
      ? "The Boardroom could not reach its database just now, so it could not save or load this conversation."
      : "Something went wrong on our side before the advisors could answer.";
  return { service, message: `${what} ${kept} Press Retry to try again.`, retryable: true };
}

// The same, for a debate stage that failed partway through a session. The
// member's message and every earlier turn are already saved.
export function stageFailureNotice(error: unknown, known?: FailedService): FailureNotice {
  const service = known ?? classifyFailure(error);
  const what = service === "ai"
    ? "The next advisor could not answer because the AI service did not respond."
    : service === "database"
      ? "The next advisor's turn could not be saved because the database did not respond."
      : "The next advisor's turn failed on our side.";
  return { service, message: `${what} Everything said so far is saved. Press Retry to continue from here.`, retryable: true };
}

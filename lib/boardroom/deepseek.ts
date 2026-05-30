export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Remove or replace characters that break JSON serialization for DeepSeek:
// lone surrogates, null bytes, and invalid Unicode escape sequences.
function sanitizeContent(text: string): string {
  return text
    .replace(/\0/g, "")                          // null bytes
    .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u") // lone \u not followed by 4 hex digits
    .replace(/[\uD800-\uDFFF]/g, "");            // lone surrogate code points
}

export async function callDeepSeek(messages: ChatMessage[], clientApiKey?: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY || clientApiKey;
  if (!apiKey) throw new Error("Missing DeepSeek API key. Add DEEPSEEK_API_KEY on the server or enter a client key for this session.");

  const safeMessages = messages.map(m => ({ ...m, content: sanitizeContent(m.content) }));

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: safeMessages,
      temperature: 0.7
    })
  });

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try {
      detail = JSON.parse(raw).error?.message || raw;
    } catch {}
    throw new Error(`DeepSeek error ${res.status}: ${detail.slice(0, 260)}`);
  }

  const data = JSON.parse(raw);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned an empty response.");
  return String(content);
}

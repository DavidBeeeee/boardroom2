export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Observability hook. callDeepSeek reports the outcome of every call — the
// requested model, the model version the API actually served, latency, token
// usage, and whether it succeeded or failed — so a broken generation is
// diagnosable. The hook is best-effort and must not throw.
export type DeepSeekCallResult = {
  status: "success" | "generation_failure";
  requestedModel: string;
  model: string;
  latencyMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
};

export type DeepSeekHook = {
  stage?: string;
  speaker?: string;
  record?: (result: DeepSeekCallResult) => void;
};

function report(hook: DeepSeekHook | undefined, result: DeepSeekCallResult) {
  if (!hook?.record) return;
  try {
    hook.record(result);
  } catch {
    // Never let logging break the call path.
  }
}

// Remove or replace characters that break JSON serialization for DeepSeek:
// lone surrogates, null bytes, and invalid Unicode escape sequences.
function sanitizeContent(text: string): string {
  return text
    .replace(/\0/g, "")                          // null bytes
    .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u") // lone \u not followed by 4 hex digits
    .replace(/[\uD800-\uDFFF]/g, "");            // lone surrogate code points
}

export async function callDeepSeek(messages: ChatMessage[], clientApiKey?: string, hook?: DeepSeekHook) {
  const apiKey = process.env.DEEPSEEK_API_KEY || clientApiKey;
  if (!apiKey) throw new Error("Missing DeepSeek API key. Add DEEPSEEK_API_KEY on the server or enter a client key for this session.");

  const requestedModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const safeMessages = messages.map(m => ({ ...m, content: sanitizeContent(m.content) }));
  const startedAt = Date.now();

  const fail = (message: string, model = requestedModel): never => {
    report(hook, {
      status: "generation_failure",
      requestedModel,
      model,
      latencyMs: Date.now() - startedAt,
      error: message.slice(0, 400),
    });
    throw new Error(message);
  };

  let res: Response;
  try {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: requestedModel,
        messages: safeMessages,
        temperature: 0.7
      })
    });
  } catch (err) {
    return fail(`DeepSeek request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try {
      detail = JSON.parse(raw).error?.message || raw;
    } catch {}
    return fail(`DeepSeek error ${res.status}: ${detail.slice(0, 260)}`);
  }

  let data: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; choices?: Array<{ message?: { content?: string } }> };
  try {
    data = JSON.parse(raw);
  } catch {
    return fail("DeepSeek returned a response that could not be parsed as JSON.");
  }
  // The version the API actually served (e.g. deepseek-chat pointing at a dated
  // build) — recorded with every generation for reproducibility.
  const servedModel = typeof data?.model === "string" && data.model ? data.model : requestedModel;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return fail("DeepSeek returned an empty response.", servedModel);

  report(hook, {
    status: "success",
    requestedModel,
    model: servedModel,
    latencyMs: Date.now() - startedAt,
    usage: data?.usage,
  });
  return String(content);
}

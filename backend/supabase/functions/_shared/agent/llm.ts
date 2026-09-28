// =====================================================================
// Shared LLM call — one provider abstraction used by both ai-tutor
// (chat) and the orchestrator (agent reasoning). Previously this lived
// only inside ai-tutor/index.ts; pulling it out means the agent can
// use the same three providers/keys without duplicating the fetch
// plumbing, and without the tutor and the agent ever drifting apart.
// =====================================================================

export type Provider = "groq" | "gemini" | "anthropic";

const DEFAULT_MODEL: Record<Provider, string> = {
  groq: "llama-3.3-70b-versatile",
  gemini: "gemini-3.5-flash", // gemini-2.5-flash was retired by Google; override with AI_MODEL if you prefer another
  anthropic: "claude-sonnet-5",
};
const KEY_ENV: Record<Provider, string> = { groq: "GROQ_API_KEY", gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

export function pickProvider(): Provider | null {
  const forced = Deno.env.get("AI_PROVIDER") as Provider | undefined;
  if (forced && KEY_ENV[forced] && Deno.env.get(KEY_ENV[forced])) return forced;
  for (const p of ["groq", "gemini", "anthropic"] as Provider[]) if (Deno.env.get(KEY_ENV[p])) return p;
  return null;
}

export type Msg = { role: "user" | "assistant"; content: string };

/** One call, three providers. Returns the reply text or throws an Error with a readable message. */
export async function callLLM(
  provider: Provider,
  system: string,
  messages: Msg[],
  opts: { maxTokens?: number; temperature?: number; jsonMode?: boolean } = {},
): Promise<string> {
  const key = Deno.env.get(KEY_ENV[provider])!;
  const model = Deno.env.get("AI_MODEL") ?? DEFAULT_MODEL[provider];
  const maxTokens = opts.maxTokens ?? 600;
  const temperature = opts.temperature ?? 0.5;
  let res: Response;
  if (provider === "groq") { // OpenAI-compatible
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "system", content: system }, ...messages],
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } else if (provider === "gemini") {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature,
          ...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
        },
      }),
    });
  } else {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
  }
  // deno-lint-ignore no-explicit-any
  const out: any = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("The free AI quota is used up for the moment. Wait a minute and try again.");
  if (!res.ok) throw new Error(`AI service error (${res.status}): ${out?.error?.message ?? out?.error ?? "unknown"}`);
  if (provider === "groq") return String(out.choices?.[0]?.message?.content ?? "").trim();
  if (provider === "gemini") {
    // deno-lint-ignore no-explicit-any
    return (out.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
  }
  return (out.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
}

/** Strip ```json fences etc and parse. Returns null (never throws) on anything malformed. */
export function tryParseJSON<T>(text: string): T | null {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as T;
  } catch {
    return null;
  }
}

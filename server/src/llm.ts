export type LlmCall = (prompt: string) => Promise<string>;

export interface OpenAiLlmOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
}

export const DEFAULT_LLM_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT =
  "You generate game design data. Respond only with the exact output " +
  "requested by the user — no markdown fences, no commentary.";

export function createOpenAiLlm(options: OpenAiLlmOptions = {}): LlmCall {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY?.trim();
  const model = options.model ?? process.env.OPENAI_MODEL?.trim() ?? DEFAULT_LLM_MODEL;
  const baseUrl = (
    options.baseUrl ??
    process.env.OPENAI_BASE_URL?.trim() ??
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");

  return async (prompt: string): Promise<string> => {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = apiKey ? body.split(apiKey).join("[redacted]") : body;
      const suffix = detail.length > 0 ? `: ${detail.slice(0, 200)}` : "";
      throw new Error(`LLM request failed with status ${response.status}${suffix}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("LLM response was empty");
    }
    return content;
  };
}

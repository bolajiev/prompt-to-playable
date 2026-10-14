export type LlmCall = (prompt: string) => Promise<string>;

export interface OpenAiLlmOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  retryDelaysMs?: number[] | undefined;
  sessionId?: string | undefined;
}

export const DEFAULT_LLM_MODEL = "gpt-4o-mini";
export const DEFAULT_RETRY_DELAYS_MS = [300, 1200];

const MAX_ATTEMPTS = 3;

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599);
}

const SYSTEM_PROMPT =
  "You generate game design data. Respond only with the exact output " +
  "requested by the user — no markdown fences, no commentary.";

export function createOpenAiLlm(options: OpenAiLlmOptions = {}): LlmCall {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY?.trim();
  const model = options.model || process.env.OPENAI_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const baseUrl = (
    options.baseUrl ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const retryDelaysMs = [...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)];
  const sessionId = options.sessionId ?? process.env.OPENAI_SESSION_ID?.trim() ?? "";

  const redact = (value: string): string =>
    apiKey ? value.split(apiKey).join("[redacted]") : value;
  const delayFor = (attempt: number): number =>
    Math.max(0, retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0);
  const attemptLabel = (attempt: number): string =>
    `${attempt} attempt${attempt === 1 ? "" : "s"}`;

  return async (prompt: string): Promise<string> => {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...(sessionId.length > 0 ? { "X-Session-Id": sessionId } : {}),
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
      } catch (cause) {
        const detail = redact(cause instanceof Error ? cause.message : String(cause));
        const error = new Error(
          `LLM request failed after ${attemptLabel(attempt)} (network error): ${detail}`
        );
        if (isLastAttempt) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayFor(attempt)));
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = redact(body);
        const suffix = detail.length > 0 ? `: ${detail.slice(0, 200)}` : "";
        const error = new Error(
          `LLM request failed with status ${response.status} after ${attemptLabel(attempt)}${suffix}`
        );
        if (isLastAttempt || !isRetryableStatus(response.status)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayFor(attempt)));
        continue;
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("LLM response was empty");
      }
      return content;
    }
    throw new Error("LLM request failed: attempts exhausted");
  };
}

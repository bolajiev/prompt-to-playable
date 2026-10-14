export type ChatRole = "user" | "system" | "error";

export interface ChatOptions {
  /** Awaited on submit; the chat shows a busy state and surfaces rejections. */
  onSubmit(prompt: string): Promise<void>;
}

export interface FriendlyError {
  /** Short, human-readable headline shown first. */
  headline: string;
  /** Raw technical message, when it adds information worth keeping. */
  detail: string | null;
}

/** Raw errors longer than this stay collapsed behind a Details toggle. */
export const ERROR_DETAIL_LIMIT = 160;

const FRIENDLY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /could not reach the server|failed to fetch|networkerror|load failed/i,
    "Couldn't reach the server — check your connection and try again.",
  ],
  [/timed out|timeout/i, "The request timed out — try again."],
  [
    /invalid json|empty response/i,
    "The server sent an unexpected response — try again.",
  ],
  [/HTTP 5\d\d/i, "The server hit a problem — try again in a moment."],
];

export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

/**
 * Auto-retry policy for a generation or edit request: any non-cancel failure
 * gets exactly one automatic retry. `attemptIndex` is the zero-based index of
 * the attempt that just failed, so only `0` (the original request) qualifies.
 * A user cancel - an AbortError or an aborted caller signal - never retries.
 */
export function shouldAutoRetry(
  attemptIndex: number,
  error: unknown,
  wasCancelled: boolean
): boolean {
  if (wasCancelled || isAbortError(error)) return false;
  return attemptIndex === 0;
}

/**
 * Runs `task` and (per `shouldAutoRetry`) silently retries it once after a
 * non-cancel failure. `onRetry` fires before each automatic retry so callers
 * can surface a log line; `isCancelled` is re-checked after every failure so a
 * cancel that did not arrive as an AbortError still stops the retry.
 */
export async function runWithAutoRetry(
  task: () => Promise<void>,
  onRetry: () => void,
  isCancelled: () => boolean = () => false
): Promise<void> {
  let attemptIndex = 0;
  for (;;) {
    try {
      await task();
      return;
    } catch (error) {
      if (!shouldAutoRetry(attemptIndex, error, isCancelled())) throw error;
      attemptIndex += 1;
      onRetry();
    }
  }
}

/** Maps a thrown value onto a friendly headline plus optional raw detail. */
export function describeError(error: unknown): FriendlyError {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (raw.length === 0) {
    return { headline: "Something went wrong — try again.", detail: null };
  }

  for (const [pattern, headline] of FRIENDLY_PATTERNS) {
    if (pattern.test(raw)) return { headline, detail: raw };
  }
  if (raw.length > ERROR_DETAIL_LIMIT) {
    return { headline: `${raw.slice(0, ERROR_DETAIL_LIMIT)}…`, detail: raw };
  }
  return { headline: raw, detail: null };
}

/**
 * Chat input. Owns the form/input/log DOM and delegates the actual backend call
 * to `onSubmit`, keeping it free of any knowledge of engine or fetch details.
 * Failures render as a friendly headline with a Retry button; user cancellations
 * (AbortError) read as a plain system note.
 */
export class Chat {
  private busy = false;
  private lastPrompt = "";

  constructor(
    private readonly form: HTMLFormElement,
    private readonly input: HTMLInputElement,
    private readonly log: HTMLElement,
    private readonly options: ChatOptions
  ) {
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  get isBusy(): boolean {
    return this.busy;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.input.disabled = busy;
    const submit = this.form.querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    );
    if (submit) submit.disabled = busy;
    this.input.placeholder = busy ? "Generating…" : "Describe a game…";
  }

  /**
   * One-click path for example chips: fills the input and submits immediately.
   * Keyboard typing keeps using the form submit handler unchanged.
   */
  send(text: string): void {
    const prompt = text.trim();
    if (this.busy || prompt.length === 0) return;
    this.input.value = prompt;
    void this.submit();
  }

  appendMessage(role: ChatRole, text: string): void {
    if (role === "error") {
      this.appendError(text);
      return;
    }
    const doc = this.log.ownerDocument;
    const line = doc.createElement("div");
    line.className = `line ${role}`;
    line.textContent = text;
    this.appendLine(line);
  }

  private appendError(raw: string): void {
    const doc = this.log.ownerDocument;
    const info = describeError(raw);

    const line = doc.createElement("div");
    line.className = "line error";

    const headline = doc.createElement("span");
    headline.className = "error-headline";
    headline.textContent = info.headline;
    line.append(headline);

    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => this.retry());
    line.append(retry);

    if (info.detail !== null) {
      if (info.detail.length > ERROR_DETAIL_LIMIT) {
        const details = doc.createElement("details");
        details.className = "error-details";
        const summary = doc.createElement("summary");
        summary.textContent = "Details";
        const rawBlock = doc.createElement("div");
        rawBlock.className = "error-raw";
        rawBlock.textContent = info.detail;
        details.append(summary, rawBlock);
        line.append(details);
      } else {
        const technical = doc.createElement("span");
        technical.className = "error-technical";
        technical.textContent = info.detail;
        line.append(technical);
      }
    }

    this.appendLine(line);
  }

  private appendLine(line: HTMLElement): void {
    this.log.append(line);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private retry(): void {
    if (this.busy || this.lastPrompt.length === 0) return;
    this.input.value = this.lastPrompt;
    void this.submit();
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const prompt = this.input.value.trim();
    if (prompt.length === 0) return;

    this.input.blur();
    this.input.value = "";
    this.lastPrompt = prompt;
    this.appendMessage("user", prompt);
    this.setBusy(true);
    try {
      await this.options.onSubmit(prompt);
    } catch (error) {
      if (isAbortError(error)) {
        this.appendMessage("system", "Cancelled.");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.appendMessage("error", message);
      }
    } finally {
      this.setBusy(false);
    }
  }
}

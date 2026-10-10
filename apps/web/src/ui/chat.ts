export type ChatRole = "user" | "system" | "error";

export interface ChatOptions {
  /** Awaited on submit; the chat shows a busy state and surfaces rejections. */
  onSubmit(prompt: string): Promise<void>;
}

/**
 * Chat input. Owns the form/input/log DOM and delegates the actual backend call
 * to `onSubmit`, keeping it free of any knowledge of engine or fetch details.
 */
export class Chat {
  private busy = false;

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

  appendMessage(role: ChatRole, text: string): void {
    const doc = this.log.ownerDocument;
    const line = doc.createElement("div");
    line.className = `line ${role}`;
    line.textContent = text;
    this.log.append(line);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const prompt = this.input.value.trim();
    if (prompt.length === 0) return;

    this.input.value = "";
    this.appendMessage("user", prompt);
    this.setBusy(true);
    try {
      await this.options.onSubmit(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage("error", message);
    } finally {
      this.setBusy(false);
    }
  }
}

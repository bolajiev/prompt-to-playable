/**
 * Staged progress copy. Boundaries are tuned for the live LLM gateway, where
 * generation typically takes 5-20s: the first stage covers quick cached
 * responses and the last keeps a "still working" signal for long calls.
 */
export const STAGE_THRESHOLDS_MS: readonly [number, number, number] = [
  3_000, 12_000, 25_000,
];

const STAGES = [
  "understanding the request…",
  "building the world…",
  "checking the rules…",
  "almost there…",
] as const;

/**
 * Deterministic stage copy for an elapsed duration in milliseconds. Negative
 * and NaN durations read as the start; infinite ones stay on the last stage.
 */
export function stageMessage(elapsedMs: number): string {
  if (Number.isNaN(elapsedMs) || elapsedMs < STAGE_THRESHOLDS_MS[0]) {
    return STAGES[0];
  }
  if (elapsedMs < STAGE_THRESHOLDS_MS[1]) return STAGES[1];
  if (elapsedMs < STAGE_THRESHOLDS_MS[2]) return STAGES[2];
  return STAGES[3];
}

/** Elapsed time as tenths of a second, e.g. "12.4s". */
export function formatElapsed(elapsedMs: number): string {
  const milliseconds = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export interface ProgressElements {
  root: HTMLElement;
  stage: HTMLElement;
  time: HTMLElement;
  cancel: HTMLButtonElement;
}

export interface ProgressOptions {
  now?: () => number;
  intervalMs?: number;
  onCancel?: () => void;
}

/** In-flight generation overlay: elapsed clock, staged copy, cancel button. */
export class GenerationProgress {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly onCancel: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  constructor(
    private readonly elements: ProgressElements,
    options: ProgressOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? 250;
    this.onCancel = options.onCancel;
    this.elements.cancel.addEventListener("click", () => this.onCancel?.());
  }

  get isActive(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.startedAt = this.now();
    this.elements.root.hidden = false;
    this.render(0);
    this.timer = setInterval(
      () => this.render(this.now() - this.startedAt),
      this.intervalMs
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.elements.root.hidden = true;
  }

  private render(elapsedMs: number): void {
    this.elements.stage.textContent = stageMessage(elapsedMs);
    this.elements.time.textContent = formatElapsed(elapsedMs);
  }
}

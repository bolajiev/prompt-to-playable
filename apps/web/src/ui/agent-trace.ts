/**
 * Agent trace strip: a pure view-model plus a small DOM renderer for the
 * `agent` payload returned by POST /generate. The strip is read-only - it
 * renders the tool steps the server already executed (no streaming): a
 * compact collapsible section with one row per step (tool label, status dot,
 * detail, milliseconds) and a summary line such as
 * "5 steps · 1 repair · simulated 3 checks".
 */

export type AgentStepStatus = "ok" | "fail" | "skipped";

export interface AgentTraceStep {
  tool: string;
  status: AgentStepStatus;
  detail: string;
  ms: number;
}

export interface AgentTrace {
  steps: readonly AgentTraceStep[];
  repairs: number;
}

/** One rendered step row (stable field order, no extras). */
export interface TraceStepView {
  tool: string;
  label: string;
  status: AgentStepStatus;
  detail: string;
  msText: string;
  /** Reveal stagger in milliseconds, applied as an inline animation delay. */
  delayMs: number;
}

export interface TraceView {
  steps: TraceStepView[];
  summary: string;
  failed: boolean;
}

/** Per-row stagger for the client-side reveal animation. */
export const TRACE_REVEAL_STAGGER_MS = 60;

const TOOL_LABELS: Record<string, string> = {
  plan: "Plan",
  generate: "Generate",
  validate: "Validate",
  sanity: "Sanity",
  simulate: "Simulate",
  repair: "Repair",
  finalize: "Finalize",
};

/** Human label for a tool id ("simulate" -> "Simulate", fallback title case). */
export function toolLabel(tool: string): string {
  const known = TOOL_LABELS[tool];
  if (known !== undefined) return known;
  const cleaned = tool.replace(/[-_]+/g, " ").trim();
  if (cleaned.length === 0) return "Step";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** "84ms" under a second, else seconds with one decimal ("1.4s"). */
export function formatStepMs(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 1000) return `${Math.round(safe)}ms`;
  return `${(safe / 1000).toFixed(1)}s`;
}

/**
 * Summary line: step count, repair count and (when a successful simulate step
 * is present) the number of checks it ran, parsed from "simulated N checks".
 */
export function summarizeTrace(trace: AgentTrace): string {
  const count = trace.steps.length;
  const parts = [`${count} step${count === 1 ? "" : "s"}`];
  const repairs = Number.isFinite(trace.repairs) ? Math.max(0, trace.repairs) : 0;
  parts.push(`${repairs} repair${repairs === 1 ? "" : "s"}`);
  const simulated = trace.steps.find(
    (step) => step.tool === "simulate" && step.status === "ok"
  );
  if (simulated) {
    const match = /(\d+)\s+checks?/.exec(simulated.detail);
    parts.push(match ? `simulated ${match[1]} checks` : "simulated");
  }
  return parts.join(" · ");
}

/** Pure mapping from an agent trace to render data. */
export function traceView(trace: AgentTrace): TraceView {
  return {
    steps: trace.steps.map((step, index) => ({
      tool: step.tool,
      label: toolLabel(step.tool),
      status: step.status,
      detail: step.detail,
      msText: formatStepMs(step.ms),
      delayMs: index * TRACE_REVEAL_STAGGER_MS,
    })),
    summary: summarizeTrace(trace),
    failed: trace.steps.some((step) => step.status === "fail"),
  };
}

const STATUSES: ReadonlySet<string> = new Set(["ok", "fail", "skipped"]);

/**
 * Tolerant parser for the `agent` field of a /generate response: unknown or
 * malformed payloads return null so the client can render nothing instead of
 * crashing. Steps are validated field by field (wrong-typed steps dropped).
 */
export function parseAgentTrace(payload: unknown): AgentTrace | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as { steps?: unknown; repairs?: unknown };
  if (!Array.isArray(record.steps)) return null;

  const steps: AgentTraceStep[] = [];
  for (const raw of record.steps) {
    if (typeof raw !== "object" || raw === null) continue;
    const step = raw as Record<string, unknown>;
    if (typeof step.tool !== "string" || step.tool.length === 0) continue;
    if (typeof step.status !== "string" || !STATUSES.has(step.status)) continue;
    if (typeof step.detail !== "string") continue;
    if (typeof step.ms !== "number" || !Number.isFinite(step.ms)) continue;
    steps.push({
      tool: step.tool,
      status: step.status as AgentStepStatus,
      detail: step.detail,
      ms: step.ms,
    });
  }
  if (steps.length === 0) return null;

  const repairs =
    typeof record.repairs === "number" && Number.isFinite(record.repairs)
      ? Math.max(0, record.repairs)
      : 0;
  return { steps, repairs };
}

/**
 * DOM renderer: a collapsible strip whose rows are rebuilt on every `show`
 * and animated in via CSS (the inline delay staggers the reveal). Callers
 * only ever call `show`/`clear`; the strip reads nothing else.
 */
export class AgentTraceStrip {
  private readonly head: HTMLButtonElement;
  private readonly summaryEl: HTMLElement;
  private readonly toggleEl: HTMLElement;
  private readonly list: HTMLElement;
  private expanded = true;

  constructor(private readonly root: HTMLElement) {
    const doc = root.ownerDocument;

    this.head = doc.createElement("button");
    this.head.type = "button";
    this.head.className = "agent-trace-head";

    const title = doc.createElement("span");
    title.className = "agent-trace-title";
    title.textContent = "Agent";

    this.summaryEl = doc.createElement("span");
    this.summaryEl.className = "agent-trace-summary";

    this.toggleEl = doc.createElement("span");
    this.toggleEl.className = "agent-trace-toggle";
    this.toggleEl.textContent = "Hide";

    this.head.append(title, this.summaryEl, this.toggleEl);
    this.head.addEventListener("click", () => this.toggle());

    this.list = doc.createElement("ul");
    this.list.className = "agent-trace-list";

    this.root.replaceChildren(this.head, this.list);
    this.root.hidden = true;
    this.syncExpanded();
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.syncExpanded();
  }

  /** Render a trace and reveal the strip (rows animate in via CSS). */
  show(trace: AgentTrace): void {
    const view = traceView(trace);
    const doc = this.root.ownerDocument;

    this.summaryEl.textContent = view.summary;
    this.root.dataset.hasFailure = view.failed ? "true" : "false";

    const rows = view.steps.map((step) => {
      const row = doc.createElement("li");
      row.className = "agent-step";
      row.dataset.tool = step.tool;
      row.dataset.status = step.status;

      const dot = doc.createElement("span");
      dot.className = "agent-dot";

      const label = doc.createElement("span");
      label.className = "agent-step-label";
      label.textContent = step.label;

      const detail = doc.createElement("span");
      detail.className = "agent-step-detail";
      detail.textContent = step.detail;
      detail.title = step.detail;

      const ms = doc.createElement("span");
      ms.className = "agent-step-ms";
      ms.textContent = step.msText;

      row.append(dot, label, detail, ms);
      if (row.style !== undefined) row.style.animationDelay = `${step.delayMs}ms`;
      return row;
    });

    this.list.replaceChildren(...rows);
    this.root.hidden = false;
  }

  /** Hide the strip and drop the previous trace (stale traces never linger). */
  clear(): void {
    this.root.hidden = true;
    this.summaryEl.textContent = "";
    delete this.root.dataset.hasFailure;
    this.list.replaceChildren();
  }

  private syncExpanded(): void {
    this.list.hidden = !this.expanded;
    this.toggleEl.textContent = this.expanded ? "Hide" : "Show";
    if (typeof this.head.setAttribute === "function") {
      this.head.setAttribute("aria-expanded", String(this.expanded));
    }
  }
}

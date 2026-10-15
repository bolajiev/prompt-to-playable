import { describe, expect, test } from "vitest";
import {
  AgentTraceStrip,
  formatStepMs,
  parseAgentTrace,
  summarizeTrace,
  toolLabel,
  traceView,
  type AgentTrace,
} from "../src/ui/agent-trace.js";
import { FakeNode } from "./fakes.js";

function trace(): AgentTrace {
  return {
    repairs: 1,
    steps: [
      { tool: "plan", status: "ok", detail: "kit: machine", ms: 4 },
      { tool: "generate", status: "ok", detail: "generated 14 entities", ms: 8200 },
      {
        tool: "validate",
        status: "ok",
        detail: "14 entities, schema ok",
        ms: 2,
      },
      { tool: "simulate", status: "ok", detail: "simulated 3 checks", ms: 31 },
      { tool: "finalize", status: "ok", detail: "shipped 14 entities", ms: 0 },
    ],
  };
}

describe("agent trace view-model", () => {
  test("formats step durations under and over a second", () => {
    expect(formatStepMs(0)).toBe("0ms");
    expect(formatStepMs(84)).toBe("84ms");
    expect(formatStepMs(999)).toBe("999ms");
    expect(formatStepMs(1000)).toBe("1.0s");
    expect(formatStepMs(1424)).toBe("1.4s");
    expect(formatStepMs(Number.NaN)).toBe("0ms");
    expect(formatStepMs(-5)).toBe("0ms");
  });

  test("labels known tools and falls back to title case", () => {
    expect(toolLabel("plan")).toBe("Plan");
    expect(toolLabel("simulate")).toBe("Simulate");
    expect(toolLabel("weird_tool-name")).toBe("Weird tool name");
    expect(toolLabel("")).toBe("Step");
  });

  test("builds the summary line from steps and repairs", () => {
    expect(summarizeTrace(trace())).toBe("5 steps · 1 repair · simulated 3 checks");
    expect(summarizeTrace({ steps: [], repairs: 0 })).toBe("0 steps · 0 repairs");
    expect(
      summarizeTrace({
        steps: [{ tool: "simulate", status: "ok", detail: "all good", ms: 1 }],
        repairs: 2,
      })
    ).toBe("1 step · 2 repairs · simulated");
  });

  test("maps steps to staggered rows and flags failures", () => {
    const view = traceView(trace());
    expect(view.summary).toBe("5 steps · 1 repair · simulated 3 checks");
    expect(view.failed).toBe(false);
    expect(view.steps[0]).toEqual({
      tool: "plan",
      label: "Plan",
      status: "ok",
      detail: "kit: machine",
      msText: "4ms",
      delayMs: 0,
    });
    expect(view.steps[1]?.msText).toBe("8.2s");
    expect(view.steps.map((step) => step.delayMs)).toEqual([0, 60, 120, 180, 240]);

    const failed = traceView({
      steps: [{ tool: "simulate", status: "fail", detail: "not won", ms: 5 }],
      repairs: 3,
    });
    expect(failed.failed).toBe(true);
  });

  test("parses a server payload tolerantly", () => {
    expect(parseAgentTrace(undefined)).toBeNull();
    expect(parseAgentTrace("nope")).toBeNull();
    expect(parseAgentTrace({})).toBeNull();
    expect(parseAgentTrace({ steps: [] })).toBeNull();

    const parsed = parseAgentTrace({
      steps: [
        { tool: "plan", status: "ok", detail: "kit: machine", ms: 4 },
        { tool: "broken" },
        null,
        { tool: "simulate", status: "weird", detail: "x", ms: 1 },
      ],
      repairs: -2,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.steps).toEqual([
      { tool: "plan", status: "ok", detail: "kit: machine", ms: 4 },
    ]);
    expect(parsed?.repairs).toBe(0);
  });
});

describe("AgentTraceStrip DOM", () => {
  function root(): FakeNode {
    return new FakeNode();
  }

  test("show renders head and rows, toggle collapses, clear hides", () => {
    const node = root();
    const strip = new AgentTraceStrip(node as unknown as HTMLElement);

    expect(node.hidden).toBe(true);

    strip.show(trace());

    expect(node.hidden).toBe(false);
    expect(node.dataset.hasFailure).toBe("false");
    const head = node.children[0];
    expect(head?.className).toContain("agent-trace-head");
    expect(head?.find("agent-trace-summary")?.textContent).toBe(
      "5 steps · 1 repair · simulated 3 checks"
    );
    const list = node.children[1];
    expect(list?.className).toContain("agent-trace-list");
    expect(list?.children).toHaveLength(5);
    const firstRow = list?.children[0];
    expect(firstRow?.dataset.tool).toBe("plan");
    expect(firstRow?.dataset.status).toBe("ok");
    expect(firstRow?.find("agent-step-label")?.textContent).toBe("Plan");
    expect(firstRow?.find("agent-step-detail")?.textContent).toBe("kit: machine");
    expect(firstRow?.find("agent-step-ms")?.textContent).toBe("4ms");

    expect(strip.isExpanded).toBe(true);
    strip.toggle();
    expect(strip.isExpanded).toBe(false);
    expect(list?.hidden).toBe(true);
    expect(head?.find("agent-trace-toggle")?.textContent).toBe("Show");
    strip.toggle();
    expect(list?.hidden).toBe(false);

    strip.clear();
    expect(node.hidden).toBe(true);
    expect(list?.children).toHaveLength(0);
  });

  test("show marks a failed trace on the root", () => {
    const node = root();
    const strip = new AgentTraceStrip(node as unknown as HTMLElement);
    strip.show({
      steps: [{ tool: "simulate", status: "fail", detail: "not won", ms: 9 }],
      repairs: 1,
    });
    expect(node.dataset.hasFailure).toBe("true");
    const row = node.children[1]?.children[0];
    expect(row?.dataset.status).toBe("fail");
  });
});

import { describe, expect, test, vi } from "vitest";
import { Chat, type ChatOptions } from "../src/ui/chat.js";

interface FakeLine {
  className: string;
  textContent: string;
}

interface FakeEvent {
  preventDefault(): void;
}

function createHarness(onSubmit?: ChatOptions["onSubmit"]) {
  const listeners: Record<string, (event: FakeEvent) => void> = {};
  const form = {
    addEventListener(type: string, handler: (event: FakeEvent) => void): void {
      listeners[type] = handler;
    },
    querySelector: () => null,
  };
  const input = {
    value: "",
    disabled: false,
    placeholder: "",
    blur: vi.fn(),
  };
  const lines: FakeLine[] = [];
  const log = {
    scrollTop: 0,
    scrollHeight: 0,
    ownerDocument: {
      createElement: (): FakeLine => ({ className: "", textContent: "" }),
    },
    append(line: FakeLine): void {
      lines.push(line);
    },
  };

  const chat = new Chat(
    form as unknown as HTMLFormElement,
    input as unknown as HTMLInputElement,
    log as unknown as HTMLElement,
    { onSubmit: onSubmit ?? (async () => {}) }
  );

  function submit(): void {
    const handler = listeners["submit"];
    if (!handler) throw new Error("Chat did not register a submit listener");
    handler({ preventDefault: () => {} });
  }

  return { chat, input, lines, submit };
}

describe("chat submit focus", () => {
  test("blurs the input when a prompt is submitted", () => {
    const harness = createHarness();
    harness.input.value = "build a platformer";
    harness.submit();
    expect(harness.input.blur).toHaveBeenCalledTimes(1);
  });

  test("does not blur on an empty or blank prompt", () => {
    const harness = createHarness();
    harness.input.value = "   ";
    harness.submit();
    expect(harness.input.blur).not.toHaveBeenCalled();
  });
});

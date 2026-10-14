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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("chat one-click send", () => {
  test("send fills the input and submits immediately", async () => {
    const submitted: string[] = [];
    const harness = createHarness(async (prompt) => {
      submitted.push(prompt);
    });

    harness.chat.send("a quiet forest clearing with a campfire at dusk");

    expect(submitted).toEqual(["a quiet forest clearing with a campfire at dusk"]);
    expect(harness.input.value).toBe("");
    expect(harness.lines).toHaveLength(1);
    expect(harness.lines[0]?.className).toBe("line user");
    expect(harness.lines[0]?.textContent).toBe(
      "a quiet forest clearing with a campfire at dusk"
    );
    await flush();
    expect(harness.chat.isBusy).toBe(false);
  });

  test("send is a no-op while busy and for blank text", async () => {
    let release: () => void = () => {};
    const submitted: string[] = [];
    const harness = createHarness(
      (prompt) =>
        new Promise<void>((resolve) => {
          submitted.push(prompt);
          release = resolve;
        })
    );

    harness.input.value = "first prompt";
    harness.submit();
    expect(harness.chat.isBusy).toBe(true);

    harness.chat.send("second prompt");
    harness.chat.send("   ");
    expect(submitted).toEqual(["first prompt"]);

    release();
    await flush();
    expect(harness.chat.isBusy).toBe(false);
  });

  test("keyboard typing still submits the typed value through the form", async () => {
    const submitted: string[] = [];
    const harness = createHarness(async (prompt) => {
      submitted.push(prompt);
    });

    harness.input.value = "  build a platformer  ";
    harness.submit();

    expect(submitted).toEqual(["build a platformer"]);
    await flush();
  });
});

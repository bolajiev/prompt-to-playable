import { describe, expect, test, vi } from "vitest";
import {
  Chat,
  describeError,
  ERROR_DETAIL_LIMIT,
  isAbortError,
  type ChatOptions,
} from "../src/ui/chat.js";
import { FakeNode } from "./fakes.js";

describe("describeError", () => {
  test("maps unreachable-server failures to a friendly headline", () => {
    const info = describeError(
      new Error("Could not reach the server (/generate): Failed to fetch")
    );
    expect(info.headline).toBe(
      "Couldn't reach the server — check your connection and try again."
    );
    expect(info.detail).toContain("Could not reach the server");
  });

  test("maps timeouts and 5xx responses", () => {
    expect(describeError("Request timed out after 60s").headline).toBe(
      "The request timed out — try again."
    );
    expect(describeError("Request failed (HTTP 503)").headline).toBe(
      "The server hit a problem — try again in a moment."
    );
  });

  test("maps invalid or empty server responses", () => {
    expect(describeError("Server returned invalid JSON (HTTP 200)").headline).toBe(
      "The server sent an unexpected response — try again."
    );
    expect(describeError("Empty response from /generate").headline).toBe(
      "The server sent an unexpected response — try again."
    );
  });

  test("keeps short informative errors verbatim", () => {
    const raw = "Field 'prompt' must be a non-empty string";
    expect(describeError(new Error(raw))).toEqual({ headline: raw, detail: null });
  });

  test("truncates long errors and keeps the raw text for the details toggle", () => {
    const raw = "x".repeat(ERROR_DETAIL_LIMIT + 40);
    const info = describeError(new Error(raw));
    expect(info.headline).toBe(`${"x".repeat(ERROR_DETAIL_LIMIT)}…`);
    expect(info.detail).toBe(raw);
  });

  test("handles empty and non-Error throws", () => {
    expect(describeError(new Error("")).headline).toBe(
      "Something went wrong — try again."
    );
    expect(describeError("boom").headline).toBe("boom");
  });
});

describe("isAbortError", () => {
  test("recognizes abort-shaped values only", () => {
    expect(isAbortError(Object.assign(new Error("stop"), { name: "AbortError" }))).toBe(
      true
    );
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new Error("stop"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

function createChatHarness(onSubmit: ChatOptions["onSubmit"]) {
  const form = new FakeNode();
  const input = new FakeNode();
  const log = new FakeNode();
  const chat = new Chat(
    form as unknown as HTMLFormElement,
    input as unknown as HTMLInputElement,
    log as unknown as HTMLElement,
    { onSubmit }
  );
  return { chat, form, input, log };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("chat error, retry and cancel UX", () => {
  test("renders a friendly error line and retries the last prompt", async () => {
    let calls = 0;
    const submitted: string[] = [];
    const onSubmit = vi.fn(async (prompt: string) => {
      submitted.push(prompt);
      calls += 1;
      if (calls === 1) {
        throw new Error("Could not reach the server (/generate): Failed to fetch");
      }
    });
    const { form, input, log } = createChatHarness(onSubmit);

    input.value = "build a platformer";
    form.emit("submit");
    await flush();

    expect(log.children).toHaveLength(2);
    const line = log.children[1];
    expect(line.className).toBe("line error");
    expect(line.find("error-headline")?.textContent).toBe(
      "Couldn't reach the server — check your connection and try again."
    );
    expect(line.find("error-technical")?.textContent).toContain(
      "Could not reach the server"
    );

    const retry = line.find("retry");
    expect(retry?.textContent).toBe("Retry");
    retry?.click();
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(submitted).toEqual(["build a platformer", "build a platformer"]);
    expect(input.disabled).toBe(false);
  });

  test("collapses long raw errors behind a details element", async () => {
    const raw = "z".repeat(ERROR_DETAIL_LIMIT + 50);
    const { form, input, log } = createChatHarness(async () => {
      throw new Error(raw);
    });

    input.value = "make a game";
    form.emit("submit");
    await flush();

    const line = log.children[1];
    const details = line.find("error-details");
    expect(details).toBeDefined();
    expect(details?.find("error-raw")?.textContent).toBe(raw);
    expect(line.find("error-technical")).toBeUndefined();
  });

  test("shows a calm note instead of an error when the request is aborted", async () => {
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    const { form, input, log } = createChatHarness(async () => {
      throw abortError;
    });

    input.value = "build";
    form.emit("submit");
    await flush();

    expect(log.children).toHaveLength(2);
    expect(log.children[1].className).toBe("line system");
    expect(log.children[1].textContent).toBe("Cancelled.");
    expect(log.children[1].find("retry")).toBeUndefined();
    expect(input.disabled).toBe(false);
  });

  test("fill sets the input and focuses it without submitting", () => {
    const onSubmit = vi.fn(async () => {});
    const { chat, input } = createChatHarness(onSubmit);

    chat.fill("a quiet forest clearing with a campfire at dusk");
    expect(input.value).toBe("a quiet forest clearing with a campfire at dusk");
    expect(input.focus).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createOpenAiLlm } from "../src/llm.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];

async function startServer(
  handler: Handler
): Promise<{ baseUrl: string; requestCount: () => number }> {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requestCount: () => requests };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        })
    )
  );
});

describe("createOpenAiLlm session id header", () => {
  const originalSessionId = process.env.OPENAI_SESSION_ID;

  afterEach(() => {
    if (originalSessionId === undefined) {
      delete process.env.OPENAI_SESSION_ID;
    } else {
      process.env.OPENAI_SESSION_ID = originalSessionId;
    }
  });

  function startOkServer(): Promise<{ baseUrl: string; sessionHeader: () => string | undefined }> {
    let seen: string | undefined;
    return startServer((req, res) => {
      const value = req.headers["x-session-id"];
      seen = Array.isArray(value) ? value[0] : value;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }).then(({ baseUrl }) => ({ baseUrl, sessionHeader: () => seen }));
  }

  test("sends X-Session-Id when sessionId is provided", async () => {
    const { baseUrl, sessionHeader } = await startOkServer();
    const llm = createOpenAiLlm({ apiKey: "test-key", baseUrl, sessionId: "ses_test" });

    await expect(llm("hello")).resolves.toBe("ok");
    expect(sessionHeader()).toBe("ses_test");
  });

  test("omits X-Session-Id when no sessionId is configured", async () => {
    delete process.env.OPENAI_SESSION_ID;
    const { baseUrl, sessionHeader } = await startOkServer();
    const llm = createOpenAiLlm({ apiKey: "test-key", baseUrl });

    await expect(llm("hello")).resolves.toBe("ok");
    expect(sessionHeader()).toBeUndefined();
  });

  test("falls back to the OPENAI_SESSION_ID env variable", async () => {
    process.env.OPENAI_SESSION_ID = "ses_env";
    const { baseUrl, sessionHeader } = await startOkServer();
    const llm = createOpenAiLlm({ apiKey: "test-key", baseUrl });

    await expect(llm("hello")).resolves.toBe("ok");
    expect(sessionHeader()).toBe("ses_env");
  });
});

describe("createOpenAiLlm retries", () => {
  test("retries 503 responses and resolves after the third attempt", async () => {
    let seen = 0;
    const { baseUrl, requestCount } = await startServer((_req, res) => {
      seen += 1;
      res.setHeader("content-type", "application/json");
      if (seen < 3) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "high demand" }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ choices: [{ message: { content: "retried ok" } }] }));
    });

    const llm = createOpenAiLlm({ apiKey: "test-key", baseUrl, retryDelaysMs: [5, 5] });

    await expect(llm("hello")).resolves.toBe("retried ok");
    expect(requestCount()).toBe(3);
  });

  test("does not retry a 400 response", async () => {
    const { baseUrl, requestCount } = await startServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "bad request" }));
    });

    const llm = createOpenAiLlm({ apiKey: "test-key", baseUrl, retryDelaysMs: [5, 5] });

    await expect(llm("hello")).rejects.toThrow(/status 400 after 1 attempt/);
    expect(requestCount()).toBe(1);
  });

  test("retries network failures and rejects after 3 attempts", async () => {
    const port = await closedPort();
    const llm = createOpenAiLlm({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      retryDelaysMs: [10, 20],
    });

    const startedAt = Date.now();
    await expect(llm("hello")).rejects.toThrow(/after 3 attempts/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });
});

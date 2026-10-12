import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { loadEnvFile } from "../src/env.js";
import { createOpenAiLlm } from "../src/llm.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECRET = "test-secret-value";

const cleanupDirs: string[] = [];
const cleanupKeys: string[] = [];

function trackDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function trackEnv(key: string, value: string | undefined): void {
  cleanupKeys.push(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const key of cleanupKeys.splice(0)) delete process.env[key];
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of cleanupKeys.splice(0)) delete process.env[key];
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secret hygiene", () => {
  test("LLM errors never echo the API key (hostile 500 body)", async () => {
    const server = createServer((req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "upstream boom",
          authorization: req.headers.authorization ?? "",
        })
      );
    });

    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const llm = createOpenAiLlm({
        apiKey: SECRET,
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });

      const error = await llm("hello").then(
        () => null,
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("500");
      expect(message).not.toContain(SECRET);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      });
    }
  });

  test("server/.env is gitignored", () => {
    const stdout = execFileSync("git", ["check-ignore", "--", "server/.env"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(stdout.trim()).toBe("server/.env");
  });

  test("server/.env.example contains only names, no secret values", () => {
    const text = readFileSync(resolve(ROOT, "server", ".env.example"), "utf8");
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("OPENAI_BASE_URL");
    expect(text).toContain("OPENAI_MODEL");
    expect(text).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/\bAIza[A-Za-z0-9_-]{10,}/);

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      expect(eq, `line must be KEY=VALUE: ${trimmed}`).toBeGreaterThan(0);
      expect(trimmed.slice(eq + 1).trim()).toBe("");
    }
  });
});

describe("loadEnvFile", () => {
  test("fills unset keys, strips quotes, and never overrides existing values", () => {
    const dir = trackDir("llm-env-");
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "# comment",
        'LLM_ENV_TEST_A="quoted-value"',
        "LLM_ENV_TEST_B=plain-value",
        "LLM_ENV_TEST_C='single-quoted'",
        "LLM_ENV_TEST_A=later-wins-in-file-but-not-over-env",
        "not-a-kv-line",
        "",
      ].join("\n"),
      "utf8"
    );

    trackEnv("LLM_ENV_TEST_A", "existing-value");
    trackEnv("LLM_ENV_TEST_B", undefined);
    trackEnv("LLM_ENV_TEST_C", undefined);

    expect(loadEnvFile(file)).toBe(true);
    expect(process.env.LLM_ENV_TEST_A).toBe("existing-value");
    expect(process.env.LLM_ENV_TEST_B).toBe("plain-value");
    expect(process.env.LLM_ENV_TEST_C).toBe("single-quoted");
  });

  test("returns false when the file does not exist", () => {
    expect(loadEnvFile(join(tmpdir(), "llm-env-does-not-exist.env"))).toBe(false);
  });
});

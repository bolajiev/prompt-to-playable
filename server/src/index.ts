import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { createApp } from "./routes.js";
import type { RouteHandlers } from "./routes.js";

export const DEFAULT_PORT = 3000;

export function getApiKey(): string | undefined {
  const key = process.env.OPENAI_API_KEY;
  if (typeof key === "string" && key.trim().length > 0) return key.trim();
  return undefined;
}

export function buildApp(handlers: RouteHandlers = {}): Express {
  return createApp(handlers);
}

export function startServer(handlers: RouteHandlers = {}): void {
  const app = createApp(handlers);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  app.listen(port, () => {
    if (getApiKey() !== undefined) {
      console.log(`[server] listening on :${port} (LLM API key configured)`);
    } else {
      console.log(`[server] listening on :${port}`);
    }
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startServer();
}
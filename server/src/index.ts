import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { createDefaultEditDeps, createEditPipeline } from "./edit.js";
import { loadEnvFile } from "./env.js";
import { createOpenAiLlm } from "./llm.js";
import { createDefaultPipelineDeps, createGenerationPipeline } from "./pipeline.js";
import { createApp } from "./routes.js";
import type { RouteHandlers } from "./routes.js";

export const DEFAULT_PORT = 3000;

const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

export function getApiKey(): string | undefined {
  const key = process.env.OPENAI_API_KEY;
  if (typeof key === "string" && key.trim().length > 0) return key.trim();
  return undefined;
}

export function buildApp(handlers: RouteHandlers = {}): Express {
  return createApp(handlers);
}

export function createDefaultHandlers(): RouteHandlers {
  const llm = createOpenAiLlm({ apiKey: getApiKey() });
  const pipeline = createGenerationPipeline(createDefaultPipelineDeps(llm));
  const editPipeline = createEditPipeline(createDefaultEditDeps(llm));
  return {
    generate: (prompt) => pipeline.generateGame(prompt),
    edit: (prompt, game, history) => editPipeline.editGame(prompt, game, history),
  };
}

export function startServer(handlers?: RouteHandlers): void {
  loadEnvFile(ENV_PATH);
  const app = createApp(handlers ?? createDefaultHandlers());
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
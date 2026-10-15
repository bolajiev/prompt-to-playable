import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { runAgent } from "./agent.js";
import type { AgentDeps } from "./agent.js";
import { createDefaultEditDeps, createEditPipeline } from "./edit.js";
import { loadEnvFile } from "./env.js";
import { createOpenAiLlm } from "./llm.js";
import { createDefaultPipelineDeps } from "./pipeline.js";
import { createApp } from "./routes.js";
import type { CreateAppOptions, RouteHandlers } from "./routes.js";

export { createApp };
export type { CreateAppOptions, RouteHandlers };

export const DEFAULT_PORT = 3000;

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(SERVER_DIR, ".env");
const DEFAULT_WEB_DIST = path.join(SERVER_DIR, "..", "apps", "web", "dist");

export function getApiKey(): string | undefined {
  const key = process.env.OPENAI_API_KEY;
  if (typeof key === "string" && key.trim().length > 0) return key.trim();
  return undefined;
}

export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}": expected an integer between 0 and 65535`);
  }
  return port;
}

export function buildApp(
  handlers: RouteHandlers = {},
  options: CreateAppOptions = {}
): Express {
  return createApp(handlers, options);
}

export function createDefaultHandlers(): RouteHandlers {
  const llm = createOpenAiLlm({ apiKey: getApiKey() });
  const defaults = createDefaultPipelineDeps(llm);
  const agentDeps: AgentDeps = {
    plan: (prompt) => defaults.classifier(prompt),
    generate: (prompt, archetype) => defaults.generator(prompt, archetype),
    repair: (doc, errors, attempt) => defaults.repairer(doc, errors, attempt),
  };
  const editPipeline = createEditPipeline(createDefaultEditDeps(llm));
  return {
    generate: (prompt) => runAgent(prompt, agentDeps),
    edit: (prompt, game, history) => editPipeline.editGame(prompt, game, history),
  };
}

export function startServer(handlers?: RouteHandlers): void {
  loadEnvFile(ENV_PATH);
  const port = resolvePort(process.env.PORT);
  const webDist = process.env.WEB_DIST ?? DEFAULT_WEB_DIST;
  const app = buildApp(handlers ?? createDefaultHandlers(), { webDist });
  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    if (getApiKey() !== undefined) {
      console.log(`[server] listening on ${url} (LLM API key configured)`);
    } else {
      console.log(`[server] listening on ${url}`);
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
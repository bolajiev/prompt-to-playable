import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  Response,
} from "express";
import type { GameDoc } from "@prompt-to-playable/schema";
import type { AgentResult, AgentStep } from "./agent.js";
import type { EditResult } from "./edit.js";
import { validatePatch } from "./patch.js";
import { sanityCheck } from "./sanity.js";
import type { SanityIssue } from "./sanity.js";
import { validateDoc } from "./validate.js";
import type { ValidationIssue } from "./validate.js";

export type { AgentResult, AgentStep, EditResult };

/** Trace payload the client renders next to the generated document. */
export interface AgentTracePayload {
  steps: AgentStep[];
  repairs: number;
}

export interface RouteHandlers {
  /**
   * Generation handler. An `AgentResult` carries the agent trace; a bare
   * GameDoc is still accepted (legacy injectors and tests) and reported with
   * an empty trace.
   */
  generate?: (prompt: string) => Promise<GameDoc | AgentResult>;
  edit?: (
    prompt: string,
    game: GameDoc,
    history: unknown[]
  ) => Promise<EditResult>;
}

function isAgentResult(value: unknown): value is AgentResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { doc?: unknown; steps?: unknown; repairs?: unknown };
  return (
    typeof record.doc === "object" &&
    record.doc !== null &&
    Array.isArray(record.steps) &&
    typeof record.repairs === "number"
  );
}

export class RouteError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "RouteError";
    this.code = code;
    this.details = details.length > 0 ? details : [message];
  }
}

function issueDetails(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) =>
    issue.path === "(root)" ? issue.message : `${issue.path}: ${issue.message}`
  );
}

function sanityDetails(issues: readonly SanityIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message} [${issue.code}]`);
}

function readPrompt(body: unknown): { ok: true; value: string } | { ok: false; details: string[] } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, details: ["Request body must be a JSON object"] };
  }
  const prompt = (body as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { ok: false, details: ["Field 'prompt' must be a non-empty string"] };
  }
  return { ok: true, value: prompt };
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function bodyParserStatus(err: unknown): 400 | 413 | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (type === "entity.parse.failed") return 400;
  if (type === "entity.too.large") return 413;
  if (status === 400 || status === 413) return status;
  return undefined;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof RouteError) {
    res.status(400).json({ error: err.code, details: err.details });
    return;
  }

  const clientStatus = bodyParserStatus(err);
  if (clientStatus === 400) {
    res
      .status(400)
      .json({ error: "BAD_REQUEST", details: ["Malformed JSON request body"] });
    return;
  }
  if (clientStatus === 413) {
    res.status(413).json({
      error: "PAYLOAD_TOO_LARGE",
      details: ["Request body exceeds the JSON size limit"],
    });
    return;
  }

  res.status(500).json({ error: "INTERNAL_ERROR" });
};

export interface CreateAppOptions {
  webDist?: string;
}

const API_PATH_PREFIXES = ["/generate", "/edit", "/healthz"];

function isApiPath(pathname: string): boolean {
  return API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function createApp(
  handlers: RouteHandlers = {},
  options: CreateAppOptions = {}
): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post(
    "/generate",
    asyncHandler(async (req, res) => {
      const prompt = readPrompt(req.body);
      if (!prompt.ok) {
        res.status(400).json({ error: "INVALID_REQUEST", details: prompt.details });
        return;
      }
      if (!handlers.generate) {
        res.status(501).json({
          error: "NOT_IMPLEMENTED",
          details: ["generate handler is not wired yet"],
        });
        return;
      }

      const result = await handlers.generate(prompt.value);
      const agent: AgentTracePayload = isAgentResult(result)
        ? { steps: result.steps, repairs: result.repairs }
        : { steps: [], repairs: 0 };
      const doc = isAgentResult(result) ? result.doc : result;
      // Defense in depth: the agent already validated and sanity-checked the
      // document, but the route re-checks whatever the handler returned.
      const validated = validateDoc(doc);
      if (!validated.ok || !validated.data) {
        throw new RouteError(
          "GENERATION_FAILED",
          "Generator produced a document that failed validation",
          issueDetails(validated.issues)
        );
      }
      const sanity = sanityCheck(validated.data);
      if (!sanity.ok) {
        throw new RouteError(
          "GENERATION_FAILED",
          "Generator produced a document that failed sanity checks",
          sanityDetails(sanity.errors)
        );
      }
      // Backward compatible shape: the GameDoc fields stay at the top level
      // and the agent trace rides alongside as `agent`.
      res.status(200).json({ ...validated.data, agent });
    })
  );

  // /edit intentionally stays on the dedicated patch pipeline: an edit is a
  // bounded RFC 6902 patch against an already-valid document, its repair loop
  // re-validates and re-sanity-checks every candidate patch, and running the
  // full agent (classify/generate/simulate) again would add nothing but LLM
  // latency and a second chance to drift the document. `runAgent` is the
  // full-document generation tool; patches remain patch-sized.
  app.post(
    "/edit",
    asyncHandler(async (req, res) => {
      const prompt = readPrompt(req.body);
      if (!prompt.ok) {
        res.status(400).json({ error: "INVALID_REQUEST", details: prompt.details });
        return;
      }

      const body = (req.body ?? {}) as { game?: unknown; history?: unknown };
      const game = validateDoc(body.game);
      if (!game.ok || !game.data) {
        res.status(400).json({
          error: "INVALID_REQUEST",
          details: ["Field 'game' must be a valid game document", ...issueDetails(game.issues)],
        });
        return;
      }

      if (!handlers.edit) {
        res.status(501).json({
          error: "NOT_IMPLEMENTED",
          details: ["edit handler is not wired yet"],
        });
        return;
      }

      const history = Array.isArray(body.history) ? body.history : [];
      const result = await handlers.edit(prompt.value, game.data, history);
      const patched = validateDoc(result.doc);
      if (!patched.ok || !patched.data) {
        throw new RouteError(
          "EDIT_FAILED",
          "Edited document failed validation",
          issueDetails(patched.issues)
        );
      }
      const patch = validatePatch(result.patch);
      if (!patch.ok || !patch.patch) {
        throw new RouteError(
          "EDIT_FAILED",
          "Edit did not return a valid RFC 6902 JSON Patch",
          patch.issues
        );
      }
      const sanity = sanityCheck(patched.data);
      if (!sanity.ok) {
        throw new RouteError(
          "EDIT_FAILED",
          "Edited document failed sanity checks",
          sanityDetails(sanity.errors)
        );
      }
      res.status(200).json({ doc: patched.data, patch: patch.patch });
    })
  );

  const webDist =
    options.webDist === undefined ? undefined : path.resolve(options.webDist);
  if (webDist !== undefined && existsSync(webDist)) {
    const indexHtml = path.join(webDist, "index.html");
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (isApiPath(req.path) || !existsSync(indexHtml)) {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND", details: ["Unknown route"] });
  });

  app.use(errorHandler);

  return app;
}
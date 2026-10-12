import express from "express";
import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  Response,
} from "express";
import type { GameDoc } from "@prompt-to-playable/schema";
import type { EditResult } from "./edit.js";
import { validatePatch } from "./patch.js";
import { sanityCheck } from "./sanity.js";
import type { SanityIssue } from "./sanity.js";
import { validateDoc } from "./validate.js";
import type { ValidationIssue } from "./validate.js";

export type { EditResult };

export interface RouteHandlers {
  generate?: (prompt: string) => Promise<GameDoc>;
  edit?: (
    prompt: string,
    game: GameDoc,
    history: unknown[]
  ) => Promise<EditResult>;
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

export function createApp(handlers: RouteHandlers = {}): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

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

      const doc = await handlers.generate(prompt.value);
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
      res.status(200).json(validated.data);
    })
  );

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

  app.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND", details: ["Unknown route"] });
  });

  app.use(errorHandler);

  return app;
}
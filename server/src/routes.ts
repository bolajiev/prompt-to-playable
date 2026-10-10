import express from "express";
import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  Response,
} from "express";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateDoc } from "./validate.js";
import type { ValidationIssue } from "./validate.js";

export interface EditResult {
  doc: GameDoc;
  patch: unknown[];
}

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

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof RouteError) {
    res.status(400).json({ error: err.code, details: err.details });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: "INTERNAL_ERROR", details: [message] });
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
      if (!Array.isArray(result.patch)) {
        throw new RouteError("EDIT_FAILED", "Edit did not return a JSON Patch array");
      }
      res.status(200).json({ doc: patched.data, patch: result.patch });
    })
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND", details: ["Unknown route"] });
  });

  app.use(errorHandler);

  return app;
}
import { GameSchema, type GameDoc } from "./schema.js";

export function validateGame(doc: unknown) {
  const r = GameSchema.safeParse(doc);
  return {
    ok: r.success,
    data: r.success ? (r.data as GameDoc) : undefined,
    error: r.success ? undefined : r.error,
  };
}

export function isGame(doc: unknown): doc is GameDoc {
  return GameSchema.safeParse(doc).success;
}

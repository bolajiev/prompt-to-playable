export type PatchOperation = "add" | "remove" | "replace";

export interface JsonPatchOperation {
  op: PatchOperation;
  path: string;
  value?: unknown;
}

export type JsonPatch = JsonPatchOperation[];

export interface PatchValidation {
  ok: boolean;
  patch?: JsonPatch;
  issues: string[];
}

export interface PatchErrorOptions {
  op?: string;
  path?: string;
}

export class PatchError extends Error {
  readonly op: string | undefined;
  readonly path: string | undefined;

  constructor(message: string, options: PatchErrorOptions = {}) {
    super(message);
    this.name = "PatchError";
    this.op = options.op;
    this.path = options.path;
  }
}

const SUPPORTED_OPS: readonly PatchOperation[] = ["add", "remove", "replace"];

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function guardKey(key: string, path: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new PatchError(
      `Unsafe path segment ${JSON.stringify(key)} is not allowed`,
      { path }
    );
  }
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function parsePointer(path: string): string[] {
  if (typeof path !== "string") {
    throw new PatchError(
      `JSON Pointer must be a string, received ${typeof path}`,
      { path: String(path) }
    );
  }
  if (path === "") return [];
  if (path[0] !== "/") {
    throw new PatchError(
      `JSON Pointer must be empty or start with '/': ${JSON.stringify(path)}`,
      { path }
    );
  }
  return path
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?![01])/.test(token)) {
        throw new PatchError(
          `Invalid JSON Pointer escape in ${JSON.stringify(path)}`,
          { path }
        );
      }
      return unescapeToken(token);
    });
}

export function validatePatch(patch: unknown): PatchValidation {
  if (!Array.isArray(patch)) {
    return { ok: false, issues: ["JSON Patch must be an array of operations"] };
  }

  const issues: string[] = [];
  patch.forEach((entry, index) => {
    const label = `operation ${index}`;
    if (!isPlainObject(entry)) {
      issues.push(`${label} must be an object`);
      return;
    }
    const op = (entry as { op?: unknown }).op;
    if (typeof op !== "string" || !SUPPORTED_OPS.includes(op as PatchOperation)) {
      issues.push(
        `${label} has unsupported op ${JSON.stringify(op)} (expected ${SUPPORTED_OPS.join(", ")})`
      );
    }
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== "string") {
      issues.push(`${label} must have a string 'path'`);
    } else {
      try {
        parsePointer(path);
      } catch (error) {
        issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (
      (op === "add" || op === "replace") &&
      !Object.prototype.hasOwnProperty.call(entry, "value")
    ) {
      issues.push(`${label} ('${String(op)}') must include a 'value'`);
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, patch: patch as JsonPatch, issues: [] };
}

export function assertValidPatch(patch: unknown): asserts patch is JsonPatch {
  const result = validatePatch(patch);
  if (!result.ok) {
    throw new PatchError(`Invalid JSON Patch: ${result.issues.join("; ")}`);
  }
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    clone[key] = deepClone(source[key]);
  }
  return clone as unknown as T;
}

function parseArrayIndex(
  token: string,
  length: number,
  allowAppend: boolean
): number {
  if (allowAppend && token === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) {
    throw new PatchError(
      `Array index must be a non-negative integer without leading zeros: ${JSON.stringify(token)}`
    );
  }
  const index = Number(token);
  const max = allowAppend ? length : length - 1;
  if (index > max) {
    throw new PatchError(
      `Array index ${index} is out of range (length ${length})`
    );
  }
  return index;
}

interface Container {
  parent: unknown;
  key: string;
  isArray: boolean;
}

function resolveContainer(
  root: unknown,
  tokens: string[],
  path: string
): Container {
  let current = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (Array.isArray(current)) {
      const index = parseArrayIndex(token, current.length, false);
      current = current[index];
      continue;
    }
    if (isPlainObject(current)) {
      guardKey(token, path);
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new PatchError(`Path not found: ${path}`, { path });
      }
      current = current[token];
      continue;
    }
    throw new PatchError(`Cannot traverse into a non-container at ${path}`, {
      path,
    });
  }
  return {
    parent: current,
    key: tokens[tokens.length - 1],
    isArray: Array.isArray(current),
  };
}

function applyOperation(root: unknown, operation: JsonPatchOperation): unknown {
  const tokens = parsePointer(operation.path);

  if (tokens.length === 0) {
    if (operation.op === "remove") {
      throw new PatchError("Cannot remove the entire document", {
        op: operation.op,
        path: operation.path,
      });
    }
    return deepClone(operation.value);
  }

  const { parent, key, isArray } = resolveContainer(root, tokens, operation.path);

  if (isArray) {
    const array = parent as unknown[];
    if (operation.op === "add") {
      const index = parseArrayIndex(key, array.length, true);
      array.splice(index, 0, deepClone(operation.value));
      return root;
    }
    const index = parseArrayIndex(key, array.length, false);
    if (operation.op === "replace") {
      array[index] = deepClone(operation.value);
    } else {
      array.splice(index, 1);
    }
    return root;
  }

  if (!isPlainObject(parent)) {
    throw new PatchError(
      `Cannot apply '${operation.op}' to a non-container at ${operation.path}`,
      { op: operation.op, path: operation.path }
    );
  }

  guardKey(key, operation.path);
  const exists = Object.prototype.hasOwnProperty.call(parent, key);

  if (operation.op === "add") {
    parent[key] = deepClone(operation.value);
  } else if (operation.op === "replace") {
    if (!exists) {
      throw new PatchError(`Cannot replace missing key at ${operation.path}`, {
        op: operation.op,
        path: operation.path,
      });
    }
    parent[key] = deepClone(operation.value);
  } else {
    if (!exists) {
      throw new PatchError(`Cannot remove missing key at ${operation.path}`, {
        op: operation.op,
        path: operation.path,
      });
    }
    delete parent[key];
  }
  return root;
}

export function applyPatch<T>(doc: T, patch: JsonPatch): T {
  assertValidPatch(patch);
  let result: unknown = deepClone(doc);
  for (const operation of patch) {
    result = applyOperation(result, operation);
  }
  return result as T;
}

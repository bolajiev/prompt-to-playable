/**
 * Minimal `document` stub for exercising the canvas code paths in node.
 * `createElement("canvas")` returns a canvas whose 2D context records every
 * method call, so tests can assert that drawing actually happened without a
 * real DOM. Only the members the renderer touches are implemented.
 */

export interface FakeDom {
  /** Names of every 2D context method invoked while installed. */
  calls: string[];
  restore: () => void;
}

type GlobalWithDocument = { document?: unknown };

export function installFakeDocument(): FakeDom {
  const target = globalThis as GlobalWithDocument;
  const original = target.document;
  const calls: string[] = [];

  const createElement = (tag: string): unknown => {
    if (tag !== "canvas") {
      throw new Error(`fake document: unsupported element <${tag}>`);
    }
    const context = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property === "symbol") return undefined;
          return (..._args: unknown[]): undefined => {
            calls.push(property);
            return undefined;
          };
        },
        set: () => true,
      }
    );
    return {
      width: 0,
      height: 0,
      getContext: (kind: string): unknown => (kind === "2d" ? context : null),
    };
  };

  target.document = { createElement };

  return {
    calls,
    restore: () => {
      if (original === undefined) delete target.document;
      else target.document = original;
    },
  };
}

/**
 * Minimal `document` stub for exercising the canvas code paths in node.
 * `createElement("canvas")` returns a canvas whose 2D context records every
 * method call, so tests can assert that drawing actually happened without a
 * real DOM. Only the members the renderer touches are implemented.
 */

export interface FakeCanvas {
  width: number;
  height: number;
}

export interface FakeDomEvent {
  method: string;
  args: unknown[];
}

export interface FakeDom {
  /**
   * Every 2D context interaction while installed: method names as-is, and
   * property assignments as `set:<property>` (canvas styles are set, not
   * called, so this is the only way to observe them).
   */
  calls: string[];
  /** Method invocations with their arguments, for draw-content assertions. */
  events: FakeDomEvent[];
  /** Every canvas handed out, in creation order (sizes are final after drawing). */
  canvases: FakeCanvas[];
  restore: () => void;
}

type GlobalWithDocument = { document?: unknown };

export function installFakeDocument(): FakeDom {
  const target = globalThis as GlobalWithDocument;
  const original = target.document;
  const calls: string[] = [];
  const events: FakeDomEvent[] = [];
  const canvases: FakeCanvas[] = [];

  const createElement = (tag: string): unknown => {
    if (tag !== "canvas") {
      throw new Error(`fake document: unsupported element <${tag}>`);
    }
    const context = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property === "symbol") return undefined;
          return (...args: unknown[]): undefined => {
            calls.push(property);
            events.push({ method: property, args });
            return undefined;
          };
        },
        set: (_target, property) => {
          if (typeof property !== "symbol") calls.push(`set:${property}`);
          return true;
        },
      }
    );
    const canvas = {
      width: 0,
      height: 0,
      getContext: (kind: string): unknown => (kind === "2d" ? context : null),
    };
    canvases.push(canvas);
    return canvas;
  };

  target.document = { createElement };

  return {
    calls,
    events,
    canvases,
    restore: () => {
      if (original === undefined) delete target.document;
      else target.document = original;
    },
  };
}

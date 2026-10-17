/**
 * Collapsible sidebar sections: a localStorage-backed `ptp.collapsed` map
 * (section key → true while collapsed). Missing entries mean expanded, so a
 * fresh profile starts with every section open. The parse/write helpers are
 * pure; `CollapsedStore` is the only stateful piece and tolerates absent or
 * throwing storage (private mode, SSR, tests).
 */

export const COLLAPSED_STORAGE_KEY = "ptp.collapsed";

export type CollapsedMap = Readonly<Record<string, boolean>>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Tolerant parse of the stored map: only plain boolean entries survive. */
export function parseCollapsedMap(raw: string | null): CollapsedMap {
  if (raw === null || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const map: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") map[key] = value;
  }
  return map;
}

export function serializeCollapsedMap(map: CollapsedMap): string {
  return JSON.stringify(map);
}

/** New map with `key` collapsed or, when false, dropped entirely. */
export function withCollapsed(
  map: CollapsedMap,
  key: string,
  collapsed: boolean
): CollapsedMap {
  const next: Record<string, boolean> = { ...map };
  if (collapsed) {
    next[key] = true;
  } else {
    delete next[key];
  }
  return next;
}

/** Only `true` counts as collapsed: absent or false keeps a section open. */
export function isCollapsed(map: CollapsedMap, key: string): boolean {
  return map[key] === true;
}

/** `localStorage` when reachable; some privacy modes throw on access. */
export function safeLocalStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads and writes the shared `ptp.collapsed` map. Every storage access is
 * guarded, so a null/throwing storage degrades to an in-memory session map.
 */
export class CollapsedStore {
  private map: CollapsedMap;
  private readonly storage: StorageLike | null;

  constructor(storage: StorageLike | null) {
    this.storage = storage;
    this.map = this.read();
  }

  isCollapsed(key: string): boolean {
    return isCollapsed(this.map, key);
  }

  setCollapsed(key: string, collapsed: boolean): void {
    if (this.isCollapsed(key) === collapsed) return;
    this.map = withCollapsed(this.map, key, collapsed);
    this.write();
  }

  private read(): CollapsedMap {
    if (this.storage === null) return {};
    try {
      return parseCollapsedMap(this.storage.getItem(COLLAPSED_STORAGE_KEY));
    } catch {
      return {};
    }
  }

  private write(): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(
        COLLAPSED_STORAGE_KEY,
        serializeCollapsedMap(this.map)
      );
    } catch {
      // Quota or privacy-mode failures never break the UI.
    }
  }
}

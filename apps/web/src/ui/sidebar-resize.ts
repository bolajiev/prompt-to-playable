import { safeLocalStorage, type StorageLike } from "./collapsible.js";

/**
 * Sidebar resize handle: pointer drag and arrow-key resizing for the studio
 * divider. The width is clamped so the canvas never drops below
 * `CANVAS_MIN_WIDTH`, persisted under `ptp.sidebarWidth` and reported through
 * `onWidth` (the page writes the `--sidebar-width` CSS variable). Pure clamp /
 * parse helpers keep the arithmetic testable without a DOM.
 */

export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 640;
export const CANVAS_MIN_WIDTH = 320;
export const DEFAULT_SIDEBAR_WIDTH = 348;
export const SIDEBAR_KEYBOARD_STEP = 16;
export const SIDEBAR_WIDTH_STORAGE_KEY = "ptp.sidebarWidth";
/**
 * Fixed chrome around the two panes: #app padding (2×12), the two 12px grid
 * gaps that flank the handle and the 6px handle column itself.
 */
export const SIDEBAR_CHROME_WIDTH = 54;

/**
 * Clamps a sidebar width to the 280–640 band, additionally bounded by the
 * viewport so the canvas keeps at least 320px. When even that cannot fit, the
 * minimum sidebar width wins. Non-finite widths fall back to the minimum.
 */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const available = viewportWidth - CANVAS_MIN_WIDTH - SIDEBAR_CHROME_WIDTH;
  const max = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, available)
  );
  if (Number.isNaN(width)) return SIDEBAR_MIN_WIDTH;
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max));
}

/** Stored widths are plain positive numbers; anything else is "unset". */
export function parseStoredSidebarWidth(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export interface SidebarResizerOptions {
  /** Width storage; defaults to localStorage when available. */
  storage?: StorageLike | null;
  /** Live viewport width in CSS pixels (defaults to `innerWidth`). */
  viewportWidth?: () => number;
  /** Called with every applied (clamped) width. */
  onWidth?: (width: number) => void;
  /** Width used when nothing valid is stored. */
  initialWidth?: number;
}

/**
 * DOM controller for the vertical divider. Dragging tracks horizontal pointer
 * movement against the drag-origin width; arrow keys step by 16px (left grows
 * the sidebar, right shrinks it). Releases and keyboard steps persist.
 */
export class SidebarResizer {
  private currentWidth = DEFAULT_SIDEBAR_WIDTH;
  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartWidth = 0;

  private readonly storage: StorageLike | null;
  private readonly viewportWidth: () => number;
  private readonly onWidth: (width: number) => void;
  private readonly initialWidth: number;

  constructor(
    private readonly handle: HTMLElement,
    options: SidebarResizerOptions = {}
  ) {
    this.storage =
      options.storage === undefined ? safeLocalStorage() : options.storage;
    this.viewportWidth =
      options.viewportWidth ??
      (() => (typeof innerWidth === "number" ? innerWidth : 1280));
    this.onWidth = options.onWidth ?? (() => {});
    this.initialWidth = options.initialWidth ?? DEFAULT_SIDEBAR_WIDTH;

    const stored = parseStoredSidebarWidth(this.readStored());
    this.setWidth(stored ?? this.initialWidth, false);

    handle.addEventListener("pointerdown", this.handlePointerDown);
    handle.addEventListener("pointermove", this.handlePointerMove);
    handle.addEventListener("pointerup", this.handlePointerUp);
    handle.addEventListener("pointercancel", this.handlePointerCancel);
    handle.addEventListener("keydown", this.handleKeyDown);
  }

  get width(): number {
    return this.currentWidth;
  }

  /** Applies a clamped width now; `persist` also writes it to storage. */
  setWidth(width: number, persist = false): number {
    this.currentWidth = clampSidebarWidth(width, this.viewportWidth());
    this.handle.setAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
    this.handle.setAttribute("aria-valuemax", String(SIDEBAR_MAX_WIDTH));
    this.handle.setAttribute("aria-valuenow", String(this.currentWidth));
    this.onWidth(this.currentWidth);
    if (persist) this.persist();
    return this.currentWidth;
  }

  /** Re-clamps the live width after a viewport change (window resize). */
  clampToViewport(): number {
    const clamped = clampSidebarWidth(this.currentWidth, this.viewportWidth());
    return this.setWidth(clamped, clamped !== this.currentWidth);
  }

  destroy(): void {
    this.handle.removeEventListener("pointerdown", this.handlePointerDown);
    this.handle.removeEventListener("pointermove", this.handlePointerMove);
    this.handle.removeEventListener("pointerup", this.handlePointerUp);
    this.handle.removeEventListener("pointercancel", this.handlePointerCancel);
    this.handle.removeEventListener("keydown", this.handleKeyDown);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button > 0) return;
    event.preventDefault();
    this.dragPointerId = event.pointerId;
    this.dragStartX = event.clientX;
    this.dragStartWidth = this.currentWidth;
    this.handle.dataset.dragging = "true";
    try {
      this.handle.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is best-effort (synthetic or released pointers).
    }
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) {
      return;
    }
    const delta = event.clientX - this.dragStartX;
    this.setWidth(this.dragStartWidth - delta, false);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    this.endDrag(event);
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    this.endDrag(event);
  };

  private endDrag(event: PointerEvent): void {
    if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) {
      return;
    }
    this.dragPointerId = null;
    delete this.handle.dataset.dragging;
    try {
      this.handle.releasePointerCapture?.(event.pointerId);
    } catch {
      // Capture may already be gone; nothing to do.
    }
    this.persist();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const direction =
      event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    // Keep the arrow from also reaching the game input listeners on window.
    event.stopPropagation();
    this.setWidth(this.currentWidth + direction * SIDEBAR_KEYBOARD_STEP, true);
  };

  private readStored(): string | null {
    if (this.storage === null) return null;
    try {
      return this.storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(this.currentWidth)
      );
    } catch {
      // Quota or privacy-mode failures never break the UI.
    }
  }
}

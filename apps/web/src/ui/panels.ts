import type { PanelState } from "@prompt-to-playable/engine";

/** Display-only projection of an engine panel. */
export interface PanelViewModel {
  id: string;
  title: string;
  body: string;
}

/** Maps engine panel state to render data (stable field order, no extras). */
export function panelsToViewModel(
  panels: readonly PanelState[]
): PanelViewModel[] {
  return panels.map((panel) => ({
    id: panel.id,
    title: panel.title,
    body: panel.body,
  }));
}

export interface PanelsOptions {
  /** Called with the panel id when its close control is clicked. */
  onClose(id: string): void;
}

/**
 * Right-side panels overlay. A pure view over `state.ui.panels`: it renders a
 * card per panel and forwards close clicks to `onClose` (the app calls
 * `engine.closePanel`). Re-renders only when an id/title/body combination
 * changes, and hides itself when there are no panels.
 */
export class Panels {
  private signature: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: PanelsOptions
  ) {
    this.update([]);
  }

  update(panels: readonly PanelState[]): void {
    const view = panelsToViewModel(panels);
    const signature = view
      .map((panel) => `${panel.id}\u0000${panel.title}\u0000${panel.body}`)
      .join("\u0001");
    if (signature === this.signature) return;
    this.signature = signature;

    this.root.hidden = view.length === 0;
    const doc = this.root.ownerDocument;
    this.root.replaceChildren(...view.map((panel) => this.card(doc, panel)));
  }

  private card(doc: Document, panel: PanelViewModel): HTMLElement {
    const card = doc.createElement("article");
    card.className = "panel-card";
    card.dataset.panelId = panel.id;

    const head = doc.createElement("div");
    head.className = "panel-head";

    const title = doc.createElement("h3");
    title.className = "panel-title";
    title.textContent = panel.title;

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "panel-close";
    close.textContent = "×";
    close.setAttribute?.("aria-label", "Close panel");
    close.addEventListener("click", () => this.options.onClose(panel.id));

    head.append(title, close);

    const body = doc.createElement("p");
    body.className = "panel-body";
    body.textContent = panel.body;

    card.append(head, body);
    return card;
  }
}

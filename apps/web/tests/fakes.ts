import { vi } from "vitest";

/**
 * Minimal fake DOM node for testing view classes in the node environment.
 * Only the surface the UI modules actually touch is implemented.
 */
export class FakeNode {
  className = "";
  textContent = "";
  title = "";
  type = "";
  hidden = false;
  value = "";
  checked = false;
  min = "";
  max = "";
  step = "";
  disabled = false;
  placeholder = "";
  scrollTop = 0;
  scrollHeight = 0;
  isContentEditable = false;
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: FakeNode[] = [];
  readonly ownerDocument: FakeDocument;
  readonly blur = vi.fn();
  readonly focus = vi.fn();
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(ownerDocument: FakeDocument = new FakeDocument()) {
    this.ownerDocument = ownerDocument;
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  querySelector(): FakeNode | null {
    return null;
  }

  emit(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ preventDefault: () => {} });
    }
  }

  click(): void {
    this.emit("click");
  }

  find(className: string): FakeNode | undefined {
    return this.children.find((child) =>
      child.className.split(" ").includes(className)
    );
  }
}

export class FakeDocument {
  createElement(): FakeNode {
    return new FakeNode(this);
  }
}

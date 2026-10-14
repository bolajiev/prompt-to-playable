import { describe, expect, test, vi } from "vitest";
import type { PanelState } from "@prompt-to-playable/engine";
import { Panels, panelsToViewModel } from "../src/ui/panels.js";
import { FakeNode } from "./fakes.js";

const PANELS: PanelState[] = [
  { id: "p0", title: "Console", body: "The panel reads: power is low." },
  { id: "p1", title: "Robot", body: "Two arms, one missing bolt.", entity: "robot" },
];

describe("panelsToViewModel", () => {
  test("keeps id, title and body in order", () => {
    expect(panelsToViewModel(PANELS)).toEqual([
      { id: "p0", title: "Console", body: "The panel reads: power is low." },
      { id: "p1", title: "Robot", body: "Two arms, one missing bolt." },
    ]);
  });

  test("no panels maps to an empty list", () => {
    expect(panelsToViewModel([])).toEqual([]);
  });
});

function createHarness() {
  const root = new FakeNode();
  const onClose = vi.fn();
  const panels = new Panels(root as unknown as HTMLElement, { onClose });
  return { panels, root, onClose };
}

describe("Panels", () => {
  test("starts hidden and shows a card per panel", () => {
    const { panels, root } = createHarness();
    expect(root.hidden).toBe(true);

    panels.update(PANELS);
    expect(root.hidden).toBe(false);
    expect(root.children).toHaveLength(2);

    const [first, second] = root.children;
    expect(first.className).toBe("panel-card");
    expect(first.dataset.panelId).toBe("p0");
    expect(first.children[0]?.find("panel-title")?.textContent).toBe("Console");
    expect(first.children[1]?.className).toBe("panel-body");
    expect(first.children[1]?.textContent).toBe(
      "The panel reads: power is low."
    );
    expect(second.dataset.panelId).toBe("p1");
  });

  test("close clicks forward the panel id to onClose", () => {
    const { panels, root, onClose } = createHarness();
    panels.update(PANELS);

    const firstClose = root.children[0]?.children[0]?.find("panel-close");
    expect(firstClose?.textContent).toBe("×");
    firstClose?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("p0");

    const secondClose = root.children[1]?.children[0]?.find("panel-close");
    secondClose?.click();
    expect(onClose).toHaveBeenLastCalledWith("p1");
  });

  test("re-renders only when panel content changes", () => {
    const { panels, root } = createHarness();
    panels.update(PANELS);
    const originalCard = root.children[0];

    panels.update(PANELS);
    expect(root.children[0]).toBe(originalCard);

    panels.update([PANELS[0]!, { ...PANELS[1]!, body: "Changed" }]);
    expect(root.children[0]).not.toBe(originalCard);
    expect(root.children[1]?.children[1]?.textContent).toBe("Changed");
  });

  test("hides again when the last panel closes", () => {
    const { panels, root } = createHarness();
    panels.update(PANELS);
    panels.update([PANELS[0]!]);
    expect(root.hidden).toBe(false);
    expect(root.children).toHaveLength(1);

    panels.update([]);
    expect(root.hidden).toBe(true);
    expect(root.children).toHaveLength(0);
  });
});

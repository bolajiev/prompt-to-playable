import type { GameState } from "@prompt-to-playable/engine";

const STATUS_LABEL: Record<string, string> = {
  active: "in progress",
  done: "done",
  failed: "failed",
};

/** Copy shown instead of an objective list for explore-style scenes. */
export const EXPLORE_HINT =
  "Explore freely — WASD move · Space jump · drag to orbit";

/** Pure explore-HUD decision: zero objectives means a free-roam scene. */
export function exploreHint(objectiveCount: number): string | null {
  return objectiveCount === 0 ? EXPLORE_HINT : null;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function objectiveLabel(objective: GameState["objectives"][number]): string {
  if (objective.description) return objective.description;
  const target = objective.target ?? objective.targets?.join(", ");
  const base = target ? `${objective.type}: ${target}` : objective.type;
  return base;
}

function objectiveProgress(
  objective: GameState["objectives"][number]
): string | null {
  if (typeof objective.count === "number") {
    return `${objective.progress}/${objective.count}`;
  }
  if (objective.progress > 0) {
    return String(objective.progress);
  }
  return null;
}

/**
 * HUD renderer. Pure view over an immutable engine snapshot: it never mutates
 * the state it is given and never touches engine internals.
 */
export class Hud {
  constructor(private readonly root: HTMLElement) {
    this.update(null);
  }

  update(state: GameState | null): void {
    const doc = this.root.ownerDocument;
    this.root.replaceChildren();

    if (!state) {
      const empty = doc.createElement("p");
      empty.className = "hud-empty";
      empty.textContent = "No game loaded yet. Describe one to begin.";
      this.root.append(empty);
      this.root.dataset.status = "empty";
      return;
    }

    this.root.dataset.status = state.status;

    const title = doc.createElement("h2");
    title.className = "hud-title";
    title.textContent = state.doc.meta.title;
    this.root.append(title);

    const archetype = doc.createElement("p");
    archetype.className = "hud-sub";
    archetype.textContent = state.doc.meta.archetype;
    this.root.append(archetype);

    const meta = doc.createElement("p");
    meta.className = "hud-meta";
    meta.textContent = `Time: ${formatSeconds(state.time)}`;
    this.root.append(meta);

    const hint = exploreHint(state.objectives.length);
    if (hint !== null) {
      const explore = doc.createElement("p");
      explore.className = "hud-empty explore-hint";
      explore.textContent = hint;
      this.root.append(explore);
    } else {
      const list = doc.createElement("ul");
      list.className = "objectives";
      for (const objective of state.objectives) {
        const item = doc.createElement("li");
        item.className = `objective ${objective.status}`;
        item.dataset.objectiveId = objective.id;

        const label = doc.createElement("span");
        label.textContent = objectiveLabel(objective);
        item.append(label);

        const right = doc.createElement("span");
        right.className = "progress";
        const progress = objectiveProgress(objective);
        const status = STATUS_LABEL[objective.status] ?? objective.status;
        right.textContent = progress ? `${progress} \u00b7 ${status}` : status;
        item.append(right);

        list.append(item);
      }
      this.root.append(list);
    }

    if (state.status === "won" || state.status === "lost") {
      const banner = doc.createElement("div");
      banner.className = `banner ${state.status}`;
      banner.textContent = state.status === "won" ? "You win!" : "Game over";
      this.root.append(banner);
    }
  }
}

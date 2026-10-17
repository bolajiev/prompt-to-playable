export type ExampleKind =
  | "world"
  | "collect-a-thon"
  | "puzzle-switch"
  | "platformer-lite"
  | "stealth-chase"
  | "explore"
  | "inspect"
  | "walkthrough"
  | "drive"
  | "animated";

export interface ExamplePrompt {
  readonly id: string;
  readonly kind: ExampleKind;
  readonly label: string;
  readonly prompt: string;
}

/**
 * Chip ordering: world first (the free-form "Surprise me" prompt exercises the
 * world default), then the machine-family kits (inspect, animated parts), then
 * the game archetypes, the explore scene and the remaining interactive kits
 * (walkthrough, drive). Pure data so the chip row, tests and docs share a
 * single source.
 */
export const EXAMPLE_PROMPTS: readonly ExamplePrompt[] = [
  {
    id: "surprise",
    kind: "world",
    label: "Surprise me",
    prompt:
      "surprise me: build an open world with something unexpected I can explore and control",
  },
  {
    id: "pcb",
    kind: "inspect",
    label: "Inspect a 3D PCB",
    prompt: "a 3D PCB I can click and inspect",
  },
  {
    id: "robot",
    kind: "animated",
    label: "Animated robot",
    prompt: "a robot with animated arms",
  },
  {
    id: "collect",
    kind: "collect-a-thon",
    label: "Collect crystals",
    prompt: "a room where I collect 3 glowing crystals while avoiding one guard",
  },
  {
    id: "switch",
    kind: "puzzle-switch",
    label: "Switch puzzle",
    prompt: "puzzle room: activate three switches to open the exit",
  },
  {
    id: "platformer",
    kind: "platformer-lite",
    label: "Platform course",
    prompt: "a platforming course with moving hazards to reach the door",
  },
  {
    id: "stealth",
    kind: "stealth-chase",
    label: "Sneak past guards",
    prompt: "sneak past patrolling guards to the exit",
  },
  {
    id: "explore",
    kind: "explore",
    label: "Explore a clearing",
    prompt: "a quiet forest clearing with a campfire at dusk",
  },
  {
    id: "house",
    kind: "walkthrough",
    label: "Walk through a house",
    prompt: "a house I can walk through",
  },
  {
    id: "race",
    kind: "drive",
    label: "Race a car",
    prompt: "a car racing game",
  },
];

export interface OnboardingElements {
  /** Container the example chips are rendered into. */
  examples: HTMLElement;
  /** First-run describe → play → refine overlay. */
  emptyState: HTMLElement;
}

export interface OnboardingOptions {
  /** Called with the full prompt when a chip is picked; the app submits it. */
  onPick(prompt: string): void;
}

/**
 * First-run onboarding: renders the example chips and owns the empty-state
 * overlay. Pure DOM view — picks are forwarded to `onPick`, which the app
 * turns into an immediate submit, so one click starts a demo generation.
 */
export class Onboarding {
  private busy = false;
  private completed = false;

  constructor(
    private readonly elements: OnboardingElements,
    private readonly options: OnboardingOptions
  ) {
    this.renderChips();
  }

  /** Hides the overlay while a request is in flight; restores it on failure. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.sync();
  }

  /** Permanently hides the overlay once the first game has loaded. */
  complete(): void {
    this.completed = true;
    this.sync();
  }

  private sync(): void {
    this.elements.emptyState.hidden = this.completed || this.busy;
  }

  private renderChips(): void {
    const doc = this.elements.examples.ownerDocument;
    for (const example of EXAMPLE_PROMPTS) {
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = example.label;
      chip.title = example.prompt;
      chip.dataset.exampleId = example.id;
      chip.addEventListener("click", () => this.options.onPick(example.prompt));
      this.elements.examples.append(chip);
    }
  }
}

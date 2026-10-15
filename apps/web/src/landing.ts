import "./styles/tokens.css";
import "./styles/landing.css";
import { studioHref } from "./studio-link.js";

/**
 * The head script arms a timeout that force-reveals `.reveal` elements if this
 * module never finishes loading. Loading successfully cancels it, so the
 * scroll animation only depends on the timer whenever it is genuinely needed.
 */
function cancelRevealFailSafe(): void {
  const scope = globalThis as { __revealFailSafe?: number };
  if (scope.__revealFailSafe === undefined) return;
  clearTimeout(scope.__revealFailSafe);
  delete scope.__revealFailSafe;
}

/** Points every `[data-prompt]` chip at the studio with the prompt prefilled. */
function applyPromptLinks(): void {
  for (const chip of document.querySelectorAll<HTMLAnchorElement>(
    "[data-prompt]"
  )) {
    const prompt = chip.dataset.prompt ?? "";
    if (prompt.trim().length > 0) chip.href = studioHref(prompt);
  }
}

/** Fade-up on scroll; elements outside the viewport start hidden via `.js`. */
function setupReveal(): void {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reducedMotion || typeof IntersectionObserver === "undefined") {
    for (const element of elements) element.classList.add("is-visible");
    return;
  }

  const pending = new Set<HTMLElement>(elements);
  const reveal = (element: HTMLElement): void => {
    element.classList.add("is-visible");
    observer.unobserve(element);
    pending.delete(element);
  };
  /**
   * Anchors and fast jumps can scroll an element from below the fold to above
   * it without ever intersecting, so no callback fires for it. Once any
   * observed element moves, reveal every pending element that is no longer
   * below the fold.
   */
  const sweep = (): void => {
    const limit = window.innerHeight * 0.95;
    for (const element of [...pending]) {
      if (element.getBoundingClientRect().top <= limit) reveal(element);
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) reveal(entry.target as HTMLElement);
      }
      sweep();
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );

  for (const element of elements) observer.observe(element);
}

/**
 * The secondary hero CTA is a plain link to `/demo.mp4` (works with JS off);
 * with JS it opens the bundled 66-second demo in a native <dialog> player.
 */
function setupDemoModal(): void {
  const trigger = document.querySelector<HTMLAnchorElement>("#demo-open");
  const dialog = document.querySelector<HTMLDialogElement>("#demo-dialog");
  if (trigger === null || dialog === null) return;
  if (typeof dialog.showModal !== "function") return;

  const video = dialog.querySelector<HTMLVideoElement>("#demo-video");
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (!dialog.open) dialog.showModal();
  });
  dialog.querySelector("#demo-close")?.addEventListener("click", () => {
    dialog.close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (video !== null) {
      video.pause();
      video.currentTime = 0;
    }
  });
}

applyPromptLinks();
setupReveal();
setupDemoModal();
cancelRevealFailSafe();

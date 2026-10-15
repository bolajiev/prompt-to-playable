import "./styles/tokens.css";
import "./styles/landing.css";
import { studioHref } from "./studio-link.js";

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

applyPromptLinks();
setupReveal();

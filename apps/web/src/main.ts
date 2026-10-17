import "./styles/tokens.css";
import "./styles/studio.css";
import { createApp } from "./app.js";
import { SidebarResizer } from "./ui/sidebar-resize.js";

const app = createApp();
app.start();

/**
 * Wires the vertical divider: restores the persisted sidebar width, mirrors it
 * onto the `--sidebar-width` grid column and re-clamps on viewport changes.
 * The canvas follows through the App's ResizeObserver.
 */
function setupSidebarResize(): void {
  const handle = document.querySelector<HTMLElement>("#sidebar-resize");
  const root = document.querySelector<HTMLElement>("#app");
  if (handle === null || root === null) return;

  const resizer = new SidebarResizer(handle, {
    onWidth: (width) => root.style.setProperty("--sidebar-width", `${width}px`),
  });
  globalThis.addEventListener("resize", () => resizer.clampToViewport());
}

setupSidebarResize();

/**
 * Landing chips deep-link as `/app.html?prompt=<text>`. Once the app is wired
 * (so the chat already listens for submits), prefill the composer and submit
 * it — one click from the landing page to a live generation. Audio is only
 * ever unlocked by a user gesture, so this never autoplays sound.
 */
function submitPreloadedPrompt(): void {
  const search =
    typeof globalThis.location === "undefined" ? "" : globalThis.location.search;
  const prompt = new URLSearchParams(search).get("prompt");
  if (prompt === null || prompt.trim().length === 0) return;

  const input = document.querySelector<HTMLInputElement>("#chat-input");
  const form = document.querySelector<HTMLFormElement>("#chat-form");
  if (input === null || form === null) return;

  input.value = prompt;
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
  } else {
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }
  clearPromptParam();
}

/**
 * Drops `?prompt=` after submitting so a reload or back-navigation cannot
 * re-fire a live generation from the stale query string.
 */
function clearPromptParam(): void {
  const history = globalThis.history;
  if (typeof history?.replaceState !== "function") return;
  const params = new URLSearchParams(globalThis.location.search);
  if (!params.has("prompt")) return;
  params.delete("prompt");
  const query = params.toString();
  const suffix = query.length > 0 ? `?${query}` : "";
  history.replaceState(
    null,
    "",
    `${globalThis.location.pathname}${suffix}${globalThis.location.hash}`
  );
}

submitPreloadedPrompt();

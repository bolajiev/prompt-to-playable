import "./styles/tokens.css";
import "./styles/studio.css";
import { createApp } from "./app.js";

const app = createApp();
app.start();

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
}

submitPreloadedPrompt();

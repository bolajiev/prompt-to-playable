/**
 * Studio deep link. Pure so the landing page, tests and any future share
 * surface all agree on one URL shape: `/app.html?prompt=<urlencoded>`.
 *
 * The studio bootstrap (main.ts) reads `?prompt=` and submits it once the app
 * is wired, which makes every landing chip a one-click demo.
 */
export function studioHref(prompt: string): string {
  return `/app.html?prompt=${encodeURIComponent(prompt)}`;
}

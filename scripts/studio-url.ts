/**
 * Studio page URL resolution shared by the QA and demo scripts.
 *
 * The site has two pages: the landing at `/` (`index.html`) and the studio at
 * `/app.html`. Scripts take a `<url>` argument that may be a bare host root
 * (`http://localhost:3312`) or a full page URL. A root or empty path is
 * normalized to the studio page; any explicit path (`.html` or otherwise) is
 * used as-is so callers can point a run at a specific page.
 */

export const STUDIO_PAGE = "app.html";

/** Root/empty paths become `/app.html`; query strings and hashes survive. */
export function normalizeStudioUrl(input: string): string {
  const url = new URL(input);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = `/${STUDIO_PAGE}`;
  }
  return url.toString();
}

/** Origin root of a (possibly page) URL, e.g. `http://host:3312/`. */
export function landingUrl(input: string): string {
  return new URL("/", input).toString();
}

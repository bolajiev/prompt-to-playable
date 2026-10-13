import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Browsers cache root, mirroring Playwright's default resolution. */
export function playwrightBrowsersRoot(): string {
  return (
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), ".cache", "ms-playwright")
  );
}

interface BrowserRecord {
  name: string;
  revision: string;
}

function expectedRevisions(): Map<string, string> {
  const revisions = new Map<string, string>();
  try {
    const coreEntry = require.resolve("playwright-core");
    const browsersJson = join(dirname(coreEntry), "browsers.json");
    const parsed = JSON.parse(readFileSync(browsersJson, "utf8")) as {
      browsers: BrowserRecord[];
    };
    for (const browser of parsed.browsers) {
      revisions.set(browser.name, browser.revision);
    }
  } catch {
    // No installed metadata: fall back to scanning the cache below.
  }
  return revisions;
}

function candidatesFor(root: string, revision: string): string[] {
  return [
    join(
      root,
      `chromium_headless_shell-${revision}`,
      "chrome-headless-shell-linux64",
      "chrome-headless-shell"
    ),
    join(root, `chromium-${revision}`, "chrome-linux64", "chrome"),
    join(root, `chromium-${revision}`, "chrome-linux", "chrome"),
  ];
}

function newestCachedRevision(root: string, prefix: string): string | undefined {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let newest: number | undefined;
  for (const entry of readdirSync(root)) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const revision = Number(match[1]);
    if (newest === undefined || revision > newest) newest = revision;
  }
  return newest === undefined ? undefined : String(newest);
}

/**
 * Resolves a cached Chromium executable under `/root/.cache/ms-playwright`
 * (or `PLAYWRIGHT_BROWSERS_PATH`) so QA can launch even when Playwright's own
 * download step was unavailable. Prefers the revision matching the installed
 * `playwright-core`; otherwise falls back to the newest cached build.
 * Returns `undefined` to let Playwright resolve/download a browser itself.
 */
export function resolveChromiumExecutable(): string | undefined {
  const root = playwrightBrowsersRoot();
  if (!existsSync(root)) return undefined;

  const expected = expectedRevisions();
  const revisions = new Set<string>();
  for (const name of ["chromium", "chromium-headless-shell"]) {
    const revision = expected.get(name);
    if (revision) revisions.add(revision);
  }
  if (revisions.size === 0) {
    for (const prefix of ["chromium", "chromium_headless_shell"]) {
      const revision = newestCachedRevision(root, prefix);
      if (revision) revisions.add(revision);
    }
  }

  for (const revision of revisions) {
    for (const candidate of candidatesFor(root, revision)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

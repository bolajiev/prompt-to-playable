import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import {
  DEFAULT_PORT,
  buildApp,
  resolvePort,
  startServer,
} from "../src/index.js";

const INDEX_HTML =
  '<!doctype html><html><body><div id="spa-root">spa-index</div></body></html>';

let tempRoot: string;
let webDist: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "web-dist-"));
  webDist = join(tempRoot, "dist");
  mkdirSync(webDist);
  writeFileSync(join(webDist, "index.html"), INDEX_HTML, "utf8");
  writeFileSync(join(webDist, "asset.txt"), "static-asset-body", "utf8");
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("production static serving", () => {
  test("GET /healthz returns {status:'ok'}", async () => {
    const res = await request(buildApp({}, { webDist })).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  test("serves plain assets from webDist", async () => {
    const res = await request(buildApp({}, { webDist })).get("/asset.txt");
    expect(res.status).toBe(200);
    expect(res.text).toBe("static-asset-body");
  });

  test("serves index.html for the root", async () => {
    const res = await request(buildApp({}, { webDist })).get("/");
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toBe(INDEX_HTML);
  });

  test("falls back to index.html for unknown SPA routes", async () => {
    const res = await request(buildApp({}, { webDist })).get("/some/spa/route");
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toBe(INDEX_HTML);
  });

  test("resolves a relative webDist against process.cwd() for SPA routes", async () => {
    const relRoot = mkdtempSync(join(process.cwd(), "web-dist-rel-"));
    try {
      const relWebDist = join(basename(relRoot), "dist");
      mkdirSync(join(relRoot, "dist"));
      writeFileSync(join(relRoot, "dist", "index.html"), INDEX_HTML, "utf8");

      const res = await request(buildApp({}, { webDist: relWebDist })).get(
        "/some/spa/route"
      );
      expect(res.status).toBe(200);
      expect(res.type).toBe("text/html");
      expect(res.text).toBe(INDEX_HTML);
    } finally {
      rmSync(relRoot, { recursive: true, force: true });
    }
  });

  test("keeps API routes out of the SPA fallback", async () => {
    const app = buildApp({}, { webDist });

    const get = await request(app).get("/generate");
    expect(get.status).toBe(404);
    expect(get.type).toBe("application/json");
    expect(get.body.error).toBe("NOT_FOUND");

    const post = await request(app).post("/generate").send({});
    expect(post.status).toBe(400);
    expect(post.body.error).toBe("INVALID_REQUEST");
  });

  test("serves the API without a webDist (Vercel-style function)", async () => {
    const res = await request(buildApp({})).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("PORT validation", () => {
  test("defaults when PORT is unset or blank", () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
    expect(resolvePort("")).toBe(DEFAULT_PORT);
    expect(resolvePort("   ")).toBe(DEFAULT_PORT);
  });

  test("parses a valid numeric PORT", () => {
    expect(resolvePort("3210")).toBe(3210);
  });

  test.each(["abc", "-1", "70000", "12.5", "Infinity", "NaN"])(
    "rejects invalid PORT %j with a clear message",
    (raw) => {
      expect(() => resolvePort(raw)).toThrowError(/PORT/);
    }
  );

  test("startServer throws before listening when PORT is invalid", () => {
    const previous = process.env.PORT;
    process.env.PORT = "definitely-not-a-port";
    try {
      expect(() => startServer({})).toThrowError(/PORT/);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});

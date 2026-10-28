import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.teardown();
  ctx = undefined!;
});

describe("one service for API and web app", () => {
  it("answers the API under /api too, as the web app calls it", async () => {
    ctx = await setup();
    const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("serves the web app for client-side routes and keeps API errors as JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-web-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Relay</title>");
    ctx = await setup({ webDir: dir });

    const page = await ctx.app.inject({ method: "GET", url: "/inbox/123", headers: { accept: "text/html" } });
    const api = await ctx.app.inject({ method: "GET", url: "/api/nope", headers: { accept: "application/json" } });
    expect(page.body).toContain("<title>Relay</title>");
    expect([api.statusCode, api.json()]).toEqual([404, { error: "Not found" }]);
  });
});

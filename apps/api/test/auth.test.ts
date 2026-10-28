import { afterEach, describe, expect, it } from "vitest";
import { seedDemo } from "../src/seed.js";
import { setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.teardown();
  ctx = undefined!;
});

describe("sign in", () => {
  it("gives the same answer for an unknown email and a wrong password", async () => {
    ctx = await setup();
    const unknown = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { email: "nobody@relay.test", password: "whatever1" } });
    const wrong = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { email: "ana@relay.test", password: "wrong-pass" } });
    expect([unknown.statusCode, wrong.statusCode]).toEqual([401, 401]);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("only offers the demo login when demo mode is on", async () => {
    ctx = await setup();
    expect((await ctx.app.inject({ method: "POST", url: "/auth/demo" })).statusCode).toBe(404);
    await ctx.teardown();

    ctx = await setup({ demo: true });
    await seedDemo(ctx.db, ctx.clock.now());
    const res = await ctx.app.inject({ method: "POST", url: "/auth/demo" });
    expect(res.statusCode).toBe(200);
    const inbox = await ctx.app.inject({ method: "GET", url: "/conversations", headers: { authorization: `Bearer ${res.json().token}` } });
    expect(inbox.json()).toHaveLength(2);
  });

  it("seeds the demo only once", async () => {
    ctx = await setup({ demo: true });
    expect(await seedDemo(ctx.db, ctx.clock.now())).toBe(true);
    expect(await seedDemo(ctx.db, ctx.clock.now())).toBe(false);
  });
});

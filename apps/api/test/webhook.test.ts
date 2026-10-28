import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { messages } from "../src/db/schema.js";
import { createWhatsAppChannel, parseInbound, verifyMetaSignature } from "../src/channels/whatsapp.js";
import { ChannelError } from "../src/channels/channel.js";
import { setup } from "./helpers.js";

const APP_SECRET = "meta-app-secret";
const whatsapp = { appSecret: APP_SECRET, verifyToken: "my-verify-token" };

// The shape Meta sends for an incoming text message.
const payload = (id: string, body: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            contacts: [{ wa_id: "5547988887777", profile: { name: "Luiza" } }],
            messages: [{ from: "5547988887777", id, timestamp: "1772452800", type: "text", text: { body } }],
          },
        },
      ],
    },
  ],
});

const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.teardown();
  ctx = undefined!;
});

const post = (raw: string, signature?: string) =>
  ctx.app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    payload: raw,
  });

describe("WhatsApp webhook", () => {
  it("answers Meta's verification challenge only with the right token", async () => {
    ctx = await setup({ whatsapp });
    const ok = await ctx.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=my-verify-token&hub.challenge=12345" });
    const bad = await ctx.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345" });
    expect([ok.statusCode, ok.body]).toEqual([200, "12345"]);
    expect(bad.statusCode).toBe(403);
  });

  it("rejects requests without a valid signature", async () => {
    ctx = await setup({ whatsapp });
    const raw = JSON.stringify(payload("wamid.1", "hi"));
    expect((await post(raw)).statusCode).toBe(401);
    expect((await post(raw, sign(raw, "someone-else"))).statusCode).toBe(401);
    // signed body, then tampered with
    expect((await post(raw.replace("hi", "hacked"), sign(raw))).statusCode).toBe(401);
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
  });

  it("stores a signed message once, even when Meta delivers it twice", async () => {
    ctx = await setup({ whatsapp });
    const raw = JSON.stringify(payload("wamid.ABC", "Do you accept Pix?"));
    expect((await post(raw, sign(raw))).statusCode).toBe(200);
    expect((await post(raw, sign(raw))).statusCode).toBe(200);
    await ctx.worker.drain();

    const stored = await ctx.db.select().from(messages);
    expect(stored.filter((m) => m.direction === "in").map((m) => m.body)).toEqual(["Do you accept Pix?"]);
    // and it was answered once
    expect(ctx.sent).toEqual([{ to: "5547988887777", body: "Sure!" }]);
  });

  it("is off when WhatsApp is not configured", async () => {
    ctx = await setup();
    const raw = JSON.stringify(payload("wamid.1", "hi"));
    expect((await post(raw, sign(raw))).statusCode).toBe(404);
  });
});

describe("parsing and signatures", () => {
  it("keeps text messages and ignores status updates and media", () => {
    const status = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.9", status: "read" }] } }] }] };
    const image = { entry: [{ changes: [{ value: { messages: [{ from: "5547900000000", id: "wamid.8", type: "image" }] } }] }] };
    expect(parseInbound(payload("wamid.7", "hello"))).toEqual([{ phone: "5547988887777", name: "Luiza", body: "hello", externalId: "wamid.7" }]);
    expect(parseInbound(status)).toEqual([]);
    expect(parseInbound(image)).toEqual([]);
    expect(parseInbound(null)).toEqual([]);
  });

  it("checks the signature over the exact bytes", () => {
    expect(verifyMetaSignature("{}", sign("{}"), APP_SECRET)).toBe(true);
    expect(verifyMetaSignature("{ }", sign("{}"), APP_SECRET)).toBe(false);
    expect(verifyMetaSignature("{}", "sha256=abc", APP_SECRET)).toBe(false);
    expect(verifyMetaSignature("{}", undefined, APP_SECRET)).toBe(false);
  });
});

describe("WhatsApp Cloud API channel", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("sends a text message and returns WhatsApp's id", async () => {
    let request: { url: string; body: unknown } | null = null;
    const channel = createWhatsAppChannel({
      token: "t",
      phoneNumberId: "123",
      fetch: (async (url: string, init: RequestInit) => {
        request = { url, body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await channel.send("5547900000000", "Hello!")).toEqual({ externalId: "wamid.OUT" });
    expect(request).toEqual({
      url: "https://graph.facebook.com/v21.0/123/messages",
      body: { messaging_product: "whatsapp", to: "5547900000000", type: "text", text: { body: "Hello!" } },
    });
  });

  it("marks rate limits and server errors as retryable, and bad requests as not", async () => {
    const attempt = (status: number) =>
      createWhatsAppChannel({ token: "t", phoneNumberId: "1", fetch: respond(status, { error: { message: "x" } }) })
        .send("5547900000000", "hi")
        .catch((e: ChannelError) => e.retryable);
    expect(await attempt(429)).toBe(true);
    expect(await attempt(503)).toBe(true);
    expect(await attempt(400)).toBe(false);
    expect(await attempt(401)).toBe(false);
  });
});

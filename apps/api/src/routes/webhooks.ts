import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { EventBus } from "../core/events.js";
import { ingestInbound, type Clock } from "../core/conversations.js";
import { parseInbound, verifyMetaSignature } from "../channels/whatsapp.js";

export type WhatsAppConfig = { appSecret: string; verifyToken: string };

// Endpoint registered in the Meta developer dashboard for the WhatsApp Cloud API.
export async function webhookRoutes(app: FastifyInstance, db: Db, bus: EventBus, now: Clock, debounceMs: number, config: WhatsAppConfig | null) {
  // The signature is computed over the exact bytes Meta sent, so this scope keeps the
  // body as a raw string and parses the JSON only after checking it.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  // Meta calls this once when the webhook is registered, to confirm we own the URL.
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (config && q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.verifyToken) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send({ error: "Verification failed" });
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    if (!config) return reply.code(404).send({ error: "WhatsApp is not configured" });
    const raw = typeof req.body === "string" ? req.body : "";
    if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, config.appSecret)) {
      return reply.code(401).send({ error: "Invalid signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "Invalid JSON" });
    }

    // Only cheap database writes happen here; the AI runs later in the worker.
    // Meta expects a fast 200 and retries the delivery otherwise.
    for (const msg of parseInbound(payload)) {
      await ingestInbound(db, bus, msg, now(), debounceMs);
    }
    return reply.code(200).send({ ok: true });
  });
}

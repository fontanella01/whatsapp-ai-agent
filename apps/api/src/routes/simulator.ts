import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { contacts, conversations, messages } from "../db/schema.js";
import type { EventBus } from "../core/events.js";
import { ingestInbound, type Clock } from "../core/conversations.js";

const sendSchema = z.object({
  phone: z.string().regex(/^[0-9]{8,15}$/, "Phone with country code, digits only"),
  name: z.string().trim().min(1).max(80).nullable().default(null),
  body: z.string().trim().min(1).max(4096),
});
const threadQuery = z.object({ phone: z.string().regex(/^[0-9]{8,15}$/) });

// The phone simulator: plays the customer's side. Messages go through exactly the
// same path as a real WhatsApp webhook (ingestInbound), just without Meta.
export function simulatorRoutes(app: FastifyInstance, db: Db, bus: EventBus, now: Clock, debounceMs: number) {
  app.addHook("preHandler", app.authenticate);

  app.post("/simulator/messages", async (req, reply) => {
    const body = sendSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    const result = await ingestInbound(db, bus, { ...body.data, externalId: `sim-in-${randomUUID()}` }, now(), debounceMs);
    return reply.code(201).send(result);
  });

  // What the customer sees on their phone.
  app.get("/simulator/thread", async (req, reply) => {
    const q = threadQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid phone" });
    const [row] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(contacts.phone, q.data.phone));
    if (!row) return { conversationId: null, messages: [] };
    const thread = await db.select().from(messages).where(eq(messages.conversationId, row.id)).orderBy(asc(messages.seq));
    return { conversationId: row.id, messages: thread };
  });
}

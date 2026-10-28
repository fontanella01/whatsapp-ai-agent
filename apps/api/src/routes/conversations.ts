import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { contacts, conversations, messages, MODES, STATUSES } from "../db/schema.js";
import type { EventBus } from "../core/events.js";
import { conversationView, queueOutbound, type Clock } from "../core/conversations.js";

const idParam = z.object({ id: z.uuid() });
const listQuery = z.object({ status: z.enum(STATUSES).default("open"), mode: z.enum(MODES).optional() });
const sendSchema = z.object({ body: z.string().trim().min(1).max(4096) });

// The agents' inbox. Every route requires a signed-in agent.
export function conversationRoutes(app: FastifyInstance, db: Db, bus: EventBus, now: Clock) {
  app.addHook("preHandler", app.authenticate);

  const publish = async (id: string) => {
    const view = await conversationView(db, id);
    if (view) bus.publish({ type: "conversation", conversation: view });
    return view;
  };

  app.get("/conversations", async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: z.prettifyError(q.error) });
    const filters: SQL[] = [eq(conversations.status, q.data.status)];
    if (q.data.mode) filters.push(eq(conversations.mode, q.data.mode));
    const rows = await db
      .select({ conversation: conversations, contact: { id: contacts.id, phone: contacts.phone, name: contacts.name } })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(...filters))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(200);

    // last message of each conversation, for the preview line in the list
    const previews = await Promise.all(
      rows.map(async (r) => {
        const [last] = await db
          .select({ body: messages.body, sender: messages.sender })
          .from(messages)
          .where(eq(messages.conversationId, r.conversation.id))
          .orderBy(desc(messages.seq))
          .limit(1);
        return { ...r.conversation, contact: r.contact, lastMessage: last ?? null };
      }),
    );
    return previews;
  });

  app.get("/conversations/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Conversation not found" });
    const view = await conversationView(db, p.data.id);
    if (!view) return reply.code(404).send({ error: "Conversation not found" });
    const thread = await db.select().from(messages).where(eq(messages.conversationId, view.id)).orderBy(asc(messages.seq));
    return { ...view, messages: thread };
  });

  // An agent writes to the customer. If the AI was in charge, the agent takes over:
  // two voices answering at once would confuse the customer.
  app.post("/conversations/:id/messages", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Conversation not found" });
    const body = sendSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Write a message first" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, p.data.id));
    if (!conv) return reply.code(404).send({ error: "Conversation not found" });

    if (conv.mode === "ai" || conv.status === "closed") {
      await db
        .update(conversations)
        .set({ mode: "human", status: "open", assigneeId: req.user.sub, handoffReason: conv.handoffReason ?? "Taken over by an agent" })
        .where(eq(conversations.id, conv.id));
      await publish(conv.id);
    }
    const message = await queueOutbound(db, bus, { conversationId: conv.id, sender: "agent", authorId: req.user.sub, body: body.data.body }, now());
    return reply.code(201).send(message);
  });

  app.post("/conversations/:id/takeover", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Conversation not found" });
    const [updated] = await db
      .update(conversations)
      .set({ mode: "human", assigneeId: req.user.sub, handoffReason: "Taken over by an agent" })
      .where(eq(conversations.id, p.data.id))
      .returning();
    if (!updated) return reply.code(404).send({ error: "Conversation not found" });
    return publish(updated.id);
  });

  // Gives the conversation back to the AI, which answers the next customer message.
  app.post("/conversations/:id/release", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Conversation not found" });
    const [updated] = await db
      .update(conversations)
      .set({ mode: "ai", assigneeId: null, handoffReason: null })
      .where(eq(conversations.id, p.data.id))
      .returning();
    if (!updated) return reply.code(404).send({ error: "Conversation not found" });
    return publish(updated.id);
  });

  app.post("/conversations/:id/close", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Conversation not found" });
    const [updated] = await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, p.data.id)).returning();
    if (!updated) return reply.code(404).send({ error: "Conversation not found" });
    return publish(updated.id);
  });
}

import { and, desc, eq, sql, TransactionRollbackError } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contacts, conversations, messages, type Message, type Sender } from "../db/schema.js";
import type { ConversationView, EventBus } from "./events.js";
import { enqueueReply, enqueueSend } from "./queue.js";

export type Clock = () => Date;

export async function conversationView(db: Db, id: string): Promise<ConversationView | undefined> {
  const [row] = await db
    .select({ conversation: conversations, contact: { id: contacts.id, phone: contacts.phone, name: contacts.name } })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, id));
  return row && { ...row.conversation, contact: row.contact };
}

// A customer message arrives (from Meta's webhook or the simulator).
// Saved, de-duplicated by WhatsApp id, and an AI reply scheduled if the AI is in
// charge. Nothing slow happens here, so the webhook can answer Meta right away.
export async function ingestInbound(
  db: Db,
  bus: EventBus,
  input: { phone: string; name: string | null; body: string; externalId: string },
  now: Date,
  debounceMs: number,
): Promise<{ duplicate: boolean; conversationId: string }> {
  const result = await db.transaction(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({ phone: input.phone, name: input.name, createdAt: now })
      .onConflictDoUpdate({ target: contacts.phone, set: { name: sql`coalesce(excluded.name, ${contacts.name})` } })
      .returning();

    // a closed conversation reopens with the AI in charge again
    const [conversation] = await tx
      .insert(conversations)
      .values({ contactId: contact.id, lastMessageAt: now, createdAt: now })
      .onConflictDoUpdate({
        target: conversations.contactId,
        set: {
          lastMessageAt: now,
          status: "open",
          mode: sql`CASE WHEN ${conversations.status} = 'closed' THEN 'ai' ELSE ${conversations.mode} END`,
          handoffReason: sql`CASE WHEN ${conversations.status} = 'closed' THEN NULL ELSE ${conversations.handoffReason} END`,
          assigneeId: sql`CASE WHEN ${conversations.status} = 'closed' THEN NULL ELSE ${conversations.assigneeId} END`,
        },
      })
      .returning();

    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        direction: "in",
        sender: "customer",
        body: input.body.slice(0, 4096),
        externalId: input.externalId,
        delivery: "received",
        createdAt: now,
      })
      .onConflictDoNothing({ target: messages.externalId })
      .returning();

    if (!message) {
      // a repeated delivery of a message we already have: undo the touch above
      tx.rollback();
    }
    if (conversation.mode === "ai") await enqueueReply(tx, conversation.id, new Date(now.getTime() + debounceMs));
    return { conversationId: conversation.id, message: message! };
  }).catch((err) => {
    if (isRollback(err)) return null;
    throw err;
  });

  if (!result) {
    const [existing] = await db.select({ conversationId: messages.conversationId }).from(messages).where(eq(messages.externalId, input.externalId));
    return { duplicate: true, conversationId: existing?.conversationId ?? "" };
  }

  bus.publish({ type: "message", conversationId: result.conversationId, message: result.message });
  const view = await conversationView(db, result.conversationId);
  if (view) bus.publish({ type: "conversation", conversation: view });
  return { duplicate: false, conversationId: result.conversationId };
}

const isRollback = (err: unknown) => err instanceof TransactionRollbackError;

// A message from the business (AI, agent or system) goes into the conversation as
// "pending" together with the job that will send it: both or neither.
export async function queueOutbound(
  db: Db,
  bus: EventBus,
  input: { conversationId: string; sender: Exclude<Sender, "customer">; authorId?: string | null; body: string },
  now: Date,
): Promise<Message> {
  const message = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        direction: "out",
        sender: input.sender,
        authorId: input.authorId ?? null,
        body: input.body.slice(0, 4096),
        delivery: "pending",
        createdAt: now,
      })
      .returning();
    await tx.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, input.conversationId));
    await enqueueSend(tx, input.conversationId, m.id, now);
    return m;
  });
  bus.publish({ type: "message", conversationId: input.conversationId, message });
  return message;
}

// Hands the conversation to the team: the AI stops answering until an agent gives it back.
export async function handOff(db: Db, bus: EventBus, conversationId: string, reason: string) {
  await db
    .update(conversations)
    .set({ mode: "human", handoffReason: reason })
    .where(and(eq(conversations.id, conversationId), eq(conversations.mode, "ai")));
  const view = await conversationView(db, conversationId);
  if (view) bus.publish({ type: "conversation", conversation: view });
}

export async function recentMessages(db: Db, conversationId: string, limit = 20) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contacts, conversations, messages, type Job } from "../db/schema.js";
import type { Responder, Turn } from "../ai/responder.js";
import { HANDOFF_MESSAGE } from "../ai/responder.js";
import { ChannelError, type Channel } from "../channels/channel.js";
import type { EventBus } from "./events.js";
import { searchKnowledge } from "./knowledge.js";
import { claimNext, completeJob, failJob } from "./queue.js";
import { handOff, queueOutbound, recentMessages, type Clock } from "./conversations.js";

// Asking for a person is answered right away, without spending an AI call.
const WANTS_HUMAN = /\b(human|person|agent|attendant|someone real|real person|talk to (someone|a person)|atendente|humano|pessoa)\b/i;

export type WorkerDeps = { db: Db; bus: EventBus; channel: Channel; responder: Responder; now: Clock; businessName: string };

export function createWorker(deps: WorkerDeps) {
  const { db, bus, channel, responder, now } = deps;

  async function reply(job: Job) {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, job.conversationId));
    // an agent may have taken over (or closed it) while the job waited
    if (!conversation || conversation.mode !== "ai" || conversation.status !== "open") return;

    const history = await recentMessages(db, conversation.id);
    // what the customer wrote since the business last spoke
    const lastOut = history.map((m) => m.direction).lastIndexOf("out");
    const pending = history.slice(lastOut + 1).filter((m) => m.direction === "in");
    if (!pending.length) return;
    const question = pending.map((m) => m.body).join("\n");

    if (WANTS_HUMAN.test(question)) {
      await queueOutbound(db, bus, { conversationId: conversation.id, sender: "ai", body: HANDOFF_MESSAGE }, now());
      await handOff(db, bus, conversation.id, "Customer asked for a person");
      return;
    }

    const knowledge = await searchKnowledge(db, question);
    const turns: Turn[] = history.map((m) => ({ role: m.direction === "in" ? "customer" : "business", text: m.body }));
    const decision = await responder.reply({ businessName: deps.businessName, history: turns, knowledge });

    await queueOutbound(db, bus, { conversationId: conversation.id, sender: "ai", body: decision.reply || HANDOFF_MESSAGE }, now());
    if (decision.handoff) await handOff(db, bus, conversation.id, decision.handoffReason ?? "Requested by the AI");
  }

  async function send(job: Job) {
    const [message] = await db.select().from(messages).where(eq(messages.id, job.messageId!));
    // already delivered by an earlier attempt: never send twice
    if (!message || message.delivery === "sent") return;
    const [contact] = await db
      .select({ phone: contacts.phone })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(conversations.id, job.conversationId));

    const { externalId } = await channel.send(contact.phone, message.body);
    const [sent] = await db.update(messages).set({ delivery: "sent", externalId }).where(eq(messages.id, message.id)).returning();
    bus.publish({ type: "message", conversationId: job.conversationId, message: sent });
  }

  // What a job that ran out of attempts means for the customer.
  async function giveUp(job: Job) {
    if (job.type === "send" && job.messageId) {
      const [failed] = await db.update(messages).set({ delivery: "failed" }).where(eq(messages.id, job.messageId)).returning();
      if (failed) bus.publish({ type: "message", conversationId: job.conversationId, message: failed });
    } else {
      // the AI could not answer: a person must, rather than the customer waiting forever
      await handOff(db, bus, job.conversationId, "The AI was unavailable");
    }
  }

  // Runs one due job. Returns false when there is nothing to do.
  async function runOnce(): Promise<boolean> {
    const job = await claimNext(db, now());
    if (!job) return false;
    try {
      if (job.type === "reply") await reply(job);
      else await send(job);
      await completeJob(db, job.id, now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof ChannelError && !err.retryable;
      const outcome = permanent ? await failJob(db, { ...job, attempts: Number.MAX_SAFE_INTEGER }, msg, now()) : await failJob(db, job, msg, now());
      if (outcome === "failed") await giveUp(job);
    }
    return true;
  }

  // Runs every due job (used by tests and by the polling loop).
  async function drain(): Promise<number> {
    let n = 0;
    while (await runOnce()) n++;
    return n;
  }

  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  return {
    runOnce,
    drain,
    // Polls the queue. Twice a second is plenty for chat and costs one indexed query.
    start(intervalMs = 500, log: (err: unknown) => void = console.error) {
      timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await drain();
        } catch (err) {
          log(err);
        } finally {
          busy = false;
        }
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs, type Job } from "../db/schema.js";

// A job queue inside PostgreSQL: no Redis to run, and a job is created in the same
// transaction as the data it refers to, so it can't be lost or point to nothing.

export const MAX_ATTEMPTS = 4;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

// Schedules the AI reply for a conversation. If one is already waiting, its time is
// pushed back instead of adding another: messages sent in a burst get one answer.
export async function enqueueReply(conn: Conn, conversationId: string, runAt: Date) {
  await conn.execute(sql`
    INSERT INTO jobs (type, conversation_id, run_at)
    VALUES ('reply', ${conversationId}, ${runAt.toISOString()})
    ON CONFLICT (conversation_id) WHERE type = 'reply' AND status = 'queued'
    DO UPDATE SET run_at = EXCLUDED.run_at, updated_at = now()
  `);
}

export async function enqueueSend(conn: Conn, conversationId: string, messageId: string, runAt: Date) {
  await conn.insert(jobs).values({ type: "send", conversationId, messageId, runAt });
}

// Takes the next due job and marks it running. FOR UPDATE SKIP LOCKED lets several
// workers poll the same table without two of them picking the same job.
export async function claimNext(db: Db, now: Date): Promise<Job | undefined> {
  const rows = (
    await db.execute(sql`
      UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ${now.toISOString()}
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'queued' AND run_at <= ${now.toISOString()}
        ORDER BY run_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `)
  ).rows as { id: string }[];
  if (!rows[0]) return undefined;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, rows[0].id));
  return job;
}

export async function completeJob(db: Db, id: string, now: Date) {
  await db.update(jobs).set({ status: "done", updatedAt: now }).where(eq(jobs.id, id));
}

// Exponential backoff: 2s, 4s, 8s. After MAX_ATTEMPTS the job is marked failed and
// the caller decides what that means for the customer.
export async function failJob(db: Db, job: Job, error: string, now: Date): Promise<"retry" | "failed"> {
  if (job.attempts >= MAX_ATTEMPTS) {
    await db.update(jobs).set({ status: "failed", lastError: error, updatedAt: now }).where(eq(jobs.id, job.id));
    return "failed";
  }
  const runAt = new Date(now.getTime() + 2 ** job.attempts * 1000);
  try {
    await db.update(jobs).set({ status: "queued", runAt, lastError: error, updatedAt: now }).where(eq(jobs.id, job.id));
  } catch (err) {
    // A newer reply for the same conversation was queued while this one ran: that one
    // will read the whole conversation anyway, so this attempt can stop here.
    if (!isUniqueViolation(err)) throw err;
    await db.update(jobs).set({ status: "done", lastError: error, updatedAt: now }).where(eq(jobs.id, job.id));
  }
  return "retry";
}

export const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { documents } from "../db/schema.js";
import { saveDocument, searchKnowledge } from "../core/knowledge.js";
import type { Clock } from "../core/conversations.js";

const idParam = z.object({ id: z.uuid() });
const docSchema = z.object({ title: z.string().trim().min(2).max(160), body: z.string().trim().min(1).max(50_000) });
const searchQuery = z.object({ q: z.string().trim().min(1).max(500) });

// The knowledge base the AI answers from: hours, prices, policies...
export function knowledgeRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.addHook("preHandler", app.authenticate);

  app.get("/documents", async () => {
    return db
      .select({
        id: documents.id,
        title: documents.title,
        body: documents.body,
        updatedAt: documents.updatedAt,
        chunks: sql<number>`(SELECT count(*)::int FROM chunks c WHERE c.document_id = documents.id)`,
      })
      .from(documents)
      .orderBy(desc(documents.updatedAt));
  });

  app.post("/documents", async (req, reply) => {
    const body = docSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    return reply.code(201).send(await saveDocument(db, body.data, now()));
  });

  app.put("/documents/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = docSchema.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "Document not found" });
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    const doc = await saveDocument(db, body.data, now(), p.data.id);
    if (!doc) return reply.code(404).send({ error: "Document not found" });
    return doc;
  });

  app.delete("/documents/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Document not found" });
    const [deleted] = await db.delete(documents).where(eq(documents.id, p.data.id)).returning({ id: documents.id });
    if (!deleted) return reply.code(404).send({ error: "Document not found" });
    return reply.code(204).send();
  });

  // Shows what the AI would read for a given question, to test the knowledge base.
  app.get("/documents/search", async (req, reply) => {
    const q = searchQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Type a question" });
    return searchKnowledge(db, q.data.q);
  });
}

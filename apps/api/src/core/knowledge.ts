import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chunks, documents } from "../db/schema.js";

const MAX_CHUNK = 700;

// Splits a document into paragraph-sized pieces. Small chunks mean the AI receives
// only the part that answers the question, not the whole document.
// Each chunk starts with the document title so it still makes sense on its own.
export function chunkText(title: string, body: string, max = MAX_CHUNK): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const pieces: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    // a single paragraph longer than the limit is cut at sentence boundaries
    const parts = p.length > max ? (p.match(/[^.!?]+[.!?]*/g) ?? [p]).map((s) => s.trim()) : [p];
    for (const part of parts) {
      if (current && current.length + part.length + 1 > max) {
        pieces.push(current);
        current = "";
      }
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) pieces.push(current);
  return pieces.map((c) => `${title}: ${c}`);
}

export async function saveDocument(db: Db, input: { title: string; body: string }, now: Date, id?: string) {
  return db.transaction(async (tx) => {
    let doc;
    if (id) {
      [doc] = await tx.update(documents).set({ ...input, updatedAt: now }).where(eq(documents.id, id)).returning();
      if (!doc) return null;
      await tx.delete(chunks).where(eq(chunks.documentId, id));
    } else {
      [doc] = await tx
        .insert(documents)
        .values({ ...input, createdAt: now, updatedAt: now })
        .returning();
    }
    const pieces = chunkText(input.title, input.body);
    await tx.insert(chunks).values(pieces.map((content, position) => ({ documentId: doc.id, position, content })));
    return { ...doc, chunks: pieces.length };
  });
}

export type KnowledgeHit = { documentId: string; title: string; content: string; rank: number };

// Retrieval step of RAG, with PostgreSQL full-text search: stemmed words ("open" matches
// "opening"), stop words ignored, ranked by how well each chunk matches.
// Words are combined with OR, because customers write long questions and a chunk
// rarely contains every word of them.
export async function searchKnowledge(db: Db, query: string, limit = 3): Promise<KnowledgeHit[]> {
  if (!query.trim()) return [];
  const rows = (
    await db.execute(sql`
      SELECT c.document_id, d.title, c.content, ts_rank_cd(c.search, q) AS rank
      FROM chunks c
      JOIN documents d ON d.id = c.document_id,
           to_tsquery('english', replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')) q
      WHERE c.search @@ q
      ORDER BY rank DESC, c.position
      LIMIT ${limit}
    `)
  ).rows as { document_id: string; title: string; content: string; rank: number | string }[];
  return rows.map((r) => ({ documentId: r.document_id, title: r.title, content: r.content, rank: Number(r.rank) }));
}

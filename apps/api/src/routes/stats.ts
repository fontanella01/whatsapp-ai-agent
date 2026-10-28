import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Clock } from "../core/conversations.js";

// Numbers for the inbox header, computed in PostgreSQL in one query each.
export function statsRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.addHook("preHandler", app.authenticate);

  app.get("/stats", async () => {
    const since = new Date(now().getTime() - 24 * 3_600_000).toISOString();
    const conv = (
      await db.execute(sql`
        SELECT count(*) FILTER (WHERE status = 'open' AND mode = 'ai')    AS with_ai,
               count(*) FILTER (WHERE status = 'open' AND mode = 'human') AS with_team
        FROM conversations
      `)
    ).rows[0] as Record<string, unknown>;

    const msgs = (
      await db.execute(sql`
        SELECT count(*) FILTER (WHERE sender = 'customer') AS received,
               count(*) FILTER (WHERE sender = 'ai')       AS ai_replies,
               count(*) FILTER (WHERE sender = 'agent')    AS team_replies,
               count(*) FILTER (WHERE delivery = 'failed') AS failed
        FROM messages WHERE created_at >= ${since}
      `)
    ).rows[0] as Record<string, unknown>;

    const n = (v: unknown) => Number(v ?? 0);
    const aiReplies = n(msgs.ai_replies);
    const teamReplies = n(msgs.team_replies);
    return {
      openWithAi: n(conv.with_ai),
      openWithTeam: n(conv.with_team),
      last24h: {
        received: n(msgs.received),
        aiReplies,
        teamReplies,
        failed: n(msgs.failed),
        // share of business replies the AI wrote by itself
        aiShare: aiReplies + teamReplies ? Math.round((aiReplies / (aiReplies + teamReplies)) * 100) : null,
      },
    };
  });
}

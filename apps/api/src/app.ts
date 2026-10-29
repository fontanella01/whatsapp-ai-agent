import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { Db } from "./db/client.js";
import { registerAuth } from "./auth/plugin.js";
import { logger, registerSecurity } from "./security.js";
import { EventBus } from "./core/events.js";
import type { Clock } from "./core/conversations.js";
import type { Responder } from "./ai/responder.js";
import type { Channel } from "./channels/channel.js";
import { authRoutes } from "./routes/auth.js";
import { conversationRoutes } from "./routes/conversations.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { simulatorRoutes } from "./routes/simulator.js";
import { webhookRoutes, type WhatsAppConfig } from "./routes/webhooks.js";
import { eventRoutes } from "./routes/events.js";
import { statsRoutes } from "./routes/stats.js";

export type AppOptions = {
  jwtSecret: string;
  responder: Responder;
  channel: Channel;
  bus?: EventBus;
  now?: Clock;
  logger?: boolean;
  demo?: boolean;
  whatsapp?: WhatsAppConfig | null;
  businessName?: string;
  // how long to wait for more customer messages before answering
  debounceMs?: number;
  // folder with the built web app (apps/web/dist), served in production
  webDir?: string;
  // proxies in front of the app (three on Render), so req.ip is the visitor and not
  // the proxy; rate limits are counted per req.ip
  trustProxy?: number | false;
};

// The app is built from its dependencies (database, clock, AI, channel) instead of
// creating them, so tests run it with an in-memory database, a fake clock and fakes.
export async function buildApp(db: Db, opts: AppOptions) {
  const app = Fastify({
    logger: opts.logger ? logger : false,
    // trust only the given number of hops, so a visitor cannot fake their IP in X-Forwarded-For
    trustProxy: opts.trustProxy ? (_address: string, hop: number) => hop < (opts.trustProxy as number) : false,
    bodyLimit: 1_048_576,
    // the web app calls /api/...; in development Vite strips the prefix, in
    // production (one container serving both) this does the same
    rewriteUrl: (req) => (req.url ?? "/").replace(/^\/api(?=\/|$)/, "") || "/",
  });
  const now = opts.now ?? (() => new Date());
  const bus = opts.bus ?? new EventBus();
  const debounceMs = opts.debounceMs ?? 1500;
  await registerSecurity(app);
  await registerAuth(app, opts.jwtSecret);

  app.get("/health", async () => ({ ok: true, ai: opts.responder.mode, channel: opts.channel.name }));
  authRoutes(app, db, { demo: opts.demo ?? false, info: { ai: opts.responder.mode, channel: opts.channel.name, businessName: opts.businessName ?? "Aurora Dental Clinic" } });
  eventRoutes(app, bus);

  // register() creates encapsulated scopes: each group's hooks and parsers stay inside it
  await app.register(async (s) => conversationRoutes(s, db, bus, now));
  await app.register(async (s) => knowledgeRoutes(s, db, now));
  await app.register(async (s) => simulatorRoutes(s, db, bus, now, debounceMs));
  await app.register(async (s) => statsRoutes(s, db, now));
  await app.register(async (s) => webhookRoutes(s, db, bus, now, debounceMs, opts.whatsapp ?? null));

  // Production: also serve the built web app, so one service runs everything.
  if (opts.webDir) {
    await app.register(fastifyStatic, { root: opts.webDir, wildcard: false });
    // client-side routes (/inbox/123) get index.html; unknown API calls stay JSON 404s
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && req.headers.accept?.includes("text/html")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return { app, bus };
}

import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/events.js";

// Live updates for the browser via Server-Sent Events: one long HTTP response the
// server keeps writing to. Simpler than WebSockets for one-way updates, works
// through proxies, and the browser reconnects on its own.
export function eventRoutes(app: FastifyInstance, bus: EventBus) {
  app.get("/events", async (req, reply) => {
    // EventSource cannot send headers, so the token comes in the query string.
    const token = (req.query as { token?: string }).token;
    try {
      app.jwt.verify(token ?? "");
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // tells nginx not to buffer the stream
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const unsubscribe = bus.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    // a comment line every 25s keeps idle connections from being closed by proxies
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

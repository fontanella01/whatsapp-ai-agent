import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";

// Limits per client IP. Counters live in memory, which is right for one instance
// (the demo runs one); with several instances they need a shared store (Redis).
export const LIMITS = {
  // anything else: generous, only stops floods
  global: { max: 300, timeWindow: "1 minute" },
  // password guessing
  login: { max: 10, timeWindow: "15 minutes" },
  demoLogin: { max: 30, timeWindow: "15 minutes" },
  // each simulator message can lead to an AI call
  simulator: { max: 20, timeWindow: "1 minute" },
};

// Request logs keep the path but never the token the live updates send in the URL.
export const redactUrl = (url: string) => url.replace(/([?&]token=)[^&]*/g, "$1[redacted]");

export const logger = {
  serializers: {
    req: (req: FastifyRequest) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
  },
};

export async function registerSecurity(app: FastifyInstance) {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // the web app loads Inter from Google Fonts
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await app.register(fastifyRateLimit, LIMITS.global);

  // Expected errors (validation, 404, 429) keep their message; anything else is
  // logged in full and answered with a generic message, so no internals leak.
  app.setErrorHandler((err: { statusCode?: number; message: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(status).send({ error: "Internal server error" });
    }
    return reply.code(status).send({ error: err.message });
  });
}

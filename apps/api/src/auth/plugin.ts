import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";

// What goes inside the token: who the agent is, signed by the server.
export type AuthUser = { sub: string; name: string };

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function registerAuth(app: FastifyInstance, secret: string) {
  if (secret.length < 32) throw new Error("JWT secret must have at least 32 characters");
  await app.register(fastifyJwt, { secret, sign: { expiresIn: "8h" } });

  // Used as a preHandler on protected routes: no valid token, no access.
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });
}

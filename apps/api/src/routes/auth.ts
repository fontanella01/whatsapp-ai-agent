import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "../auth/password.js";
import { DEMO_EMAIL } from "../seed.js";
import { LIMITS } from "../security.js";

const loginSchema = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().min(1).max(200) });

// Used when the email does not exist, so a failed login takes about the same time
// either way and does not reveal which emails are registered.
const DUMMY_HASH = "scrypt$00000000000000000000000000000000$" + "0".repeat(128);

const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email });

export function authRoutes(app: FastifyInstance, db: Db, opts: { demo: boolean; info: { ai: string; channel: string; businessName: string } }) {
  const tokenFor = (u: typeof users.$inferSelect) => app.jwt.sign({ sub: u.id, name: u.name });

  // What the login screen needs to know before anyone signs in.
  app.get("/auth/config", async () => ({ demo: opts.demo, ...opts.info }));

  app.post("/auth/login", { config: { rateLimit: LIMITS.login } }, async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your email and password" });
    const [user] = await db.select().from(users).where(eq(users.email, body.data.email));
    const ok = await verifyPassword(body.data.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) return reply.code(401).send({ error: "Invalid email or password" });
    return { token: tokenFor(user), user: publicUser(user) };
  });

  // One click into the demo workspace, only when DEMO_MODE is on.
  app.post("/auth/demo", { config: { rateLimit: LIMITS.demoLogin } }, async (_req, reply) => {
    if (!opts.demo) return reply.code(404).send({ error: "Demo is disabled" });
    const [user] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
    if (!user) return reply.code(503).send({ error: "Demo data is not ready yet" });
    return { token: tokenFor(user), user: publicUser(user) };
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (req, reply) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.user.sub));
    if (!user) return reply.code(401).send({ error: "Unauthorized" });
    return publicUser(user);
  });
}

import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createWorker } from "../src/core/worker.js";
import { ChannelError, type Channel } from "../src/channels/channel.js";
import type { Decision, ReplyInput, Responder } from "../src/ai/responder.js";

export const TEST_SECRET = "test-secret-with-at-least-32-characters!!";

// A responder that records what it was asked and answers whatever the test decides.
export function fakeResponder(answer: (input: ReplyInput) => Partial<Decision> | Promise<Partial<Decision>> = () => ({ reply: "Sure!" })) {
  const calls: ReplyInput[] = [];
  const responder: Responder = {
    mode: "demo",
    async reply(input) {
      calls.push(input);
      const d = await answer(input);
      return { reply: d.reply ?? "", handoff: d.handoff ?? false, handoffReason: d.handoffReason ?? null, source: "demo" };
    },
  };
  return { responder, calls };
}

// A channel that records sent messages and can be told to fail.
export function fakeChannel() {
  const sent: { to: string; body: string }[] = [];
  let failures: { count: number; retryable: boolean } = { count: 0, retryable: true };
  const channel: Channel = {
    name: "simulator",
    async send(to, body) {
      if (failures.count > 0) {
        failures.count--;
        throw new ChannelError("provider down", failures.retryable);
      }
      sent.push({ to, body });
      return { externalId: `out-${sent.length}` };
    },
  };
  return { channel, sent, failNext: (count: number, retryable = true) => (failures = { count, retryable }) };
}

// A fresh in-memory PostgreSQL, app and worker for each test.
// The clock only moves when a test calls advance(), so retries and debounce are exact.
export async function setup(opts: { responder?: Responder; channel?: Channel; demo?: boolean; debounceMs?: number; whatsapp?: { appSecret: string; verifyToken: string }; webDir?: string } = {}) {
  const { db, close } = await createDb();
  let current = new Date("2026-03-02T12:00:00Z");
  const clock = {
    now: () => new Date(current),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
  const ai = opts.responder ? { responder: opts.responder, calls: [] } : fakeResponder();
  const ch = opts.channel ? null : fakeChannel();
  const channel = opts.channel ?? ch!.channel;

  const { app, bus } = await buildApp(db, {
    jwtSecret: TEST_SECRET,
    responder: ai.responder,
    channel,
    now: clock.now,
    demo: opts.demo,
    debounceMs: opts.debounceMs ?? 0,
    whatsapp: opts.whatsapp ?? null,
    webDir: opts.webDir,
  });
  const worker = createWorker({ db, bus, channel, responder: ai.responder, now: clock.now, businessName: "Test Clinic" });

  await db.insert(users).values({ name: "Ana Agent", email: "ana@relay.test", passwordHash: await hashPassword("s3cret-pass") });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "ana@relay.test", password: "s3cret-pass" } });
  const token: string = login.json().token;
  const auth = { authorization: `Bearer ${token}` };

  // the customer writes from the simulator (same path as a real webhook)
  const customer = (body: string, phone = "5547999990000", name = "Bruno") =>
    app.inject({ method: "POST", url: "/simulator/messages", headers: auth, payload: { phone, name, body } });

  const thread = async (phone = "5547999990000") =>
    (await app.inject({ method: "GET", url: `/simulator/thread?phone=${phone}`, headers: auth })).json() as {
      conversationId: string;
      messages: { sender: string; body: string; delivery: string }[];
    };

  const conversation = async (id: string) => (await app.inject({ method: "GET", url: `/conversations/${id}`, headers: auth })).json();

  const teardown = async () => {
    await app.close();
    await close();
  };

  return { app, db, bus, worker, clock, auth, token, customer, thread, conversation, sent: ch?.sent ?? [], failNext: ch?.failNext, calls: ai.calls, teardown };
}

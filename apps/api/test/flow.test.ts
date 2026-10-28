import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs } from "../src/db/schema.js";
import { saveDocument } from "../src/core/knowledge.js";
import { fakeResponder, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.teardown();
  ctx = undefined!;
});

describe("AI replies", () => {
  it("answers a customer message through the channel", async () => {
    ctx = await setup();
    await ctx.customer("Hi, are you open today?");
    await ctx.worker.drain();

    expect(ctx.sent).toEqual([{ to: "5547999990000", body: "Sure!" }]);
    const t = await ctx.thread();
    expect(t.messages.map((m) => [m.sender, m.delivery])).toEqual([
      ["customer", "received"],
      ["ai", "sent"],
    ]);
  });

  it("gives the AI the matching knowledge and the conversation so far", async () => {
    const ai = fakeResponder();
    ctx = await setup({ responder: ai.responder });
    await saveDocument(ctx.db, { title: "Hours", body: "We are open on Saturdays from 9am to 1pm." }, ctx.clock.now());
    await saveDocument(ctx.db, { title: "Prices", body: "A cleaning costs R$ 150." }, ctx.clock.now());

    await ctx.customer("Do you open on saturday?");
    await ctx.worker.drain();

    expect(ai.calls[0].knowledge.map((k) => k.title)).toEqual(["Hours"]);
    expect(ai.calls[0].history).toEqual([{ role: "customer", text: "Do you open on saturday?" }]);
    expect(ai.calls[0].businessName).toBe("Test Clinic");
  });

  it("waits for a burst of messages and answers them once", async () => {
    const ai = fakeResponder();
    ctx = await setup({ responder: ai.responder, debounceMs: 2000 });
    await ctx.customer("Hi");
    ctx.clock.advance(800);
    await ctx.customer("I have a question");
    ctx.clock.advance(800);
    await ctx.customer("How much is whitening?");

    expect(await ctx.worker.drain()).toBe(0); // still inside the waiting window
    ctx.clock.advance(2000);
    await ctx.worker.drain();

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].history.map((t) => t.text)).toEqual(["Hi", "I have a question", "How much is whitening?"]);
    expect(ctx.sent).toHaveLength(1);
  });
});

describe("handoff to a person", () => {
  it("hands off right away when the customer asks for a person, without calling the AI", async () => {
    const ai = fakeResponder();
    ctx = await setup({ responder: ai.responder });
    const { conversationId } = (await ctx.customer("I want to talk to a human please")).json();
    await ctx.worker.drain();

    expect(ai.calls).toHaveLength(0);
    const conv = await ctx.conversation(conversationId);
    expect(conv).toMatchObject({ mode: "human", handoffReason: "Customer asked for a person" });
    expect(ctx.sent[0].body).toMatch(/passing you to someone from our team/);
  });

  it("hands off when the AI decides it cannot answer", async () => {
    const ai = fakeResponder(() => ({ reply: "A team member will reply soon.", handoff: true, handoffReason: "Wants to book" }));
    ctx = await setup({ responder: ai.responder });
    const { conversationId } = (await ctx.customer("Book me for Tuesday at 3pm")).json();
    await ctx.worker.drain();

    expect(await ctx.conversation(conversationId)).toMatchObject({ mode: "human", handoffReason: "Wants to book" });
    expect(ctx.sent.map((s) => s.body)).toEqual(["A team member will reply soon."]);
  });

  it("stays quiet while a person is in charge", async () => {
    const ai = fakeResponder();
    ctx = await setup({ responder: ai.responder });
    const { conversationId } = (await ctx.customer("hello")).json();
    await ctx.app.inject({ method: "POST", url: `/conversations/${conversationId}/takeover`, headers: ctx.auth });
    await ctx.customer("are you there?");
    await ctx.worker.drain();

    expect(ai.calls).toHaveLength(0);
    expect(ctx.sent).toHaveLength(0);
  });

  it("lets an agent reply, taking over from the AI", async () => {
    ctx = await setup();
    const { conversationId } = (await ctx.customer("hello")).json();
    const res = await ctx.app.inject({ method: "POST", url: `/conversations/${conversationId}/messages`, headers: ctx.auth, payload: { body: "Hi Bruno, Ana here!" } });
    expect(res.statusCode).toBe(201);
    await ctx.worker.drain();

    const conv = await ctx.conversation(conversationId);
    expect(conv.mode).toBe("human");
    expect(conv.assigneeId).not.toBeNull();
    // the AI reply scheduled before the agent stepped in is dropped
    expect(ctx.sent.map((s) => s.body)).toEqual(["Hi Bruno, Ana here!"]);
  });

  it("answers again after the conversation is handed back to the AI", async () => {
    const ai = fakeResponder();
    ctx = await setup({ responder: ai.responder });
    const { conversationId } = (await ctx.customer("talk to a person")).json();
    await ctx.worker.drain();
    await ctx.app.inject({ method: "POST", url: `/conversations/${conversationId}/release`, headers: ctx.auth });
    await ctx.customer("what are your prices?");
    await ctx.worker.drain();

    expect(ai.calls).toHaveLength(1);
    expect((await ctx.conversation(conversationId)).mode).toBe("ai");
  });

  it("reopens a closed conversation with the AI in charge", async () => {
    ctx = await setup();
    const { conversationId } = (await ctx.customer("person please")).json();
    await ctx.worker.drain();
    await ctx.app.inject({ method: "POST", url: `/conversations/${conversationId}/close`, headers: ctx.auth });
    await ctx.customer("hi again");

    expect(await ctx.conversation(conversationId)).toMatchObject({ status: "open", mode: "ai", handoffReason: null });
  });
});

describe("failures", () => {
  it("retries a failed send with backoff and delivers it once", async () => {
    ctx = await setup();
    ctx.failNext!(2);
    await ctx.customer("hello");
    await ctx.worker.drain(); // reply generated, first send fails
    expect(ctx.sent).toHaveLength(0);

    ctx.clock.advance(2_000);
    await ctx.worker.drain(); // second attempt fails
    ctx.clock.advance(4_000);
    await ctx.worker.drain(); // third attempt works

    expect(ctx.sent).toHaveLength(1);
    expect((await ctx.thread()).messages[1].delivery).toBe("sent");
  });

  it("marks the message failed at once when the error cannot be fixed by retrying", async () => {
    ctx = await setup();
    ctx.failNext!(1, false);
    await ctx.customer("hello");
    await ctx.worker.drain();

    expect((await ctx.thread()).messages[1].delivery).toBe("failed");
    const [send] = await ctx.db.select().from(jobs).where(eq(jobs.type, "send"));
    expect(send).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("hands the conversation to a person when the AI keeps failing", async () => {
    const ai = fakeResponder(() => {
      throw new Error("AI provider down");
    });
    ctx = await setup({ responder: ai.responder });
    const { conversationId } = (await ctx.customer("hello")).json();
    for (let i = 0; i < 5; i++) {
      await ctx.worker.drain();
      ctx.clock.advance(60_000);
    }

    expect(ai.calls).toHaveLength(4);
    expect(await ctx.conversation(conversationId)).toMatchObject({ mode: "human", handoffReason: "The AI was unavailable" });
  });
});

describe("inbox", () => {
  it("lists open conversations with the last message, filtered by who is in charge", async () => {
    ctx = await setup();
    await ctx.customer("hello", "5547900000001", "Ana");
    await ctx.customer("person please", "5547900000002", "Caio");
    await ctx.worker.drain();

    const all = (await ctx.app.inject({ method: "GET", url: "/conversations", headers: ctx.auth })).json();
    const human = (await ctx.app.inject({ method: "GET", url: "/conversations?mode=human", headers: ctx.auth })).json();
    expect(all).toHaveLength(2);
    expect(human.map((c: { contact: { name: string } }) => c.contact.name)).toEqual(["Caio"]);
    expect(human[0].lastMessage.sender).toBe("ai");
  });

  it("requires a signed-in agent", async () => {
    ctx = await setup();
    const res = await ctx.app.inject({ method: "GET", url: "/conversations" });
    const sim = await ctx.app.inject({ method: "POST", url: "/simulator/messages", payload: { phone: "5547999990000", body: "x" } });
    const events = await ctx.app.inject({ method: "GET", url: "/events?token=forged" });
    expect([res.statusCode, sim.statusCode, events.statusCode]).toEqual([401, 401, 401]);
  });
});

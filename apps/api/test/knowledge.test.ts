import { afterEach, describe, expect, it } from "vitest";
import { chunks } from "../src/db/schema.js";
import { chunkText, saveDocument, searchKnowledge } from "../src/core/knowledge.js";
import { bestSentences, demoResponder, toMessages } from "../src/ai/responder.js";
import { DEMO_DOCUMENTS } from "../src/seed.js";
import { setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.teardown();
  ctx = undefined!;
});

describe("chunking", () => {
  it("splits by paragraph, keeps chunks short and labels them with the title", () => {
    const body = ["First paragraph.", "Second paragraph.", "x".repeat(50) + ". " + "y".repeat(50) + "."].join("\n\n");
    const pieces = chunkText("Hours", body, 60);
    expect(pieces.every((p) => p.startsWith("Hours: "))).toBe(true);
    expect(pieces.every((p) => p.length <= 60 + "Hours: ".length)).toBe(true);
    expect(pieces.join(" ")).toContain("First paragraph. Second paragraph.");
  });
});

describe("retrieval", () => {
  it("finds the chunk that answers the question among the demo documents", async () => {
    ctx = await setup();
    for (const d of DEMO_DOCUMENTS) await saveDocument(ctx.db, d, ctx.clock.now());

    const top = async (q: string) => (await searchKnowledge(ctx.db, q))[0]?.title;
    expect(await top("Are you open on Saturday?")).toBe("Opening hours and location");
    expect(await top("how much does teeth whitening cost")).toBe("Prices");
    expect(await top("Do you accept the OdontoPrev plan?")).toBe("Payment and dental plans");
    expect(await top("I have a lot of tooth pain, is this an emergency?")).toBe("Emergencies");
    expect(await searchKnowledge(ctx.db, "do you sell pizza")).toEqual([]);
  });

  it("re-indexes a document when it changes and forgets it when deleted", async () => {
    ctx = await setup();
    const created = (
      await ctx.app.inject({ method: "POST", url: "/documents", headers: ctx.auth, payload: { title: "Parking", body: "Free parking behind the building." } })
    ).json();
    expect(created.chunks).toBe(1);
    const listed = (await ctx.app.inject({ method: "GET", url: "/documents", headers: ctx.auth })).json();
    expect(listed).toMatchObject([{ title: "Parking", chunks: 1 }]);

    await ctx.app.inject({ method: "PUT", url: `/documents/${created.id}`, headers: ctx.auth, payload: { title: "Parking", body: "Parking costs R$ 10 per hour." } });
    expect(await searchKnowledge(ctx.db, "free parking")).toHaveLength(1);
    expect((await searchKnowledge(ctx.db, "hour"))[0].content).toContain("R$ 10");

    await ctx.app.inject({ method: "DELETE", url: `/documents/${created.id}`, headers: ctx.auth });
    expect(await ctx.db.select().from(chunks)).toHaveLength(0);
  });

  it("shows what the AI would read for a question", async () => {
    ctx = await setup();
    await saveDocument(ctx.db, DEMO_DOCUMENTS[0], ctx.clock.now());
    const res = await ctx.app.inject({ method: "GET", url: "/documents/search?q=saturday", headers: ctx.auth });
    expect(res.json()[0].content).toMatch(/Saturdays from 9am to 1pm/);
  });
});

describe("demo responder", () => {
  const hit = { documentId: "d", title: "Hours", content: "Hours: We open at 8am.", rank: 1 };

  it("answers with the best matching chunk", async () => {
    const d = await demoResponder.reply({ businessName: "X", history: [{ role: "customer", text: "when do you open?" }], knowledge: [hit] });
    expect(d).toMatchObject({ reply: "We open at 8am.", handoff: false });
  });

  it("quotes only the sentences that answer the question", () => {
    const text = "We are open Monday to Friday. There is free parking behind the building. We accept Pix.";
    expect(bestSentences("Is there parking?", text, 1)).toBe("There is free parking behind the building.");
  });

  it("sends booking requests to the team even when the topic is documented", async () => {
    const d = await demoResponder.reply({ businessName: "X", history: [{ role: "customer", text: "I would like to book a cleaning" }], knowledge: [hit] });
    expect(d).toMatchObject({ handoff: true, handoffReason: "Customer wants to book an appointment" });
  });

  it("hands off when nothing in the knowledge base matches", async () => {
    const d = await demoResponder.reply({ businessName: "X", history: [], knowledge: [] });
    expect(d).toMatchObject({ handoff: true, handoffReason: "No answer in the knowledge base" });
  });
});

describe("conversation sent to Claude", () => {
  it("merges consecutive turns, starts with the customer and adds the knowledge to the last question", () => {
    const msgs = toMessages(
      [
        { role: "business", text: "Welcome!" },
        { role: "customer", text: "Hi" },
        { role: "customer", text: "Open today?" },
      ],
      [{ documentId: "d", title: "Hours", content: "Hours: 8am to 7pm.", rank: 1 }],
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain('<item index="1" source="Hours">');
    expect(msgs[0].content).toContain("<customer_message>\nHi\nOpen today?\n</customer_message>");
  });
});

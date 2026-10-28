import { randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { contacts, conversations, documents, messages, users } from "./db/schema.js";
import { hashPassword } from "./auth/password.js";
import { saveDocument } from "./core/knowledge.js";

export const DEMO_EMAIL = "demo@relay.test";
export const DEMO_BUSINESS = "Aurora Dental Clinic";

// Knowledge base of a fictional clinic, used by the demo.
export const DEMO_DOCUMENTS = [
  {
    title: "Opening hours and location",
    body: `We are open Monday to Friday from 8am to 7pm, and on Saturdays from 9am to 1pm. We are closed on Sundays and public holidays.

The clinic is at Rua das Palmeiras 120, downtown Joinville, across from the Central Park. There is free parking for patients behind the building.`,
  },
  {
    title: "Prices",
    body: `A first consultation with cleaning costs R$ 180. A regular cleaning for returning patients costs R$ 150.

Teeth whitening costs R$ 900 and includes two in-office sessions plus a take-home kit. Fillings start at R$ 220 per tooth. Prices for implants, braces and root canals depend on an evaluation by the dentist.`,
  },
  {
    title: "Payment and dental plans",
    body: `We accept Pix, debit and credit cards. Treatments above R$ 600 can be split into up to 6 interest-free installments on the credit card.

We accept the Amil Dental, OdontoPrev and SulAmérica Odonto dental plans. Bring your plan card and an ID to the appointment.`,
  },
  {
    title: "Appointments and cancellations",
    body: `Appointments are booked by our front desk team, who check the dentists' calendars. Ask for an appointment and a team member will reply with the available times.

Please cancel or reschedule at least 24 hours in advance. Late cancellations and no-shows are charged R$ 50.`,
  },
  {
    title: "Emergencies",
    body: `For a dental emergency such as severe pain, a broken tooth or swelling, call (47) 3333-1200. During opening hours we fit emergencies in the same day. Outside opening hours, the emergency line forwards you to the dentist on call.`,
  },
  {
    title: "First visit",
    body: `On the first visit the dentist does a full check-up, takes a panoramic X-ray if needed and explains the treatment plan with prices before anything is done. Plan to arrive 10 minutes early to fill in the health form. The first visit takes about one hour.`,
  },
];

// Creates the demo account, knowledge base and two sample conversations, once.
export async function seedDemo(db: Db, now = new Date()) {
  const [{ n }] = await db.select({ n: count() }).from(users).where(eq(users.email, DEMO_EMAIL));
  if (n > 0) return false;

  // the demo is entered with the "Try the demo" button, so the password is never needed
  await db.insert(users).values({ name: "Demo agent", email: DEMO_EMAIL, passwordHash: await hashPassword(randomBytes(24).toString("hex")) });

  const [{ docs }] = await db.select({ docs: count() }).from(documents);
  if (docs === 0) for (const d of DEMO_DOCUMENTS) await saveDocument(db, d, now);

  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const sample = async (phone: string, name: string, mode: "ai" | "human", reason: string | null, thread: [("in" | "ai" | "agent"), string, number][]) => {
    const [contact] = await db.insert(contacts).values({ phone, name }).onConflictDoNothing().returning();
    if (!contact) return;
    const [conv] = await db
      .insert(conversations)
      .values({ contactId: contact.id, mode, handoffReason: reason, lastMessageAt: minutesAgo(thread[thread.length - 1][2]) })
      .returning();
    for (const [who, body, ago] of thread) {
      await db.insert(messages).values({
        conversationId: conv.id,
        direction: who === "in" ? "in" : "out",
        sender: who === "in" ? "customer" : who,
        body,
        delivery: who === "in" ? "received" : "sent",
        createdAt: minutesAgo(ago),
      });
    }
  };

  await sample("5547991110001", "Camila Rocha", "ai", null, [
    ["in", "Hi! How much is teeth whitening?", 42],
    ["ai", "Teeth whitening costs R$ 900 and includes two in-office sessions plus a take-home kit.", 42],
    ["in", "Can I pay in installments?", 40],
    ["ai", "Yes! Treatments above R$ 600 can be split into up to 6 interest-free installments on the credit card.", 40],
  ]);
  await sample("5547991110002", "Rafael Mendes", "human", "Customer wants to book an appointment", [
    ["in", "Good morning, I'd like to book a cleaning for next Tuesday", 15],
    ["ai", "Got it! I'm passing you to someone from our team. They'll reply here as soon as possible.", 15],
  ]);
  return true;
}

// `npm run seed`: creates the demo data in the local database.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("seed.ts")) {
  const { createDb } = await import("./db/client.js");
  const { db, close } = await createDb({ url: process.env.DATABASE_URL, dataDir: process.env.DATABASE_URL ? undefined : "./.data" });
  console.log((await seedDemo(db)) ? "Demo data created." : "Demo data already exists.");
  await close();
}

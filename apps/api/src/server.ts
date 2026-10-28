import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { createResponder } from "./ai/responder.js";
import { simulatorChannel } from "./channels/simulator.js";
import { createWhatsAppChannel } from "./channels/whatsapp.js";
import { createWorker } from "./core/worker.js";
import { DEMO_BUSINESS, resetData, seedDemo } from "./seed.js";

// Local settings from apps/api/.env (copy .env.example). Real environment variables win.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the environment
}

const env = process.env;
if (!env.JWT_SECRET) {
  console.error("Set JWT_SECRET (at least 32 random characters) before starting the API.");
  process.exit(1);
}

const { db } = await createDb({ url: env.DATABASE_URL, dataDir: env.DATABASE_URL ? undefined : "./.data" });

// Real WhatsApp when all four Meta settings are present; the built-in simulator otherwise.
const whatsapp =
  env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN
    ? { token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, appSecret: env.WHATSAPP_APP_SECRET, verifyToken: env.WHATSAPP_VERIFY_TOKEN }
    : null;
const channel = whatsapp ? createWhatsAppChannel(whatsapp) : simulatorChannel;
const responder = createResponder(env);
const demo = env.DEMO_MODE === "true";
const businessName = env.BUSINESS_NAME ?? DEMO_BUSINESS;
// Public demo on a permanent database: start every boot from a clean sample clinic,
// so what earlier visitors typed doesn't pile up. Never set this on real data.
if (demo && env.DEMO_RESET_ON_START === "true") await resetData(db);
if (demo) await seedDemo(db);

const { app, bus } = await buildApp(db, {
  jwtSecret: env.JWT_SECRET,
  responder,
  channel,
  logger: true,
  demo,
  businessName,
  webDir: env.WEB_DIR,
  whatsapp: whatsapp && { appSecret: whatsapp.appSecret, verifyToken: whatsapp.verifyToken },
});

// The worker runs in the same process here; it could be split into its own process
// (same code, same queue table) when the volume asks for it.
const worker = createWorker({ db, bus, channel, responder, now: () => new Date(), businessName });
worker.start(500, (err) => app.log.error({ err }, "worker error"));

const port = Number(env.PORT ?? 3333);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`AI: ${responder.mode}, channel: ${channel.name}, demo: ${demo}`);

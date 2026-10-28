import { createHmac, timingSafeEqual } from "node:crypto";
import { ChannelError, type Channel } from "./channel.js";

const GRAPH = "https://graph.facebook.com/v21.0";

// Sends text messages through the WhatsApp Cloud API (Meta).
export function createWhatsAppChannel(opts: { token: string; phoneNumberId: string; fetch?: typeof fetch }): Channel {
  const doFetch = opts.fetch ?? fetch;
  return {
    name: "whatsapp",
    async send(to, body) {
      let res: Response;
      try {
        res = await doFetch(`${GRAPH}/${opts.phoneNumberId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
        });
      } catch (err) {
        throw new ChannelError(`WhatsApp API unreachable: ${(err as Error).message}`, true);
      }
      const data = (await res.json().catch(() => null)) as { messages?: { id: string }[]; error?: { message?: string } } | null;
      if (!res.ok || !data?.messages?.[0]?.id) {
        // 429 and 5xx are temporary; 4xx (expired token, invalid number) are not
        const retryable = res.status === 429 || res.status >= 500;
        throw new ChannelError(`WhatsApp API ${res.status}: ${data?.error?.message ?? "unexpected response"}`, retryable);
      }
      return { externalId: data.messages[0].id };
    },
  };
}

// Meta signs every webhook with the app secret (X-Hub-Signature-256: sha256=<hex>).
// Checking it over the raw body proves the request really came from Meta.
export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const received = Buffer.from(header.slice(7), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type InboundText = { phone: string; name: string | null; body: string; externalId: string };

type WebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: { from?: string; id?: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
};

// Pulls the text messages out of a webhook payload. Status updates (sent, read) and
// non-text messages are ignored here.
export function parseInbound(payload: unknown): InboundText[] {
  const out: InboundText[] = [];
  for (const entry of (payload as WebhookPayload)?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const m of value?.messages ?? []) {
        if (m.type !== "text" || !m.from || !m.id || !m.text?.body) continue;
        const contact = value?.contacts?.find((c) => c.wa_id === m.from);
        out.push({ phone: m.from, name: contact?.profile?.name ?? null, body: m.text.body, externalId: m.id });
      }
    }
  }
  return out;
}

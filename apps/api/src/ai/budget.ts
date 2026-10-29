import type { Responder } from "./responder.js";

// Caps how many AI calls happen per day (UTC). Past the cap, replies come from the
// fallback (the free demo responder), so a public demo with a real API key cannot
// run up the bill. The count lives in memory: right for one instance, and it starts
// over on restart, which only makes the cap more lenient, never stricter.
export function withDailyLimit(responder: Responder, fallback: Responder, limit: number, now: () => Date): Responder {
  let day = "";
  let used = 0;
  return {
    mode: responder.mode,
    async reply(input) {
      const today = now().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        used = 0;
      }
      if (used >= limit) return fallback.reply(input);
      used++;
      return responder.reply(input);
    },
  };
}

import { randomUUID } from "node:crypto";
import type { Channel } from "./channel.js";

// Built-in phone simulator: messages are "delivered" by storing them, and the
// simulator screen in the browser receives them through the live event stream.
// Lets anyone try the full flow without a WhatsApp Business account.
export const simulatorChannel: Channel = {
  name: "simulator",
  async send() {
    return { externalId: `sim-out-${randomUUID()}` };
  },
};

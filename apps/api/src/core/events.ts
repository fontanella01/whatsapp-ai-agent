import { EventEmitter } from "node:events";
import type { Conversation, Message } from "../db/schema.js";

export type ConversationView = Conversation & { contact: { id: string; phone: string; name: string | null } };

export type RelayEvent = { type: "message"; conversationId: string; message: Message } | { type: "conversation"; conversation: ConversationView };

// In-process publish/subscribe used to push changes to open browser tabs (SSE).
// With several API instances this would move to PostgreSQL LISTEN/NOTIFY or Redis;
// one instance is enough for this project.
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // one listener per open tab
    this.emitter.setMaxListeners(1000);
  }

  publish(event: RelayEvent) {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: RelayEvent) => void) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}

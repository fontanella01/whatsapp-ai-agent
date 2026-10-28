// Where outgoing messages go. The rest of the app only knows `send()`, so the same
// code runs against the built-in simulator, the real WhatsApp Cloud API or a test fake.
export interface Channel {
  readonly name: "simulator" | "whatsapp";
  send(to: string, body: string): Promise<{ externalId: string }>;
}

export class ChannelError extends Error {
  constructor(
    message: string,
    // false for problems a retry will not fix (bad token, invalid number)
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

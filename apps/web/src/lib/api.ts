// Thin wrapper around fetch: adds the token, parses JSON and turns API errors
// into exceptions with a readable message.

export type User = { id: string; name: string; email: string };
export type Mode = "ai" | "human";
export type Sender = "customer" | "ai" | "agent" | "system";

export type Message = {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  sender: Sender;
  body: string;
  delivery: "received" | "pending" | "sent" | "failed";
  createdAt: string;
  seq: number;
};

export type Conversation = {
  id: string;
  mode: Mode;
  status: "open" | "closed";
  assigneeId: string | null;
  handoffReason: string | null;
  lastMessageAt: string;
  contact: { id: string; phone: string; name: string | null };
  lastMessage?: { body: string; sender: Sender } | null;
};

export type ConversationDetail = Conversation & { messages: Message[] };
export type Doc = { id: string; title: string; body: string; updatedAt: string; chunks: number };
export type Hit = { documentId: string; title: string; content: string; rank: number };
export type Stats = {
  openWithAi: number;
  openWithTeam: number;
  last24h: { received: number; aiReplies: number; teamReplies: number; failed: number; aiShare: number | null };
};
export type AppConfig = { demo: boolean; ai: "ai" | "demo"; channel: "simulator" | "whatsapp"; businessName: string };

export type LiveEvent = { type: "message"; conversationId: string; message: Message } | { type: "conversation"; conversation: Conversation };

const TOKEN_KEY = "relay_token";

// Kept in localStorage for simplicity; an httpOnly cookie would be safer
// (listed as a next step in the README).
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  config: () => request<AppConfig>("GET", "/auth/config"),
  login: (b: { email: string; password: string }) => request<{ token: string; user: User }>("POST", "/auth/login", b),
  demo: () => request<{ token: string; user: User }>("POST", "/auth/demo"),
  me: () => request<User>("GET", "/auth/me"),
  stats: () => request<Stats>("GET", "/stats"),

  conversations: (f: { status?: "open" | "closed"; mode?: Mode } = {}) => {
    const q = new URLSearchParams();
    if (f.status) q.set("status", f.status);
    if (f.mode) q.set("mode", f.mode);
    return request<Conversation[]>("GET", `/conversations?${q}`);
  },
  conversation: (id: string) => request<ConversationDetail>("GET", `/conversations/${id}`),
  reply: (id: string, body: string) => request<Message>("POST", `/conversations/${id}/messages`, { body }),
  takeover: (id: string) => request<Conversation>("POST", `/conversations/${id}/takeover`),
  release: (id: string) => request<Conversation>("POST", `/conversations/${id}/release`),
  close: (id: string) => request<Conversation>("POST", `/conversations/${id}/close`),

  documents: () => request<Doc[]>("GET", "/documents"),
  saveDocument: (b: { title: string; body: string }, id?: string) =>
    id ? request<Doc>("PUT", `/documents/${id}`, b) : request<Doc>("POST", "/documents", b),
  deleteDocument: (id: string) => request<null>("DELETE", `/documents/${id}`),
  search: (q: string) => request<Hit[]>("GET", `/documents/search?q=${encodeURIComponent(q)}`),

  simulate: (b: { phone: string; name: string; body: string }) => request<{ conversationId: string }>("POST", "/simulator/messages", b),
  simulatorThread: (phone: string) => request<{ conversationId: string | null; messages: Message[] }>("GET", `/simulator/thread?phone=${phone}`),
};

// Inserts or replaces a message by id, keeping arrival order. Live events and API
// responses can arrive in any order, so every update goes through here.
export function upsertMessage(list: Message[], m: Message): Message[] {
  const rest = list.filter((x) => x.id !== m.id);
  return [...rest, m].sort((a, b) => a.seq - b.seq);
}

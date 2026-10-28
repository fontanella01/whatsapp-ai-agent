import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, upsertMessage, type Message } from "../lib/api";
import { useLiveEvents } from "../lib/live";
import { clock } from "./badges";
import { cx } from "./ui";

// Sample customers the visitor can play.
const CUSTOMERS = [
  { name: "Bruno Alves", phone: "5547988881234" },
  { name: "Marina Souza", phone: "5547988885678" },
  { name: "Diego Lima", phone: "5547988889012" },
];

const SUGGESTIONS = [
  "Are you open on Saturday?",
  "How much is teeth whitening?",
  "Do you accept the OdontoPrev plan?",
  "Is there parking?",
  "I'd like to book a cleaning",
  "Can I talk to a person?",
];

// A phone where the visitor plays the customer. Messages go through the same path
// as real WhatsApp messages; replies arrive through the live event stream.
export function PhoneSimulator({ businessName, onHide }: { businessName: string; onHide: () => void }) {
  const [who, setWho] = useState(CUSTOMERS[0]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setConversationId(null);
    api
      .simulatorThread(who.phone)
      .then((t) => {
        setConversationId(t.conversationId);
        setMessages(t.messages);
      })
      .catch(() => {});
  }, [who]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, waiting]);

  useLiveEvents((e) => {
    if (e.type !== "message" || e.conversationId !== conversationId) return;
    setMessages((list) => upsertMessage(list, e.message));
    if (e.message.direction === "out") setWaiting(false);
  });

  const send = async (text: string) => {
    const body = text.trim();
    if (!body) return;
    setDraft("");
    setWaiting(true);
    try {
      const res = await api.simulate({ phone: who.phone, name: who.name, body });
      if (res.conversationId !== conversationId) {
        // first message from this customer: load the thread now that it exists
        setConversationId(res.conversationId);
        setMessages((await api.simulatorThread(who.phone)).messages);
      }
    } catch {
      setWaiting(false);
    }
    // a person may answer much later; stop showing "typing" after a while
    setTimeout(() => setWaiting(false), 15_000);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-y-auto bg-slate-200 p-4 xl:bg-slate-200/60">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">Customer's phone (simulator)</h2>
        <div className="flex items-center gap-1">
        <select
          aria-label="Customer"
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
          value={who.phone}
          onChange={(e) => setWho(CUSTOMERS.find((c) => c.phone === e.target.value)!)}
        >
          {CUSTOMERS.map((c) => (
            <option key={c.phone} value={c.phone}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={onHide} className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white" aria-label="Hide the phone">
          Hide
        </button>
        </div>
      </div>

      <div className="mx-auto flex h-[34rem] w-full max-w-[20rem] shrink-0 flex-col overflow-hidden rounded-[2rem] border-[6px] border-phone bg-phone shadow-xl">
        <div className="flex items-center gap-2 bg-[#1f2c34] px-3 py-2.5 text-white">
          <span aria-hidden className="grid size-8 place-items-center rounded-full bg-brand-500 text-sm font-bold">
            {businessName.charAt(0)}
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">{businessName}</p>
            <p className="text-[11px] text-slate-300">{waiting ? "typing…" : "business account"}</p>
          </div>
        </div>

        <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-[#efeae2] px-2.5 py-3">
          {messages.length === 0 && (
            <li className="mx-auto my-6 max-w-[85%] rounded-lg bg-[#fff5c4] px-3 py-2 text-center text-[11px] text-slate-700">
              You are {who.name}. Send a message to {businessName}, or tap a suggestion below.
            </li>
          )}
          {messages.map((m) => {
            const mine = m.direction === "in"; // the customer's own messages
            return (
              <li key={m.id} className={cx("flex", mine ? "justify-end" : "justify-start")}>
                <p className={cx("max-w-[85%] rounded-lg px-2.5 py-1.5 text-[13px] shadow-sm", mine ? "rounded-tr-none bg-bubble-out" : "rounded-tl-none bg-white")}>
                  <span className="whitespace-pre-wrap">{m.body}</span>
                  <span className="ml-2 inline-block translate-y-0.5 text-[10px] text-slate-500">{clock(m.createdAt)}</span>
                </p>
              </li>
            );
          })}
          {waiting && (
            <li className="flex justify-start">
              <p className="rounded-lg rounded-tl-none bg-white px-3 py-2 text-[13px] text-slate-400 shadow-sm">• • •</p>
            </li>
          )}
          <div ref={bottom} />
        </ol>

        <form onSubmit={submit} className="flex gap-1.5 bg-[#f0f2f5] p-2">
          <input
            aria-label="Message"
            className="min-w-0 flex-1 rounded-full bg-white px-3.5 py-2 text-[13px] outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Message"
            value={draft}
            maxLength={4096}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={!draft.trim()} className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-600 text-white disabled:opacity-50" aria-label="Send as customer">
            ➤
          </button>
        </form>
      </div>

      <div className="mx-auto w-full max-w-[20rem]">
        <p className="mb-2 text-xs font-medium text-slate-600">Try asking</p>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} className="rounded-full bg-white px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-300 hover:ring-brand-500">
              {s}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

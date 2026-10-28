import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ConversationDetail, type Message } from "../lib/api";
import { ModeBadge, clock, displayName, formatPhone } from "./badges";
import { Button, ErrorText, Textarea, cx } from "./ui";

const SENDER_LABEL: Record<Message["sender"], string> = { customer: "Customer", ai: "AI", agent: "Team", system: "System" };

function Delivery({ m }: { m: Message }) {
  if (m.direction === "in") return null;
  if (m.delivery === "failed") return <span className="font-semibold text-red-700">Not delivered</span>;
  if (m.delivery === "pending") return <span title="Sending">Sending…</span>;
  return <span title="Delivered">✓</span>;
}

export function Thread({ conversation, onChange }: { conversation: ConversationDetail; onChange: (c: ConversationDetail) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const c = conversation;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [c.messages.length, c.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    act(async () => {
      await api.reply(c.id, draft);
      setDraft("");
    });
  };

  // state changes come back through the live stream too; applying the response
  // right away keeps the screen in step even before the event arrives
  const change = (fn: (id: string) => Promise<unknown>) => act(async () => onChange({ ...c, ...((await fn(c.id)) as object) }));

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold">{displayName(c.contact)}</h2>
            <ModeBadge c={c} />
          </div>
          <p className="text-xs text-slate-500">{formatPhone(c.contact.phone)}</p>
        </div>
        <div className="flex gap-2">
          {c.status === "open" && c.mode === "ai" && (
            <Button variant="ghost" disabled={busy} onClick={() => change(api.takeover)}>
              Take over
            </Button>
          )}
          {c.status === "open" && c.mode === "human" && (
            <Button variant="ghost" disabled={busy} onClick={() => change(api.release)}>
              Hand back to AI
            </Button>
          )}
          {c.status === "open" && (
            <Button variant="ghost" disabled={busy} onClick={() => change(api.close)}>
              Close
            </Button>
          )}
        </div>
      </header>

      {c.status === "open" && c.mode === "human" && c.handoffReason && (
        <p className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-900">
          <strong>Handed to the team:</strong> {c.handoffReason}. The AI stays quiet until you hand it back.
        </p>
      )}

      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50 px-5 py-4">
        {c.messages.map((m) => {
          const out = m.direction === "out";
          return (
            <li key={m.id} className={cx("flex", out ? "justify-end" : "justify-start")}>
              <div
                className={cx(
                  "max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm",
                  !out && "rounded-bl-md bg-white",
                  out && m.sender === "ai" && "rounded-br-md bg-brand-50 ring-1 ring-brand-100",
                  out && m.sender !== "ai" && "rounded-br-md bg-emerald-50 ring-1 ring-emerald-100",
                )}
              >
                <p className="mb-0.5 text-[11px] font-semibold text-slate-500">{SENDER_LABEL[m.sender]}</p>
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="mt-1 flex justify-end gap-2 text-[11px] text-slate-400">
                  <time dateTime={m.createdAt}>{clock(m.createdAt)}</time>
                  <Delivery m={m} />
                </p>
              </div>
            </li>
          );
        })}
        <div ref={bottom} />
      </ol>

      <form onSubmit={send} className="space-y-2 border-t border-slate-200 p-4">
        <Textarea
          aria-label="Reply"
          className="min-h-20"
          value={draft}
          maxLength={4096}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          placeholder={`Reply to ${displayName(c.contact)}…`}
        />
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {c.mode === "ai" && c.status === "open" ? "Sending a reply takes the conversation over from the AI." : "Enter to send, Shift+Enter for a new line."}
          </p>
          <Button type="submit" disabled={busy || !draft.trim()}>
            Send
          </Button>
        </div>
      </form>
    </section>
  );
}

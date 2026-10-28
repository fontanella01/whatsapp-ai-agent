import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, upsertMessage, type AppConfig, type Conversation, type ConversationDetail, type Mode, type Stats } from "../lib/api";
import { useLiveEvents } from "../lib/live";
import { ModeBadge, displayName, timeAgo } from "../components/badges";
import { Thread } from "../components/Thread";
import { PhoneSimulator } from "../components/PhoneSimulator";
import { ErrorText, cx } from "../components/ui";

type Tab = "all" | "human" | "ai" | "closed";
const TABS: [Tab, string][] = [
  ["all", "Open"],
  ["human", "Needs a person"],
  ["ai", "With AI"],
  ["closed", "Closed"],
];

const matches = (c: Conversation, tab: Tab) => (tab === "closed" ? c.status === "closed" : c.status === "open" && (tab === "all" || c.mode === tab));
const byRecent = (a: Conversation, b: Conversation) => b.lastMessageAt.localeCompare(a.lastMessageAt);

export function InboxPage() {
  const { id: selectedId } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("all");
  const [list, setList] = useState<Conversation[] | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [showPhone, setShowPhone] = useState(true);
  // on smaller screens the phone opens over the inbox
  const [phoneOverlay, setPhoneOverlay] = useState(false);
  const [error, setError] = useState("");

  const refreshStats = () => api.stats().then(setStats).catch(() => {});

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
    refreshStats();
  }, []);

  useEffect(() => {
    setList(null);
    const filter = tab === "closed" ? { status: "closed" as const } : tab === "all" ? {} : { mode: tab as Mode };
    api
      .conversations(filter)
      .then(setList)
      .catch((e) => setError(e.message));
  }, [tab]);

  useEffect(() => {
    if (!selectedId) return setDetail(null);
    api
      .conversation(selectedId)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [selectedId]);

  // Everything on screen follows the live stream: new messages, AI replies,
  // handoffs, and what other agents do.
  useLiveEvents((e) => {
    if (e.type === "conversation") {
      const c = e.conversation;
      setList((l) => {
        if (!l) return l;
        const prev = l.find((x) => x.id === c.id);
        const rest = l.filter((x) => x.id !== c.id);
        return matches(c, tab) ? [...rest, { ...c, lastMessage: prev?.lastMessage ?? null }].sort(byRecent) : rest;
      });
      setDetail((d) => (d && d.id === c.id ? { ...d, ...c } : d));
    } else {
      const m = e.message;
      setList((l) => l?.map((x) => (x.id === e.conversationId ? { ...x, lastMessage: { body: m.body, sender: m.sender }, lastMessageAt: m.createdAt } : x)).sort(byRecent) ?? l);
      setDetail((d) => (d && d.id === e.conversationId ? { ...d, messages: upsertMessage(d.messages, m) } : d));
    }
    refreshStats();
  });

  const business = config?.businessName ?? "Aurora Dental Clinic";

  return (
    <div className="flex h-full">
      <section className={cx("flex w-full flex-col border-r border-slate-200 bg-white md:w-80 md:shrink-0", selectedId && "hidden md:flex")}>
        {stats && (
          <dl className="grid grid-cols-3 gap-px border-b border-slate-200 bg-slate-200 text-center">
            {[
              ["With AI", stats.openWithAi],
              ["With team", stats.openWithTeam],
              ["AI replies (24h)", stats.last24h.aiShare === null ? "—" : `${stats.last24h.aiShare}%`],
            ].map(([label, value]) => (
              <div key={label} className="bg-white px-2 py-2.5">
                <dt className="text-[11px] text-slate-500">{label}</dt>
                <dd className="text-lg font-bold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div role="tablist" aria-label="Filter conversations" className="flex flex-wrap gap-1 border-b border-slate-200 p-2 text-sm">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cx("shrink-0 rounded-md px-2.5 py-1 font-medium", tab === value ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        <ErrorText>{error}</ErrorText>
        <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
          {list === null && <li className="p-4 text-sm text-slate-500">Loading…</li>}
          {list?.length === 0 && (
            <li className="p-6 text-center text-sm text-slate-500">
              {tab === "human" ? "Nobody is waiting for a person." : "No conversations here. Send a message from the phone simulator."}
            </li>
          )}
          {list?.map((c) => (
            <li key={c.id}>
              <Link to={`/inbox/${c.id}`} className={cx("block px-4 py-3 hover:bg-slate-50", c.id === selectedId && "bg-brand-50/60")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{displayName(c.contact)}</span>
                  <span className="shrink-0 text-xs text-slate-400">{timeAgo(c.lastMessageAt)}</span>
                </div>
                <p className="truncate text-sm text-slate-500">
                  {c.lastMessage ? `${c.lastMessage.sender === "customer" ? "" : c.lastMessage.sender === "ai" ? "AI: " : "Team: "}${c.lastMessage.body}` : "No messages"}
                </p>
                <ModeBadge c={c} className="mt-1.5" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <div className={cx("min-w-0 flex-1", !selectedId && "hidden md:flex")}>
        {detail ? (
          <div className="flex h-full flex-col">
            <button onClick={() => navigate("/inbox")} className="border-b border-slate-200 bg-white px-4 py-2 text-left text-sm font-semibold text-brand-600 md:hidden">
              ← Conversations
            </button>
            <Thread conversation={detail} onChange={setDetail} />
          </div>
        ) : (
          <div className="grid h-full w-full place-items-center p-8 text-center text-slate-500">
            <div className="max-w-sm space-y-2">
              <p className="font-semibold text-ink">Pick a conversation</p>
              <p className="text-sm">Or write to {business} from the customer's phone on the right. The AI answers in a few seconds, and you see it here live.</p>
            </div>
          </div>
        )}
      </div>

      <div className={cx("hidden w-[22rem] shrink-0 border-l border-slate-200 xl:block", !showPhone && "xl:hidden")}>
        <PhoneSimulator businessName={business} onHide={() => setShowPhone(false)} />
      </div>
      {phoneOverlay && (
        <div className="fixed inset-0 z-20 xl:hidden">
          <PhoneSimulator businessName={business} onHide={() => setPhoneOverlay(false)} />
        </div>
      )}
      {!phoneOverlay && (
        <button
          onClick={() => setPhoneOverlay(true)}
          className="fixed bottom-4 right-4 z-10 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white shadow-lg xl:hidden"
        >
          Customer phone
        </button>
      )}
      {!showPhone && (
        <button
          onClick={() => setShowPhone(true)}
          className="fixed bottom-4 right-4 hidden rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white shadow-lg xl:block"
        >
          Show customer phone
        </button>
      )}
    </div>
  );
}

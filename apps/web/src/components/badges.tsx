import type { Conversation } from "../lib/api";
import { cx } from "./ui";

// Who is answering, in color AND text so it reads without color too.
export function ModeBadge({ c, className }: { c: Pick<Conversation, "mode" | "status">; className?: string }) {
  const [label, style] =
    c.status === "closed"
      ? ["Closed", "bg-slate-100 text-slate-600 ring-slate-200"]
      : c.mode === "ai"
        ? ["AI answering", "bg-brand-50 text-brand-700 ring-brand-100"]
        : ["Needs a person", "bg-amber-50 text-amber-800 ring-amber-200"];
  return <span className={cx("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset", style, className)}>{label}</span>;
}

export const displayName = (c: Conversation["contact"]) => c.name ?? `+${c.phone}`;

export const formatPhone = (p: string) =>
  p.length === 13 ? `+${p.slice(0, 2)} ${p.slice(2, 4)} ${p.slice(4, 9)}-${p.slice(9)}` : `+${p}`;

export function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

import { useEffect, useState, type FormEvent } from "react";
import { api, type Doc, type Hit } from "../lib/api";
import { Button, ErrorText, Field, Input, Textarea } from "../components/ui";

type Draft = { id?: string; title: string; body: string };

export function KnowledgePage() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);

  const load = () =>
    api
      .documents()
      .then(setDocs)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await api.saveDocument({ title: draft.title, body: draft.body }, draft.id);
      setDraft(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: Doc) => {
    if (!confirm(`Delete "${d.title}"? The AI will stop using it.`)) return;
    await api.deleteDocument(d.id).catch((e) => setError(e.message));
    await load();
  };

  const test = async (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setHits(await api.search(question).catch(() => []));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Knowledge base</h1>
            <p className="max-w-xl text-sm text-slate-500">
              The AI answers only from these documents. When a question isn't covered here, it hands the conversation to your team instead of guessing.
            </p>
          </div>
          {!draft && <Button onClick={() => setDraft({ title: "", body: "" })}>New document</Button>}
        </div>

        <form onSubmit={test} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
          <label htmlFor="q" className="text-sm font-semibold">
            Test a question
          </label>
          <div className="flex gap-2">
            <Input id="q" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Do you open on Saturdays?" />
            <Button type="submit" variant="ghost">
              Search
            </Button>
          </div>
          {hits && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">{hits.length ? "What the AI would read before answering, best match first:" : "Nothing matches: the AI would hand this question to your team."}</p>
              {hits.map((h, i) => (
                <p key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="font-semibold">{h.title}</span>
                  <span className="text-slate-600"> {h.content.slice(h.title.length + 1)}</span>
                </p>
              ))}
            </div>
          )}
        </form>

        {draft && (
          <form onSubmit={save} className="space-y-4 rounded-xl border border-brand-100 bg-white p-5">
            <Field label="Title">
              <Input required minLength={2} maxLength={160} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Opening hours" />
            </Field>
            <Field label="Content">
              <Textarea
                required
                className="min-h-48"
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder="Write it as you would explain it to a new team member. Separate topics with a blank line."
              />
            </Field>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save document"}
              </Button>
            </div>
          </form>
        )}

        {!draft && <ErrorText>{error}</ErrorText>}
        <ul className="space-y-3">
          {docs?.length === 0 && <li className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No documents yet. Add your hours, prices and policies.</li>}
          {docs?.map((d) => (
            <li key={d.id} className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold">{d.title}</h2>
                  <p className="text-xs text-slate-500">
                    {d.chunks} {d.chunks === 1 ? "section" : "sections"} indexed
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => setDraft({ id: d.id, title: d.title, body: d.body })}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => remove(d)}>
                    Delete
                  </Button>
                </div>
              </div>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-slate-600">{d.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

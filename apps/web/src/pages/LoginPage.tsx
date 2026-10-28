import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, type AppConfig } from "../lib/api";
import { Button, ErrorText, Field, Input } from "../components/ui";

export function LoginPage() {
  const { login, enterDemo } = useAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
  }, []);

  const run = async (action: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await action();
      navigate("/inbox");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => login(form.email, form.password));
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-ink p-12 text-white lg:flex">
        <span className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-brand-500 text-white">
            R
          </span>
          Relay
        </span>
        <div className="max-w-md space-y-4">
          <h2 className="text-3xl font-bold leading-tight">An AI agent that answers WhatsApp, and knows when to call a person.</h2>
          <p className="text-slate-300">
            It replies from your knowledge base, hands the conversation to your team when it can't help, and your team sees every message live.
          </p>
        </div>
        <span className="text-sm text-slate-400">Portfolio project · React, TypeScript, Node.js, PostgreSQL, Claude API</span>
      </aside>

      <div className="flex items-center justify-center bg-white p-6">
        <div className="w-full max-w-sm space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Sign in</h1>
            <p className="text-sm text-slate-500">The inbox for your support team.</p>
          </div>

          {config?.demo && (
            <div className="space-y-3 rounded-xl border border-brand-100 bg-brand-50 p-4">
              <p className="text-sm text-slate-700">See it working with a sample dental clinic. You play the customer on a simulated phone.</p>
              <Button className="w-full" disabled={busy} onClick={() => run(enterDemo)}>
                Try the demo
              </Button>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Password">
              <Input type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" variant={config?.demo ? "ghost" : "primary"} className="w-full" disabled={busy}>
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

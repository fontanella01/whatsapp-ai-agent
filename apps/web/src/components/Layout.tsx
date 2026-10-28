import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "./ui";

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-dvh flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link to="/inbox" className="flex items-center gap-2 text-base font-bold tracking-tight">
              <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-brand-600 text-sm text-white">
                R
              </span>
              Relay
            </Link>
            <nav className="flex gap-1 text-sm font-medium">
              {[
                ["/inbox", "Inbox"],
                ["/knowledge", "Knowledge"],
              ].map(([to, label]) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `rounded-md px-3 py-1.5 ${isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:text-ink"}`}
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{user?.name}</span>
            <Button variant="ghost" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

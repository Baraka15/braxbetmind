import { useEffect, useState } from "react";
import { createFileRoute, Outlet, redirect, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Activity, Settings as SettingsIcon, LogOut, History, CheckSquare, RadioTower } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // The PIN session lives in browser storage, so the server cannot validate
    // it on a hard load of /dashboard. Let the client-side guard validate it.
    if (typeof window === "undefined") return;
    // Strict guard: re-validate the JWT (not just a cached session) before
    // letting any child route render.
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [ready, setReady] = useState(false);

  // The route guard above owns initial auth validation. This listener only
  // handles later sign-out or token loss, avoiding a second login-time race.
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setReady(!!data.session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        setReady(false);
        nav({ to: "/login", replace: true });
        return;
      }
      setReady(true);
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        return;
      }
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [nav]);

  async function handleSignOut() {
    if (!confirm("Sign out of BetMind Pro?")) return;
    setReady(false);
    await supabase.auth.signOut();
    toast.success("Signed out");
    nav({ to: "/login", replace: true });
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <Link to="/dashboard" className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <span className="font-mono-num text-sm font-semibold tracking-tight">BetMind Pro</span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground md:inline">{user?.email}</span>
            <Button asChild variant="ghost" size="sm" aria-label="Backtest" title="Backtest">
              <Link to="/backtest">
                <History className="h-4 w-4" />
                <span className="ml-2 hidden sm:inline">Backtest</span>
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" aria-label="Live" title="Live in-play EV">
              <Link to="/live">
                <RadioTower className="h-4 w-4" />
                <span className="ml-2 hidden sm:inline">Live</span>
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" aria-label="Settlement" title="Settlement">
              <Link to="/settlement">
                <CheckSquare className="h-4 w-4" />
                <span className="ml-2 hidden sm:inline">Settlement</span>
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" aria-label="Settings" title="Settings">
              <Link to="/settings">
                <SettingsIcon className="h-4 w-4" />
                <span className="ml-2 hidden sm:inline">Settings</span>
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
              <span className="ml-2 hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6"><Outlet /></main>
    </div>
  );
}
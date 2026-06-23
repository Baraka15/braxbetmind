import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Activity } from "lucide-react";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — BetMind Pro" }] }),
  component: LoginPage,
});

const PIN = "20233";
// Fixed shared workspace account unlocked by the PIN. Supabase auth still
// runs underneath so RLS-protected reads/writes keep working.
const PIN_EMAIL = "pin-user@betmind.local";
const PIN_PASSWORD = "betmind-pin-20233-shared-account";

function LoginPage() {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pin !== PIN) {
      toast.error("Incorrect PIN");
      return;
    }
    setLoading(true);
    // Try signing in to the shared account; create it on first ever use.
    let { error } = await supabase.auth.signInWithPassword({
      email: PIN_EMAIL,
      password: PIN_PASSWORD,
    });
    if (error) {
      const { error: signUpErr } = await supabase.auth.signUp({
        email: PIN_EMAIL,
        password: PIN_PASSWORD,
      });
      if (!signUpErr) {
        ({ error } = await supabase.auth.signInWithPassword({
          email: PIN_EMAIL,
          password: PIN_PASSWORD,
        }));
      }
    }
    if (error) {
      setLoading(false);
      return toast.error(error.message);
    }
    toast.success("Welcome back");
    // Hard navigation guarantees the new Supabase session is fully hydrated
    // in localStorage before the _authenticated gate re-validates getUser().
    window.location.assign("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-8">
        <div className="flex items-center gap-2"><Activity className="h-5 w-5 text-primary" /><span className="font-semibold">BetMind Pro</span></div>
        <h1 className="text-xl font-semibold">Enter PIN</h1>
        <p className="text-sm text-muted-foreground">Access BetMind Pro with your 5-digit PIN.</p>
        <div className="space-y-2">
          <Label htmlFor="pin">PIN</Label>
          <Input
            id="pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={5}
            required
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="•••••"
            className="text-center tracking-[0.6em] text-lg"
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>{loading ? "Unlocking…" : "Unlock"}</Button>
      </form>
    </div>
  );
}
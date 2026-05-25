import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getUserSettings, updateSettings } from "@/lib/bets.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — BetMind Pro" }] }),
  component: SettingsPage,
});

const LEAGUES = [
  { key: "soccer_epl", label: "Premier League" },
  { key: "soccer_uefa_champs_league", label: "Champions League" },
  { key: "soccer_spain_la_liga", label: "La Liga" },
  { key: "soccer_italy_serie_a", label: "Serie A" },
  { key: "soccer_germany_bundesliga", label: "Bundesliga" },
  { key: "soccer_france_ligue_one", label: "Ligue 1" },
];

function SettingsPage() {
  const qc = useQueryClient();
  const fetchSettings = useServerFn(getUserSettings);
  const save = useServerFn(updateSettings);
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => fetchSettings() });

  const [form, setForm] = useState({
    bankroll: 1000, kelly_fraction: 0.5, min_edge: 0.02,
    max_stake_pct: 0.05, max_daily_bets: 10,
    tracked_leagues: LEAGUES.slice(0, 5).map((l) => l.key),
  });

  useEffect(() => {
    if (data) setForm({
      bankroll: Number(data.bankroll), kelly_fraction: Number(data.kelly_fraction),
      min_edge: Number(data.min_edge), max_stake_pct: Number(data.max_stake_pct),
      max_daily_bets: data.max_daily_bets, tracked_leagues: data.tracked_leagues,
    });
  }, [data]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await save({ data: form });
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) { toast.error((e as Error).message); }
  }

  function toggleLeague(key: string) {
    setForm((f) => ({
      ...f,
      tracked_leagues: f.tracked_leagues.includes(key)
        ? f.tracked_leagues.filter((x) => x !== key)
        : [...f.tracked_leagues, key],
    }));
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Bankroll ($)"><Input type="number" step="1" value={form.bankroll} onChange={(e) => setForm({ ...form, bankroll: +e.target.value })} /></Field>
        <Field label="Kelly fraction (0–1)"><Input type="number" step="0.05" min="0" max="1" value={form.kelly_fraction} onChange={(e) => setForm({ ...form, kelly_fraction: +e.target.value })} /></Field>
        <Field label="Minimum edge (0–1)"><Input type="number" step="0.005" min="0" max="1" value={form.min_edge} onChange={(e) => setForm({ ...form, min_edge: +e.target.value })} /></Field>
        <Field label="Max stake %"><Input type="number" step="0.01" min="0" max="1" value={form.max_stake_pct} onChange={(e) => setForm({ ...form, max_stake_pct: +e.target.value })} /></Field>
        <Field label="Max daily bets"><Input type="number" step="1" min="1" max="100" value={form.max_daily_bets} onChange={(e) => setForm({ ...form, max_daily_bets: +e.target.value })} /></Field>
      </div>
      <div>
        <Label className="mb-3 block">Tracked leagues</Label>
        <div className="flex flex-wrap gap-2">
          {LEAGUES.map((l) => {
            const on = form.tracked_leagues.includes(l.key);
            return (
              <button key={l.key} type="button" onClick={() => toggleLeague(l.key)}
                className={`rounded-full border px-3 py-1 text-xs ${on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                {l.label}
              </button>
            );
          })}
        </div>
      </div>
      <Button type="submit">Save</Button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}
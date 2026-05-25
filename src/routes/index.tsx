import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Activity, TrendingUp, Zap, Target } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BetMind Pro — Real-Time AI Football Value Bets" },
      { name: "description", content: "Scan sharp bookmaker odds in real time, find AI-detected value bets, and stake optimally with the Kelly criterion." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <span className="font-mono-num text-base font-semibold tracking-tight">BetMind Pro</span>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="ghost" size="sm"><Link to="/login">Sign in</Link></Button>
            <Button asChild size="sm"><Link to="/signup">Get started</Link></Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-20">
        <section className="max-w-3xl">
          <p className="font-mono-num text-xs uppercase tracking-[0.25em] text-primary">Live · Football · Value Bets</p>
          <h1 className="mt-4 text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            Find +EV football bets the moment the market mispriced them.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            BetMind Pro scans sharp bookmakers — Pinnacle, Betfair, Circa — in real time,
            compares them to an AI prediction engine, and sizes stakes with the Kelly criterion.
          </p>
          <div className="mt-8 flex gap-3">
            <Button asChild size="lg"><Link to="/signup">Start free</Link></Button>
            <Button asChild size="lg" variant="outline"><Link to="/login">Sign in</Link></Button>
          </div>
        </section>

        <section className="mt-24 grid gap-6 md:grid-cols-3">
          {[
            { icon: Zap, title: "Sharp odds scanning", body: "60-second refresh from the books that move the market." },
            { icon: Target, title: "Edge detection", body: "AI vs. overround-adjusted implied probability, filtered by your edge threshold." },
            { icon: TrendingUp, title: "Kelly staking", body: "Fractional Kelly, capped at your max stake — bankroll-safe by default." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-lg border border-border bg-card p-6">
              <Icon className="h-5 w-5 text-primary" />
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}

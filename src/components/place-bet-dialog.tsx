import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { placeBet } from "@/lib/bets.functions";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export interface PlaceableBet {
  id: string;
  bookmaker: string;
  best_odds: number;
  edge_pct: number;
  ai_prob: number;
  market: string;
  selection: string;
  kelly_stake_pct: number;
  matches: { home: string; away: string } | null;
}

export function PlaceBetDialog({
  bet, bankroll, open, onOpenChange,
}: {
  bet: PlaceableBet | null;
  bankroll: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const place = useServerFn(placeBet);
  const suggested = bet ? Math.max(1, Math.round(bet.kelly_stake_pct * bankroll * 100) / 100) : 0;
  const [stake, setStake] = useState(suggested);
  const [odds, setOdds] = useState(bet?.best_odds ?? 0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bet) { setStake(suggested); setOdds(bet.best_odds); setNote(""); }
  }, [bet, suggested]);

  if (!bet) return null;
  const payout = stake * odds;
  const profit = payout - stake;
  const evDollars = (bet.ai_prob * profit) - ((1 - bet.ai_prob) * stake);

  async function submit() {
    if (!bet) return;
    setBusy(true);
    try {
      await place({ data: { betId: bet.id, stake, odds, note: note.trim() || null } });
      toast.success("Bet logged as placed");
      qc.invalidateQueries({ queryKey: ["bets"] });
      onOpenChange(false);
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Place bet</DialogTitle>
          <DialogDescription className="text-xs">
            {bet.matches?.home} vs {bet.matches?.away} · <span className="uppercase">{bet.selection}</span> @ {bet.best_odds.toFixed(2)} ({bet.bookmaker})
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stake ($)">
              <Input type="number" step="0.01" min="0" value={stake}
                onChange={(e) => setStake(parseFloat(e.target.value) || 0)} />
            </Field>
            <Field label="Odds taken">
              <Input type="number" step="0.01" min="1.01" value={odds}
                onChange={(e) => setOdds(parseFloat(e.target.value) || 0)} />
            </Field>
          </div>
          <Field label="Note (optional)">
            <Textarea rows={2} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ticket ref, account, anything to remember" />
          </Field>
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs font-mono-num">
            <Row k="Suggested (Kelly)" v={`$${suggested.toFixed(2)}`} />
            <Row k="Potential payout" v={`$${payout.toFixed(2)}`} />
            <Row k="Potential profit" v={`$${profit.toFixed(2)}`} />
            <Row k="Model EV" v={`${evDollars >= 0 ? "+" : ""}$${evDollars.toFixed(2)}`} positive={evDollars >= 0} />
            <Row k="Edge at scan" v={`+${(bet.edge_pct * 100).toFixed(2)}%`} positive />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || stake <= 0 || odds < 1.01}>Log placement</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-xs">{label}</Label>{children}</div>;
}
function Row({ k, v, positive }: { k: string; v: string; positive?: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className={positive ? "text-emerald-400" : ""}>{v}</span>
    </div>
  );
}
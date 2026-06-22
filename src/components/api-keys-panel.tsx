import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listApiKeys, createApiKey, revokeApiKey } from "@/lib/api-keys.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Copy, Trash2 } from "lucide-react";

export function ApiKeysPanel() {
  const qc = useQueryClient();
  const list = useServerFn(listApiKeys);
  const create = useServerFn(createApiKey);
  const revoke = useServerFn(revokeApiKey);
  const { data: keys = [] } = useQuery({ queryKey: ["api-keys"], queryFn: () => list() });
  const [name, setName] = useState("");
  const [rate, setRate] = useState(60);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  async function onCreate() {
    if (!name.trim()) return toast.error("Name is required");
    try {
      const r = await create({ data: { name: name.trim(), rate_limit_per_min: rate } });
      setJustCreated(r.plaintext);
      setName("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (e) { toast.error((e as Error).message); }
  }

  async function onRevoke(id: string) {
    if (!confirm("Revoke this key? Any system using it will stop working immediately.")) return;
    try {
      await revoke({ data: { id } });
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("Key revoked");
    } catch (e) { toast.error((e as Error).message); }
  }

  function copy(s: string) {
    navigator.clipboard.writeText(s).then(() => toast.success("Copied"));
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">API Access</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Authenticated, rate-limited REST endpoints for third-party systems. Send the key in the <code className="font-mono-num">X-Api-Key</code> header.
        </p>
        <ul className="mt-2 space-y-1 text-xs font-mono-num text-muted-foreground">
          <li>GET /api/public/v1/picks?min_edge=0.03&amp;limit=25</li>
          <li>GET /api/public/v1/predictions?match_id=…</li>
          <li>GET /api/public/v1/sharp-moves?limit=30</li>
        </ul>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_140px_auto]">
        <div className="space-y-1">
          <Label className="text-xs">Key name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trading desk #1" maxLength={64} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Req / min</Label>
          <Input type="number" min={1} max={600} value={rate} onChange={(e) => setRate(parseInt(e.target.value) || 60)} />
        </div>
        <div className="flex items-end"><Button type="button" onClick={onCreate}>Create key</Button></div>
      </div>

      {justCreated && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs">
          <div className="mb-1 font-semibold text-emerald-300">New key — copy now, it will not be shown again.</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-background p-2 font-mono-num">{justCreated}</code>
            <Button size="sm" variant="outline" onClick={() => copy(justCreated)}><Copy className="h-3 w-3" /></Button>
          </div>
          <button type="button" className="mt-2 text-muted-foreground underline" onClick={() => setJustCreated(null)}>Dismiss</button>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Prefix</th>
              <th className="px-3 py-2 text-right">Limit</th>
              <th className="px-3 py-2 text-left">Last used</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No keys yet.</td></tr>
            )}
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-border">
                <td className="px-3 py-2">{k.name}</td>
                <td className="px-3 py-2 font-mono-num">{k.prefix}…</td>
                <td className="px-3 py-2 text-right font-mono-num">{k.rate_limit_per_min}/min</td>
                <td className="px-3 py-2 text-muted-foreground">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "—"}</td>
                <td className="px-3 py-2">{k.revoked_at ? <span className="text-destructive">revoked</span> : <span className="text-emerald-400">active</span>}</td>
                <td className="px-3 py-2 text-right">
                  {!k.revoked_at && (
                    <Button size="sm" variant="ghost" onClick={() => onRevoke(k.id)}><Trash2 className="h-3 w-3" /></Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, TextArea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Badge, ErrorState, PageHeader, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { day } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Settings = {
  tasks: Record<string, { models: string[]; temperature: number }>;
  prices: Record<string, { input_per_mtok?: number; output_per_mtok?: number; per_minute?: number }>;
  credit_costs: Record<string, number>;
  daily_budget_usd: number;
  providers: Record<string, { ready: boolean; source: string | null; key: string | null }>;
  transcription: { configured: boolean };
};
type Prompt = { id: string; task: string; version: number; system: string; template: string; active: boolean; weight: number; note: string; created_at: string };
type StatRow = { task: string; prompt: string | null; provider: string | null; model: string | null; status: string; calls: number; cost_usd: number; unpriced: number; avg_ms: number; acceptance: number | null };

const COST_LABEL: Record<string, string> = { metadata: "Texto da publicação", highlights: "Cortes com IA", transcription_per_minute: "Transcrição (por minuto)", subtitles_burn: "Legendas gravadas", ideas: "Ideias com IA", script: "Roteiro com IA", script_edit: "Ajuste de roteiro" };

export default function AiAdminPage() {
  const toast = useToast();
  const settings = useApi<{ settings: Settings; spent_today_usd: number }>("/api/v1/admin/ai/settings");
  const prompts = useApi<{ items: Prompt[] }>("/api/v1/admin/ai/prompts");
  const stats = useApi<{ items: StatRow[] }>("/api/v1/admin/ai/stats?days=30");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState<null | { task: string; system: string; template: string; weight: string; note: string }>(null);
  const s = settings.data?.settings;


  async function save(key: string, path: string, body: unknown, ok: string) {
    setBusy(key);
    try {
      await api(path, { method: path.endsWith("/keys") || path.endsWith("/settings") ? "PUT" : "POST", body });
      toast("success", ok);
      void settings.reload();
      void prompts.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível salvar.");
    } finally {
      setBusy(null);
    }
  }

  if (settings.error) return <ErrorState message={settings.error.message} onRetry={settings.reload} />;
  if (!s) return <Skeleton className="h-96 rounded-xl" />;

  return (
    <>
      <PageHeader title="Inteligência artificial" description={`Gasto de hoje: US$ ${settings.data!.spent_today_usd.toFixed(2)} de US$ ${s.daily_budget_usd.toFixed(2)} (teto diário).`} />
      <div className="grid gap-6">
        <Panel>
          <PanelHeader title="Provedores e chaves" description="Chaves guardadas criptografadas. Valem por cima das do .env. Deixe vazio e salve para voltar a usar a do .env." />
          <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
            {Object.entries(s.providers).map(([p, v]) => (
              <div key={p} className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{p === "local" ? "Modelo local (URL)" : p}</span>
                  {v.ready ? <Badge tone="success">{v.source === "admin" ? "Chave do admin" : "Chave do .env"} {v.key}</Badge> : <Badge>Sem chave</Badge>}
                </div>
                <Field
                  label={`Nova chave de ${p}`}
                  hideLabel
                  type={p === "local" ? "url" : "password"}
                  autoComplete="off"
                  placeholder={p === "local" ? "http://ollama:11434/v1" : "Cole a chave nova"}
                  value={keys[p] ?? ""}
                  onChange={(e) => setKeys({ ...keys, [p]: e.target.value })}
                />
              </div>
            ))}
            <div className="md:col-span-2">
              <Button variant="primary" pending={busy === "keys"} disabled={!Object.keys(keys).length} onClick={async () => { await save("keys", "/api/v1/admin/ai/keys", keys, "Chaves salvas."); setKeys({}); }}>
                Salvar chaves
              </Button>
            </div>
          </div>
        </Panel>

        <SettingsForms key={JSON.stringify(s)} settings={s} busy={busy} save={save} />

        <Panel>
          <PanelHeader
            title="Prompts (teste A/B)"
            description="Versões ativas dividem as chamadas pelo peso; cada pessoa cai sempre na mesma versão."
            actions={<Button size="sm" variant="outline" onClick={() => setNewPrompt({ task: "metadata", system: "", template: "", weight: "50", note: "" })} icon={<Plus aria-hidden className="h-3.5 w-3.5" />}>Nova versão</Button>}
          />
          {!prompts.data ? (
            <div className="p-5"><Skeleton className="h-24" /></div>
          ) : (
            <ul className="divide-y divide-line">
              {prompts.data.items.map((p) => {
                const row = stats.data?.items.find((r) => r.prompt === p.id && r.status === "ok");
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                    <span className="w-36 font-mono text-ink">{p.id}</span>
                    {p.active && p.weight > 0 ? <Badge tone="success">Ativa · peso {p.weight}</Badge> : <Badge>Pausada</Badge>}
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">{p.note || `criada em ${day(p.created_at)}`}</span>
                    <span className="text-xs text-muted">
                      {row ? `${row.calls} chamadas · aceitação ${row.acceptance === null ? "-" : `${Math.round(row.acceptance * 100)}%`}` : "sem chamadas"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await api(`/api/v1/admin/ai/prompts/${encodeURIComponent(p.id)}`, { method: "PATCH", body: { active: !p.active } });
                          void prompts.reload();
                        } catch (err) {
                          toast("error", err instanceof ApiError ? err.message : "Não foi possível mudar.");
                        }
                      }}
                    >
                      {p.active ? "Pausar" : "Ativar"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Uso nos últimos 30 dias" />
          {!stats.data ? (
            <div className="p-5"><Skeleton className="h-24" /></div>
          ) : stats.data.items.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">Nenhuma chamada de IA ainda.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    {["Tarefa", "Modelo", "Situação", "Chamadas", "Custo", "Tempo médio"].map((h) => (
                      <th key={h} scope="col" className="px-5 py-2.5 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {stats.data.items.map((r, i) => (
                    <tr key={i}>
                      <td className="px-5 py-2.5 text-ink">{COST_LABEL[r.task] ?? r.task}</td>
                      <td className="px-5 py-2.5 font-mono text-xs text-ink-2">{r.provider ? `${r.provider}:${r.model}` : "-"}</td>
                      <td className="px-5 py-2.5"><Badge tone={r.status === "ok" ? "success" : "danger"}>{r.status === "ok" ? "OK" : "Falhou"}</Badge></td>
                      <td className="px-5 py-2.5 font-mono text-ink-2">{r.calls}</td>
                      <td className="px-5 py-2.5 font-mono text-ink-2">US$ {r.cost_usd.toFixed(4)}{r.unpriced ? <span className="ml-1 text-xs text-warning">({r.unpriced} sem preço)</span> : null}</td>
                      <td className="px-5 py-2.5 font-mono text-ink-2">{(r.avg_ms / 1000).toFixed(1)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Dialog
        open={Boolean(newPrompt)}
        onClose={() => setNewPrompt(null)}
        size="lg"
        title="Nova versão de prompt"
        description="As variáveis usam $nome (ex.: $title, $transcript). O texto entre <dados> nunca é instrução."
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewPrompt(null)}>Cancelar</Button>
            <Button
              variant="primary"
              pending={busy === "prompt"}
              disabled={!newPrompt || newPrompt.system.length < 10 || newPrompt.template.length < 10}
              onClick={async () => {
                await save("prompt", "/api/v1/admin/ai/prompts", { ...newPrompt, weight: Number(newPrompt!.weight) }, "Versão criada.");
                setNewPrompt(null);
              }}
            >
              Criar versão
            </Button>
          </>
        }
      >
        {newPrompt ? (
          <div className="grid gap-4">
            <Notice tone="info">A versão nova entra no teste junto com as ativas. Pause a antiga quando a nova vencer.</Notice>
            <div className="grid grid-cols-2 gap-3">
              <Select label="Tarefa" value={newPrompt.task} onChange={(e) => setNewPrompt({ ...newPrompt, task: e.target.value })}>
                <option value="metadata">Texto da publicação</option>
                <option value="highlights">Cortes com IA</option>
                <option value="ideas">Ideias com IA</option>
                <option value="script">Roteiro com IA</option>
                <option value="script_edit">Ajuste de roteiro</option>
              </Select>
              <Field label="Peso (0 a 100)" type="number" min={0} max={100} value={newPrompt.weight} onChange={(e) => setNewPrompt({ ...newPrompt, weight: e.target.value })} />
            </div>
            <Field label="Nota" value={newPrompt.note} onChange={(e) => setNewPrompt({ ...newPrompt, note: e.target.value })} placeholder="O que muda nesta versão" />
            <TextArea label="Sistema" rows={4} value={newPrompt.system} onChange={(e) => setNewPrompt({ ...newPrompt, system: e.target.value })} />
            <TextArea label="Modelo do pedido" rows={10} value={newPrompt.template} onChange={(e) => setNewPrompt({ ...newPrompt, template: e.target.value })} className="font-mono" />
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function SettingsForms({
  settings: s,
  busy,
  save,
}: {
  settings: Settings;
  busy: string | null;
  save: (key: string, path: string, body: unknown, ok: string) => Promise<void>;
}) {
  const toast = useToast();
  const [models, setModels] = useState(() => Object.fromEntries(Object.entries(s.tasks).map(([t, v]) => [t, v.models.join("\n")])));
  const [costs, setCosts] = useState(() => Object.fromEntries(Object.entries(s.credit_costs).map(([k, v]) => [k, String(v)])));
  const [budget, setBudget] = useState(String(s.daily_budget_usd));
  const [prices, setPrices] = useState(JSON.stringify(s.prices, null, 2));
  return (
        <div className="grid gap-6 xl:grid-cols-2">
          <Panel>
            <PanelHeader title="Modelo por tarefa" description="Um por linha, na ordem de tentativa (provedor:modelo). Se um falha, vai o próximo." />
            <div className="grid gap-4 px-5 py-4">
              {Object.keys(s.tasks).map((t) => (
                <TextArea key={t} label={COST_LABEL[t] ?? t} rows={4} value={models[t] ?? ""} onChange={(e) => setModels({ ...models, [t]: e.target.value })} className="font-mono" />
              ))}
              <Button
                variant="outline"
                className="justify-self-start"
                pending={busy === "tasks"}
                onClick={() =>
                  save(
                    "tasks",
                    "/api/v1/admin/ai/settings",
                    { tasks: Object.fromEntries(Object.entries(models).map(([t, v]) => [t, { models: v.split("\n").map((x) => x.trim()).filter(Boolean), temperature: s.tasks[t].temperature }])) },
                    "Ordem dos modelos salva.",
                  )
                }
              >
                Salvar modelos
              </Button>
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Créditos, teto e preços" />
            <div className="grid gap-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(costs).map(([k, v]) => (
                  <Field key={k} label={COST_LABEL[k] ?? k} type="number" min={0} value={v} onChange={(e) => setCosts({ ...costs, [k]: e.target.value })} />
                ))}
              </div>
              <Field label="Teto de gasto por dia (US$)" type="number" min={0} step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} />
              <TextArea label="Preços (US$ por milhão de tokens; transcrição por minuto)" rows={6} value={prices} onChange={(e) => setPrices(e.target.value)} className="font-mono" hint='Ex.: {"gemini:gemini-flash-latest": {"input_per_mtok": 0.3, "output_per_mtok": 2.5}}' />
              <Button
                variant="outline"
                className="justify-self-start"
                pending={busy === "costs"}
                onClick={() => {
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(prices || "{}");
                  } catch {
                    toast("error", "Os preços precisam estar em JSON válido.");
                    return;
                  }
                  void save(
                    "costs",
                    "/api/v1/admin/ai/settings",
                    { credit_costs: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, Number(v)])), daily_budget_usd: Number(budget), prices: parsed },
                    "Configuração salva.",
                  );
                }}
              >
                Salvar
              </Button>
            </div>
          </Panel>
        </div>
  );
}

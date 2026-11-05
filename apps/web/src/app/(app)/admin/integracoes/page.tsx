"use client";

import { PlatformIcon } from "@/components/app/platform";
import { Badge, ErrorState, PageHeader, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";
import { ago, when } from "@/lib/format";
import type { Diagnostic, Platform } from "@/lib/types";
import { useApi } from "@/lib/use-api";

type Health = {
  networks: {
    platform: Platform;
    label: string;
    configured: boolean;
    connections: Record<string, number>;
    events_24h: number;
    errors_24h: number;
    webhooks_24h: number;
    last_error: { message: string; at: string } | null;
    last_diagnostic: { id: string; status: string; at: string; user_id: string } | null;
  }[];
  payments: { gateway: string; errors_24h: number; webhooks_24h: number; last_error: { message: string; at: string } | null; last_diagnostic: { status: string; at: string } | null };
  ai: Record<string, { ready: boolean; errors_24h: number }>;
};

const DIAG_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = { passed: "success", warning: "warning", failed: "danger", running: "info", queued: "neutral" };

export default function IntegrationsPage() {
  const health = useApi<Health>("/api/v1/admin/integrations", { refreshMs: 30_000 });
  const history = useApi<{ items: (Diagnostic & { user_id: string })[] }>("/api/v1/admin/diagnostics?limit=50");
  const h = health.data;
  return (
    <>
      <PageHeader title="Integrações" description="Saúde das redes, do pagamento e da IA nas últimas 24 h, e todos os testes já rodados." />
      {health.error ? (
        <ErrorState message={health.error.message} onRetry={health.reload} />
      ) : !h ? (
        <Skeleton className="h-56 rounded-xl" />
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 lg:grid-cols-3">
            {h.networks.map((n) => (
              <Panel key={n.platform} as="article">
                <div className="flex items-center gap-3 border-b border-line px-5 py-4">
                  <PlatformIcon platform={n.platform} className="h-5 w-5" />
                  <h2 className="flex-1 text-[15px] font-semibold">{n.label}</h2>
                  {!n.configured ? <Badge>Sem credenciais</Badge> : n.errors_24h ? <Badge tone="danger">{n.errors_24h} erros</Badge> : <Badge tone="success">Saudável</Badge>}
                </div>
                <dl className="grid grid-cols-3 gap-3 px-5 py-4 text-sm">
                  <div><dt className="text-xs text-muted">Conectadas</dt><dd className="font-mono text-lg text-ink">{n.connections.active ?? 0}</dd></div>
                  <div><dt className="text-xs text-muted">Reconectar</dt><dd className="font-mono text-lg text-ink">{n.connections.needs_reconnect ?? 0}</dd></div>
                  <div><dt className="text-xs text-muted">Webhooks</dt><dd className="font-mono text-lg text-ink">{n.webhooks_24h}</dd></div>
                </dl>
                <div className="grid gap-2 border-t border-line px-5 py-3 text-xs">
                  <p className="text-muted">
                    Último teste:{" "}
                    {n.last_diagnostic ? (
                      <>
                        <Badge tone={DIAG_TONE[n.last_diagnostic.status]}>{n.last_diagnostic.status}</Badge> {ago(n.last_diagnostic.at)}
                      </>
                    ) : (
                      "nenhum"
                    )}
                  </p>
                  {n.last_error ? <p className="truncate text-[#ffb0b0]" title={n.last_error.message}>Último erro {ago(n.last_error.at)}: {n.last_error.message}</p> : null}
                </div>
              </Panel>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="Pagamento (Asaas)" actions={<Badge tone={h.payments.gateway === "asaas" ? "success" : "warning"}>{h.payments.gateway === "asaas" ? "Conectado" : h.payments.gateway === "simulado" ? "Simulado" : "Desligado"}</Badge>} />
              <div className="grid gap-2 px-5 py-4 text-sm text-ink-2">
                <p>{h.payments.webhooks_24h} webhooks e {h.payments.errors_24h} erros em 24 h.</p>
                {h.payments.last_error ? <p className="text-xs text-[#ffb0b0]">Último erro: {h.payments.last_error.message}</p> : null}
                {h.payments.gateway !== "asaas" ? <p className="text-xs text-muted">Sem ASAAS_API_KEY no servidor. Em produção, a cobrança fica desligada até configurar.</p> : null}
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Provedores de IA" />
              <ul className="grid grid-cols-2 gap-3 px-5 py-4 text-sm">
                {Object.entries(h.ai).map(([p, v]) => (
                  <li key={p} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                    <span className="text-ink">{p}</span>
                    {v.ready ? <Badge tone={v.errors_24h ? "warning" : "success"}>{v.errors_24h ? `${v.errors_24h} erros` : "Pronto"}</Badge> : <Badge>Sem chave</Badge>}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
          <Panel>
            <PanelHeader title="Histórico de testes (todas as contas)" />
            {!history.data ? (
              <div className="p-5"><Skeleton className="h-24" /></div>
            ) : history.data.items.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">Nenhum teste ainda.</p>
            ) : (
              <ul className="divide-y divide-line">
                {history.data.items.map((d) => (
                  <li key={d.id}>
                    <details className="group">
                      <summary className="flex cursor-pointer items-center gap-3 px-5 py-2.5 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand-soft">
                        <span className="w-24 text-ink">{d.target}</span>
                        <Badge tone={DIAG_TONE[d.status]}>{d.status}</Badge>
                        <span className="flex-1 truncate text-xs text-muted">{d.steps.find((s) => s.status === "failed")?.message ?? ""}</span>
                        <span className="font-mono text-xs text-muted">{when(d.created_at)}</span>
                      </summary>
                      <ol className="grid gap-1 bg-surface-2/40 px-5 py-3 text-xs">
                        {d.steps.map((s, i) => (
                          <li key={i} className="grid grid-cols-[1.5rem_12rem_1fr_auto] gap-2">
                            <span>{s.status === "ok" ? "✓" : s.status === "failed" ? "✕" : "!"}</span>
                            <span className="text-ink-2">{s.name}</span>
                            <span className="truncate text-muted">{s.message}</span>
                            <span className="font-mono text-faint">{s.ms} ms</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

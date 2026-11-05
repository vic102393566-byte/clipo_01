"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge, ErrorState, PageHeader, Panel, PanelHeader, Skeleton, Stat } from "@/components/ui/primitives";
import { brl, num } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Metrics = {
  days: number;
  users: { total: number; new: number; active_1d: number; active_7d: number; active_period: number; by_plan: Record<string, number> };
  subscriptions: { by_status: Record<string, number>; mrr_cents: number };
  revenue: { gross: number; net: number; refunded: number; count: number };
  videos: { uploaded: number; jobs: Record<string, number>; jobs_failed_by_type: Record<string, number>; clips: number };
  publications: { targets: Record<string, number>; failure_rate: number | null };
  ai: { by_task: Record<string, { calls: number; cost_usd: number }>; cost_usd: number };
};

type Health = {
  networks: { platform: string; label: string; configured: boolean; connections: Record<string, number>; errors_24h: number; webhooks_24h: number; last_error: { message: string; at: string } | null }[];
  payments: { gateway: string; errors_24h: number; webhooks_24h: number };
  ai: Record<string, { ready: boolean; errors_24h: number }>;
};

const SUB_LABEL: Record<string, string> = { trialing: "Teste", active: "Ativas", past_due: "Atrasadas", manual: "Cortesia", expired: "Gratuito" };

export default function AdminOverview() {
  const [days, setDays] = useState(30);
  const metrics = useApi<Metrics>(`/api/v1/admin/metrics?days=${days}`);
  const health = useApi<Health>("/api/v1/admin/integrations", { refreshMs: 60_000 });
  const m = metrics.data;

  return (
    <>
      <PageHeader
        title="Visão geral"
        description="Uso, receita e saúde da plataforma."
        actions={
          <div role="radiogroup" aria-label="Período" className="flex rounded-lg border border-line bg-surface p-0.5">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={days === d}
                onClick={() => setDays(d)}
                className={`h-8 cursor-pointer rounded-md px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-brand-soft ${days === d ? "bg-surface-3 text-ink" : "text-muted hover:text-ink"}`}
              >
                {d} dias
              </button>
            ))}
          </div>
        }
      />
      {metrics.error ? (
        <ErrorState message={metrics.error.message} onRetry={metrics.reload} />
      ) : (
        <div className="grid gap-6">
          <Panel as="div" className="px-5 py-4">
            {m ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-6 xl:divide-x xl:divide-line xl:[&>div:not(:first-child)]:pl-6">
                <div><Stat label="Pessoas" value={num(m.users.total)} hint={`+${m.users.new} no período`} /></div>
                <div><Stat label="Ativas hoje" value={num(m.users.active_1d)} hint={`${m.users.active_7d} na semana`} /></div>
                <div><Stat label="Receita recorrente" value={brl(m.subscriptions.mrr_cents)} hint="MRR" /></div>
                <div><Stat label="Recebido" value={brl(m.revenue.gross)} hint={`${m.revenue.count} pagamentos`} /></div>
                <div>
                  <Stat
                    label="Falha de publicação"
                    value={m.publications.failure_rate === null ? "-" : `${(m.publications.failure_rate * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}
                    hint={`${m.publications.targets.published ?? 0} publicadas`}
                  />
                </div>
                <div><Stat label="Custo de IA" value={`US$ ${m.ai.cost_usd.toFixed(2)}`} hint="no período" /></div>
              </dl>
            ) : (
              <Skeleton className="h-14" />
            )}
          </Panel>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel>
              <PanelHeader title="Assinaturas e planos" />
              {m ? (
                <div className="grid gap-5 px-5 py-4 sm:grid-cols-2">
                  <Breakdown title="Por situação" data={Object.fromEntries(Object.entries(m.subscriptions.by_status).map(([k, v]) => [SUB_LABEL[k] ?? k, v]))} />
                  <Breakdown title="Pessoas por plano" data={m.users.by_plan} />
                </div>
              ) : (
                <div className="p-5"><Skeleton className="h-32" /></div>
              )}
            </Panel>
            <Panel>
              <PanelHeader title="Processamento" description={m ? `${m.videos.uploaded} vídeos enviados, ${m.videos.clips} cortes prontos` : undefined} actions={<Link href="/admin/jobs" className="text-[13px] font-medium text-brand-soft hover:underline">Fila</Link>} />
              {m ? (
                <div className="grid gap-5 px-5 py-4 sm:grid-cols-2">
                  <Breakdown title="Jobs por situação" data={m.videos.jobs} />
                  <Breakdown title="Falhas por tipo" data={m.videos.jobs_failed_by_type} tone="danger" />
                </div>
              ) : (
                <div className="p-5"><Skeleton className="h-32" /></div>
              )}
            </Panel>
          </div>

          <Panel>
            <PanelHeader title="Integrações nas últimas 24 h" actions={<Link href="/admin/integracoes" className="text-[13px] font-medium text-brand-soft hover:underline">Detalhes</Link>} />
            {!health.data ? (
              <div className="p-5"><Skeleton className="h-24" /></div>
            ) : (
              <ul className="grid divide-y divide-line md:grid-cols-4 md:divide-x md:divide-y-0">
                {health.data.networks.map((n) => (
                  <li key={n.platform} className="px-5 py-4">
                    <p className="flex items-center justify-between text-sm font-medium text-ink">
                      {n.label}
                      {!n.configured ? <Badge>Sem app</Badge> : n.errors_24h ? <Badge tone="danger">{n.errors_24h} erros</Badge> : <Badge tone="success">OK</Badge>}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {n.connections.active ?? 0} conectadas · {n.connections.needs_reconnect ?? 0} para reconectar
                    </p>
                    {n.last_error ? <p className="mt-1 truncate text-xs text-[#ffb0b0]" title={n.last_error.message}>{n.last_error.message}</p> : null}
                  </li>
                ))}
                <li className="px-5 py-4">
                  <p className="flex items-center justify-between text-sm font-medium text-ink">
                    Pagamento
                    <Badge tone={health.data.payments.gateway === "asaas" ? "success" : "warning"}>{health.data.payments.gateway}</Badge>
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {health.data.payments.webhooks_24h} webhooks · {health.data.payments.errors_24h} erros
                  </p>
                </li>
              </ul>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

function Breakdown({ title, data, tone = "brand" }: { title: string; data: Record<string, number>; tone?: "brand" | "danger" }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div>
      <p className="mb-3 text-xs font-medium text-muted">{title}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-faint">Nada no período.</p>
      ) : (
        <ul className="grid gap-2">
          {entries.map(([k, v]) => (
            <li key={k} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-[13px]">
              <span className="truncate text-ink-2">{k}</span>
              <span aria-hidden className="h-1.5 rounded-full bg-surface-3">
                <span className={`block h-full rounded-full ${tone === "danger" ? "bg-danger/80" : "bg-brand"}`} style={{ width: `${(v / max) * 100}%` }} />
              </span>
              <span className="font-mono text-ink tabular-nums">{v}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

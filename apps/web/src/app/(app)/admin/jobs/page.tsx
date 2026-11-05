"use client";

import { RotateCcw, XCircle } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Badge, EmptyState, ErrorState, PageHeader, Panel, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { ago } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { JOB_LABEL, type Job } from "@/lib/use-job";

type AdminJob = Job & { user_id: string; worker_id: string | null; max_attempts: number };
const STATUS_TONE = { queued: "neutral", running: "info", done: "success", failed: "danger", cancelled: "neutral" } as const;
const STATUS_LABEL = { queued: "Na fila", running: "Rodando", done: "Feito", failed: "Falhou", cancelled: "Cancelado" };

export default function JobsPage() {
  const toast = useToast();
  const { user } = useSession();
  const canManage = user.role === "admin" || user.role === "super_admin";
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const path = useMemo(() => {
    const p = new URLSearchParams({ limit: "100" });
    if (status) p.set("status", status);
    if (type) p.set("type", type);
    return `/api/v1/admin/jobs?${p}`;
  }, [status, type]);
  const jobs = useApi<{ items: AdminJob[]; last_24h: { type: string; status: string; count: number }[]; stuck: number }>(path, { refreshMs: 5000 });
  const [busy, setBusy] = useState<string | null>(null);

  async function act(j: AdminJob, action: "retry" | "cancel") {
    setBusy(j.id);
    try {
      await api(`/api/v1/admin/jobs/${j.id}/${action}`, { method: "POST" });
      toast("success", action === "retry" ? "Job de volta na fila." : "Cancelamento pedido.");
      void jobs.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível concluir.");
    } finally {
      setBusy(null);
    }
  }

  const failed24 = (jobs.data?.last_24h ?? []).filter((r) => r.status === "failed").reduce((s, r) => s + r.count, 0);
  const total24 = (jobs.data?.last_24h ?? []).reduce((s, r) => s + r.count, 0);

  return (
    <>
      <PageHeader title="Fila de jobs" description={jobs.data ? `${total24} jobs nas últimas 24 h, ${failed24} com falha${jobs.data.stuck ? `, ${jobs.data.stuck} parados (worker caiu)` : ""}.` : undefined} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">Todas</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
        <Select label="Tipo" value={type} onChange={(e) => setType(e.target.value)} className="w-52">
          <option value="">Todos</option>
          {Object.entries(JOB_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
      </div>
      <Panel as="div">
        {jobs.error ? (
          <ErrorState message={jobs.error.message} onRetry={jobs.reload} />
        ) : jobs.loading ? (
          <div className="grid gap-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11" />)}</div>
        ) : !jobs.data?.items.length ? (
          <EmptyState title="Nenhum job com esses filtros" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Tipo</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Situação</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Andamento</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Tentativas</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Pessoa</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Criado</th>
                  <th scope="col" className="px-4 py-2.5"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {jobs.data.items.map((j) => (
                  <tr key={j.id} className="align-top">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-ink">{JOB_LABEL[j.type] ?? j.type}</p>
                      <p className="font-mono text-[11px] text-faint">{j.id.slice(0, 12)}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Badge>
                    </td>
                    <td className="max-w-[18rem] px-3 py-2.5">
                      <p className="font-mono text-xs text-ink-2">{j.progress}%</p>
                      <p className={`truncate text-xs ${j.status === "failed" ? "text-[#ffb0b0]" : "text-muted"}`} title={j.error ?? j.message}>{j.error ?? j.message}</p>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-2">{j.attempts}/{j.max_attempts}</td>
                    <td className="px-3 py-2.5">
                      <Link href={`/admin/pessoas/${j.user_id}`} className="font-mono text-xs text-brand-soft hover:underline">{j.user_id.slice(0, 8)}</Link>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-2">{ago(j.created_at)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {canManage && (j.status === "failed" || j.status === "cancelled") && j.type !== "publication.publish" ? (
                        <Button size="sm" variant="outline" pending={busy === j.id} onClick={() => act(j, "retry")} icon={<RotateCcw aria-hidden className="h-3.5 w-3.5" />}>
                          Repetir
                        </Button>
                      ) : canManage && (j.status === "queued" || j.status === "running") ? (
                        <Button size="sm" variant="ghost" pending={busy === j.id} onClick={() => act(j, "cancel")} icon={<XCircle aria-hidden className="h-3.5 w-3.5" />}>
                          Cancelar
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

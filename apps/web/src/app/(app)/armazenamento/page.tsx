"use client";

import { ArchiveRestore, Clapperboard, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, Panel, PanelHeader, Progress, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { bytes, day, percent } from "@/lib/format";
import type { Usage, Video } from "@/lib/types";
import { invalidate, useApi } from "@/lib/use-api";

export default function StoragePage() {
  const toast = useToast();
  const usage = useApi<{ usage: Usage }>("/api/v1/usage");
  const trash = useApi<{ items: Video[] }>("/api/v1/videos?trash=true&limit=100");
  const [restoring, setRestoring] = useState<string | null>(null);
  const u = usage.data?.usage;
  const p = u ? percent(u.storage_used_bytes + u.uploading_bytes, u.storage_limit_bytes) : 0;
  const trashBytes = (trash.data?.items ?? []).reduce((sum, v) => sum + v.size_bytes, 0);

  async function restore(v: Video) {
    setRestoring(v.id);
    try {
      await api(`/api/v1/videos/${v.id}/restore`, { method: "POST" });
      invalidate("/api/v1/videos");
      toast("success", `"${v.title}" voltou para a biblioteca.`);
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível restaurar.");
    } finally {
      setRestoring(null);
    }
  }

  return (
    <>
      <PageHeader title="Armazenamento" description="Originais, prévias, cortes e legendas ocupam espaço. O que está na lixeira conta até ser apagado de vez." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Panel>
          <PanelHeader title="Espaço do plano" />
          {usage.error ? (
            <ErrorState message={usage.error.message} onRetry={usage.reload} />
          ) : !u ? (
            <div className="p-5">
              <Skeleton className="h-28" />
            </div>
          ) : (
            <div className="grid gap-5 px-5 py-5">
              <div>
                <p className="font-mono text-[2rem] leading-none font-semibold text-ink tabular-nums">{p}%</p>
                <p className="mt-2 text-sm text-muted">
                  {bytes(u.storage_used_bytes)} de {bytes(u.storage_limit_bytes)}
                  {u.uploading_bytes ? `, mais ${bytes(u.uploading_bytes)} sendo enviados` : ""}
                </p>
                <Progress value={p} label="Espaço usado" tone={p >= 90 ? "danger" : p >= 75 ? "warning" : "brand"} className="mt-4 h-2" />
              </div>
              <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm">
                <div>
                  <dt className="text-xs text-muted">Na lixeira</dt>
                  <dd className="mt-0.5 font-mono text-ink tabular-nums">{bytes(trashBytes)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Vídeos este mês</dt>
                  <dd className="mt-0.5 font-mono text-ink tabular-nums">
                    {u.videos_this_month}/{u.videos_per_month}
                  </dd>
                </div>
              </dl>
              {p >= 75 ? (
                <ButtonLink href="/plano" variant="primary" className="justify-self-start">
                  Ver planos com mais espaço
                </ButtonLink>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Lixeira" description="Vídeos e cortes ficam aqui por 7 dias e depois são apagados de vez, liberando o espaço." />
          {trash.loading ? (
            <div className="grid gap-3 p-5">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : (trash.data?.items ?? []).length === 0 ? (
            <EmptyState icon={<Trash2 />} title="A lixeira está vazia" />
          ) : (
            <ul className="divide-y divide-line">
              {trash.data!.items.map((v) => (
                <li key={v.id} className="flex items-center gap-4 px-5 py-3">
                  <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-surface-3">
                    {v.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada
                      <img src={v.thumbnail_url} alt="" className="h-full w-full object-cover opacity-70" />
                    ) : (
                      <Clapperboard aria-hidden className="h-4 w-4 text-muted" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{v.title}</p>
                    <p className="text-xs text-muted">
                      {bytes(v.size_bytes)} · apagado de vez em {day(v.purge_after)}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" pending={restoring === v.id} onClick={() => restore(v)} icon={<ArchiveRestore aria-hidden className="h-3.5 w-3.5" />}>
                    Restaurar
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            Cortes soltos na lixeira voltam junto quando o vídeo de origem é restaurado. <Link href="/videos" className="text-brand-soft hover:underline">Ir para os vídeos</Link>
          </p>
        </Panel>
      </div>
    </>
  );
}

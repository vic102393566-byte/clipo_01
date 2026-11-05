"use client";

import { ArrowLeft, CalendarClock, ExternalLink, RotateCcw, Send, Trash2, Undo2, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { PLATFORM_LABEL, PlatformIcon } from "@/components/app/platform";
import { PublicationStatus, TargetStatus } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { EmptyState, ErrorState, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { when as fmtWhen } from "@/lib/format";
import type { Publication } from "@/lib/types";
import { invalidate, useApi } from "@/lib/use-api";

function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PublicationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "delete" | "uncertain">(null);
  const [uncertainMsg, setUncertainMsg] = useState("");
  const pub = useApi<{ publication: Publication }>(`/api/v1/publications/${id}`);
  const p = pub.data?.publication;
  const live = p?.status === "publishing";
  // Enquanto envia, a mesma leitura se atualiza a cada 4 s (o armazenamento é compartilhado).
  useApi<{ publication: Publication }>(live ? `/api/v1/publications/${id}` : null, { refreshMs: 4000 });

  async function run(key: string, path: string, method: "POST" | "DELETE" | "PATCH" = "POST", body?: unknown, ok?: string) {
    setBusy(key);
    try {
      const out = await api<{ publication?: Publication }>(path, { method, body });
      if (out?.publication) pub.mutate({ publication: out.publication });
      invalidate("/api/v1/publications");
      if (ok) toast("success", ok);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "confirm_uncertain") {
        setUncertainMsg(err.message);
        setConfirm("uncertain");
      } else {
        toast("error", err instanceof ApiError ? err.message : "Não foi possível concluir.");
      }
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (pub.error) {
    return pub.error.status === 404 ? (
      <EmptyState title="Publicação não encontrada" description="Ela pode ter sido apagada." action={<Link href="/agenda" className="text-brand-soft hover:underline">Voltar para a agenda</Link>} />
    ) : (
      <ErrorState message={pub.error.message} onRetry={pub.reload} />
    );
  }
  if (!p) return <Skeleton className="h-80 rounded-xl" />;

  const editable = p.status === "draft" || p.status === "scheduled";
  const failedSome = p.status === "failed" || p.status === "partial";
  const sourceHref = p.source.kind === "video" ? `/videos/${p.source.id}` : null;

  return (
    <div className="grid gap-6">
      <header>
        <Link href="/agenda" className="inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft">
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          Agenda
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[1.45rem] leading-tight font-semibold">{p.title}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">
              <PublicationStatus status={p.status} />
              {p.scheduled_at ? <span>{p.status === "published" ? "Publicada em" : "Marcada para"} {fmtWhen(p.published_at ?? p.scheduled_at)}</span> : null}
              {sourceHref ? (
                <Link href={sourceHref} className="text-brand-soft hover:underline">
                  Abrir vídeo
                </Link>
              ) : (
                <span>Corte</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {editable ? (
              <Button variant="primary" pending={busy === "now"} onClick={() => run("now", `/api/v1/publications/${id}/publish-now`, "POST", undefined, "Enviando agora.")} icon={<Send aria-hidden className="h-4 w-4" />}>
                Publicar agora
              </Button>
            ) : null}
            {failedSome ? (
              <Button variant="primary" pending={busy === "retry"} onClick={() => run("retry", `/api/v1/publications/${id}/retry`, "POST", undefined, "Nova tentativa na fila.")} icon={<RotateCcw aria-hidden className="h-4 w-4" />}>
                Tentar de novo
              </Button>
            ) : null}
            {p.status === "scheduled" ? (
              <Button variant="outline" pending={busy === "unschedule"} onClick={() => run("unschedule", `/api/v1/publications/${id}/unschedule`, "POST", undefined, "Voltou para rascunho.")} icon={<Undo2 aria-hidden className="h-4 w-4" />}>
                Desfazer agendamento
              </Button>
            ) : null}
            {editable || live ? (
              <Button variant="outline" pending={busy === "cancel"} onClick={() => run("cancel", `/api/v1/publications/${id}/cancel`, "POST", undefined, "Publicação cancelada.")} icon={<XCircle aria-hidden className="h-4 w-4" />}>
                Cancelar
              </Button>
            ) : null}
            {!live ? (
              <Button variant="danger" onClick={() => setConfirm("delete")} icon={<Trash2 aria-hidden className="h-4 w-4" />}>
                Apagar
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {live ? <Notice tone="info">Enviando para as redes. Esta página se atualiza sozinha.</Notice> : null}

      {editable ? (
        <SchedulePanel
          key={p.scheduled_at ?? "sem-data"}
          publication={p}
          pending={busy === "schedule"}
          onSave={(value) =>
            run(
              "schedule",
              `/api/v1/publications/${id}/schedule`,
              "POST",
              { scheduled_at: `${value}:00`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
              p.status === "draft" ? "Agendada." : "Reagendada.",
            )
          }
        />
      ) : null}

      <section aria-label="Redes" className="grid gap-4 lg:grid-cols-2">
        {p.targets.map((t) => (
          <Panel key={t.platform} as="article">
            <div className="flex items-center gap-3 border-b border-line px-5 py-4">
              <PlatformIcon platform={t.platform} className="h-5 w-5" />
              <h2 className="flex-1 text-[15px] font-semibold">{PLATFORM_LABEL[t.platform]}</h2>
              <TargetStatus status={t.status} />
            </div>
            <div className="grid gap-3 px-5 py-4 text-sm">
              {t.error ? <Notice tone={t.error_code === "uncertain" ? "warning" : "error"}>{t.error}</Notice> : null}
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted">Título</dt>
                <dd className="text-ink">{t.title}</dd>
                {t.description ? (
                  <>
                    <dt className="text-muted">Texto</dt>
                    <dd className="line-clamp-4 whitespace-pre-line text-ink-2">{t.description}</dd>
                  </>
                ) : null}
                <dt className="text-muted">Quem vê</dt>
                <dd className="text-ink-2">{t.privacy}</dd>
                {t.published_at ? (
                  <>
                    <dt className="text-muted">Publicado</dt>
                    <dd className="text-ink-2">{fmtWhen(t.published_at)}</dd>
                  </>
                ) : null}
              </dl>
              <div className="flex flex-wrap gap-2">
                {t.url ? (
                  <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13px] font-medium text-ink-2 hover:text-ink">
                    Ver na rede <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                  </a>
                ) : null}
                {t.remote_id && t.platform === "youtube" && t.status !== "removed" ? (
                  <Button size="sm" variant="danger" pending={busy === `rm-${t.platform}`} onClick={() => run(`rm-${t.platform}`, `/api/v1/publications/${id}/targets/${t.platform}/remote`, "DELETE", undefined, "Vídeo apagado do YouTube.")}>
                    Apagar do YouTube
                  </Button>
                ) : null}
              </div>
            </div>
          </Panel>
        ))}
      </section>

      <Dialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        size="sm"
        title="Apagar esta publicação?"
        description="Some do Clipo. O que já saiu nas redes continua lá."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Voltar
            </Button>
            <Button
              variant="danger"
              pending={busy === "delete"}
              onClick={async () => {
                if (await run("delete", `/api/v1/publications/${id}`, "DELETE", undefined, "Publicação apagada.")) router.replace("/agenda");
              }}
            >
              Apagar
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">Esta ação não pode ser desfeita.</p>
      </Dialog>
      <Dialog
        open={confirm === "uncertain"}
        onClose={() => setConfirm(null)}
        size="sm"
        title="Confira na rede antes"
        description={uncertainMsg}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Vou conferir
            </Button>
            <Button
              variant="primary"
              pending={busy === "retry"}
              onClick={async () => {
                setConfirm(null);
                await run("retry", `/api/v1/publications/${id}/retry?confirm_uncertain=true`, "POST", undefined, "Nova tentativa na fila.");
              }}
            >
              Não está lá, enviar de novo
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">O envio anterior foi interrompido sem resposta da rede. Enviar de novo pode duplicar o post se ele já tiver saído.</p>
      </Dialog>
    </div>
  );
}

function SchedulePanel({ publication, pending, onSave }: { publication: Publication; pending: boolean; onSave: (value: string) => void }) {
  const [when, setWhen] = useState(() => toLocalInput(publication.scheduled_at));
  return (
    <Panel>
      <PanelHeader title="Data e hora" description={`Fuso ${publication.timezone.replace(/_/g, " ")}`} />
      <div className="flex flex-wrap items-end gap-3 px-5 py-4">
        <Field label="Publicar em" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-60" />
        <Button variant="outline" pending={pending} disabled={!when} icon={<CalendarClock aria-hidden className="h-4 w-4" />} onClick={() => onSave(when)}>
          {publication.status === "draft" ? "Agendar" : "Reagendar"}
        </Button>
      </div>
    </Panel>
  );
}

"use client";

import { ArrowLeft, Ban, Eye, Gift, KeyRound, Sparkles, UserCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { PlatformIcon } from "@/components/app/platform";
import { Avatar, useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Badge, ErrorState, Panel, PanelHeader, Progress, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, type User } from "@/lib/api";
import { bytes, day, percent, when } from "@/lib/format";
import type { AiCredits, Connection, Subscription, Usage } from "@/lib/types";
import { ROLE_LABEL, STATUS } from "@/lib/admin";
import { useApi } from "@/lib/use-api";

type Detail = {
  user: User & { created_at: string; suspended_reason: string | null; suspended_at: string | null };
  subscription: Subscription;
  usage: Usage;
  ai_credits: AiCredits;
  connections: Connection[];
  counts: { videos: number; clips: number; publications: Record<string, number>; failed_jobs_30d: number; active_sessions: number };
  recent_audit: { _id?: string; action: string; actor_id: string | null; created_at: string; details: Record<string, unknown> }[];
};

type Action = null | "suspend" | "credits" | "grant" | "role" | "impersonate";

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const { user: me } = useSession();
  const toast = useToast();
  const detail = useApi<Detail>(`/api/v1/admin/users/${id}`);
  const plans = useApi<{ items: { id: string; name: string }[] }>("/api/v1/admin/plans");
  const [action, setAction] = useState<Action>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("50");
  const [plan, setPlan] = useState("pro");
  const [days, setDays] = useState("30");
  const [role, setRole] = useState("user");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ token: string; session: string; data: { videos: { title: string; status: string }[]; pubs: { title: string; status: string }[] } } | null>(null);

  const d = detail.data;
  const can = (perm: "manage" | "impersonate" | "plans" | "roles") =>
    ({ manage: ["admin", "super_admin"], impersonate: ["admin", "super_admin"], plans: ["admin", "super_admin"], roles: ["super_admin"] })[perm].includes(me.role);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setPending(true);
    setError(null);
    try {
      await fn();
      toast("success", ok);
      setAction(null);
      setReason("");
      void detail.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível concluir.");
    } finally {
      setPending(false);
    }
  }

  async function impersonate() {
    setPending(true);
    setError(null);
    try {
      const out = await api<{ access_token: string; session_id: string }>(`/api/v1/admin/users/${id}/impersonate`, { method: "POST", body: { reason } });
      // Lê como a pessoa, com o token só de leitura (sem cookies desta sessão de admin).
      const get = async <T,>(path: string) =>
        (await (await fetch(path, { headers: { Authorization: `Bearer ${out.access_token}` }, credentials: "omit" })).json()) as T;
      const [videos, pubs] = await Promise.all([
        get<{ items: { title: string; status: string }[] }>("/api/v1/videos?limit=10"),
        get<{ items: { title: string; status: string }[] }>("/api/v1/publications?limit=10"),
      ]);
      setView({ token: out.access_token, session: out.session_id, data: { videos: videos.items ?? [], pubs: pubs.items ?? [] } });
      setAction(null);
      setReason("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível entrar como a pessoa.");
    } finally {
      setPending(false);
    }
  }

  if (detail.error) return <ErrorState message={detail.error.message} onRetry={detail.reload} />;
  if (!d) return <Skeleton className="h-96 rounded-xl" />;
  const suspended = d.user.status === "suspended";
  const storageP = percent(d.usage.storage_used_bytes, d.usage.storage_limit_bytes);

  return (
    <div className="grid gap-6">
      <header>
        <Link href="/admin/pessoas" className="inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft">
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" /> Pessoas
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar user={d.user} size="h-14 w-14 text-base" />
            <div>
              <h1 className="text-[1.4rem] leading-tight font-semibold">{d.user.name}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                {d.user.email}
                <Badge tone={(STATUS[d.user.status] ?? ["success"])[0]}>{(STATUS[d.user.status] ?? ["", d.user.status])[1]}</Badge>
                <Badge>{ROLE_LABEL[d.user.role]}</Badge>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {can("impersonate") && d.user.role === "user" ? (
              <Button variant="outline" onClick={() => setAction("impersonate")} icon={<Eye aria-hidden className="h-4 w-4" />}>
                Ver como a pessoa
              </Button>
            ) : null}
            {can("manage") ? (
              <Button variant="outline" onClick={() => setAction("credits")} icon={<Sparkles aria-hidden className="h-4 w-4" />}>
                Créditos de IA
              </Button>
            ) : null}
            {can("plans") ? (
              <Button variant="outline" onClick={() => setAction("grant")} icon={<Gift aria-hidden className="h-4 w-4" />}>
                Plano cortesia
              </Button>
            ) : null}
            {can("roles") && d.user.id !== me.id ? (
              <Button variant="outline" onClick={() => { setRole(d.user.role); setAction("role"); }} icon={<KeyRound aria-hidden className="h-4 w-4" />}>
                Papel
              </Button>
            ) : null}
            {can("manage") && d.user.id !== me.id ? (
              suspended ? (
                <Button variant="primary" pending={pending} onClick={() => run(() => api(`/api/v1/admin/users/${id}/reactivate`, { method: "POST" }), "Conta reativada.")} icon={<UserCheck aria-hidden className="h-4 w-4" />}>
                  Reativar
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setAction("suspend")} icon={<Ban aria-hidden className="h-4 w-4" />}>
                  Suspender
                </Button>
              )
            ) : null}
          </div>
        </div>
      </header>

      {suspended ? <Notice tone="error">Suspensa em {when(d.user.suspended_at)}: {d.user.suspended_reason}</Notice> : null}

      {view ? (
        <Panel className="border-warning/40">
          <PanelHeader
            title="Vendo como a pessoa (só leitura)"
            description="Sessão de suporte de 30 minutos. Ela aparece para a pessoa e cada página vista fica no log."
            actions={
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await api(`/api/v1/admin/impersonations/${view.session}`, { method: "DELETE" }).catch(() => undefined);
                  setView(null);
                  toast("success", "Sessão de suporte encerrada.");
                }}
              >
                Encerrar
              </Button>
            }
          />
          <div className="grid gap-5 px-5 py-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Vídeos recentes</p>
              <ul className="grid gap-1 text-sm">
                {view.data.videos.length ? view.data.videos.map((v, i) => <li key={i} className="flex justify-between gap-3"><span className="truncate text-ink">{v.title}</span><span className="text-muted">{v.status}</span></li>) : <li className="text-muted">Nenhum.</li>}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Publicações</p>
              <ul className="grid gap-1 text-sm">
                {view.data.pubs.length ? view.data.pubs.map((p, i) => <li key={i} className="flex justify-between gap-3"><span className="truncate text-ink">{p.title}</span><span className="text-muted">{p.status}</span></li>) : <li className="text-muted">Nenhuma.</li>}
              </ul>
            </div>
          </div>
        </Panel>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Panel>
          <PanelHeader title="Plano e uso" />
          <dl className="grid gap-4 px-5 py-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Plano</dt>
              <dd className="font-medium text-ink">
                {d.user.plan_id} <span className="text-muted">({d.subscription.status})</span>
              </dd>
            </div>
            {d.subscription.current_period_end ? (
              <div className="flex justify-between">
                <dt className="text-muted">Período até</dt>
                <dd className="text-ink-2">{day(d.subscription.current_period_end)}</dd>
              </div>
            ) : null}
            <div>
              <div className="flex justify-between">
                <dt className="text-muted">Espaço</dt>
                <dd className="font-mono text-xs text-ink-2">{bytes(d.usage.storage_used_bytes)} / {bytes(d.usage.storage_limit_bytes)}</dd>
              </div>
              <Progress value={storageP} label="Espaço" className="mt-2" />
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Créditos de IA</dt>
              <dd className="font-mono text-ink-2">{d.ai_credits.used} / {d.ai_credits.limit}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Desde</dt>
              <dd className="text-ink-2">{day(d.user.created_at)}</dd>
            </div>
          </dl>
        </Panel>
        <Panel>
          <PanelHeader title="Atividade" />
          <dl className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
            {[
              ["Vídeos", d.counts.videos],
              ["Cortes", d.counts.clips],
              ["Publicadas", d.counts.publications.published ?? 0],
              ["Agendadas", d.counts.publications.scheduled ?? 0],
              ["Jobs com falha (30d)", d.counts.failed_jobs_30d],
              ["Aparelhos", d.counts.active_sessions],
            ].map(([k, v]) => (
              <div key={k as string}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="font-mono text-lg text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel>
          <PanelHeader title="Redes" />
          <ul className="divide-y divide-line">
            {d.connections.map((c) => (
              <li key={c.platform} className="flex items-center gap-3 px-5 py-3 text-sm">
                <PlatformIcon platform={c.platform} />
                <span className="flex-1 text-ink">{c.account?.handle ?? c.label}</span>
                <span className="text-xs text-muted">{c.status === "disconnected" ? "Desconectada" : c.status === "active" ? "Conectada" : "Reconectar"}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Auditoria desta conta" actions={<Link href={`/admin/logs?user_id=${id}`} className="text-[13px] font-medium text-brand-soft hover:underline">Ver logs</Link>} />
        {d.recent_audit.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">Nada registrado.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.recent_audit.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
                <span className="font-mono text-xs text-muted">{when(a.created_at)}</span>
                <span className="font-medium text-ink">{a.action}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{JSON.stringify(a.details)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Dialog
        open={action !== null}
        onClose={() => { setAction(null); setError(null); }}
        size="sm"
        title={{ suspend: "Suspender conta", credits: "Créditos de IA extras", grant: "Plano cortesia", role: "Mudar papel", impersonate: "Ver como a pessoa" }[action ?? "suspend"]}
        description={
          action === "suspend"
            ? "A pessoa não consegue entrar, as sessões caem e as publicações agendadas voltam para rascunho."
            : action === "impersonate"
              ? "Abre uma sessão de suporte só de leitura por 30 minutos. A pessoa vê essa sessão na lista de aparelhos."
              : action === "credits"
                ? "Valem só neste mês. Use número negativo para tirar."
                : action === "grant"
                  ? "Sem cobrança. Se a pessoa já paga uma assinatura, cancele antes."
                  : "O papel novo vale na hora; as sessões da pessoa caem."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setAction(null)}>
              Voltar
            </Button>
            <Button
              variant={action === "suspend" ? "danger" : "primary"}
              pending={pending}
              disabled={(action === "suspend" || action === "impersonate" || action === "credits") && reason.trim().length < 3}
              onClick={() => {
                if (action === "suspend") void run(() => api(`/api/v1/admin/users/${id}/suspend`, { method: "POST", body: { reason } }), "Conta suspensa.");
                if (action === "credits") void run(() => api(`/api/v1/admin/users/${id}/credits`, { method: "POST", body: { amount: Number(amount), reason } }), "Créditos ajustados.");
                if (action === "grant") void run(() => api(`/api/v1/admin/users/${id}/plan`, { method: "PUT", body: { plan_id: plan, days: days ? Number(days) : undefined } }), "Plano cortesia aplicado.");
                if (action === "role") void run(() => api(`/api/v1/admin/users/${id}/role`, { method: "PATCH", body: { role } }), "Papel alterado.");
                if (action === "impersonate") void impersonate();
              }}
            >
              Confirmar
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {error ? <Notice tone="error">{error}</Notice> : null}
          {action === "credits" ? <Field label="Quantidade" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /> : null}
          {action === "grant" ? (
            <div className="grid grid-cols-2 gap-3">
              <Select label="Plano" value={plan} onChange={(e) => setPlan(e.target.value)}>
                {(plans.data?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
              <Field label="Dias" type="number" value={days} onChange={(e) => setDays(e.target.value)} hint="Vazio: sem prazo" />
            </div>
          ) : null}
          {action === "role" ? (
            <Select label="Papel" value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          ) : null}
          {action === "suspend" || action === "impersonate" || action === "credits" ? (
            <Field label="Motivo (fica na auditoria)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={action === "impersonate" ? "Ex.: chamado #128" : "Ex.: contestação de pagamento"} />
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

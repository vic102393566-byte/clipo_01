"use client";

import { CheckCircle2, CircleAlert, CircleMinus, FlaskConical, Link2, RefreshCw, Unplug, XCircle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { PlatformIcon } from "@/components/app/platform";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { Badge, ErrorState, PageHeader, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { ago, num, when } from "@/lib/format";
import type { Connection, Diagnostic, Platform } from "@/lib/types";
import { invalidate, useApi } from "@/lib/use-api";
import { useJob } from "@/lib/use-job";

const CONNECT_ERRORS: Record<string, string> = {
  not_configured: "Esta rede ainda não está disponível no Clipo (o app dela não foi configurado).",
  plan_limit: "Seu plano não permite conectar mais redes. Mude de plano ou desconecte outra.",
  access_denied: "A conexão foi cancelada na rede.",
};

const DIAG_TONE = { passed: "success", warning: "warning", failed: "danger", running: "info", queued: "neutral" } as const;
const DIAG_LABEL = { passed: "Passou", warning: "Passou com avisos", failed: "Falhou", running: "Rodando", queued: "Na fila" };
const STEP_ICON = {
  ok: <CheckCircle2 aria-hidden className="h-4 w-4 text-success" />,
  warning: <CircleAlert aria-hidden className="h-4 w-4 text-warning" />,
  failed: <XCircle aria-hidden className="h-4 w-4 text-danger" />,
  skipped: <CircleMinus aria-hidden className="h-4 w-4 text-muted" />,
};

const TEST_TEXT: Record<string, string> = {
  youtube: "Envia um vídeo curto de teste como privado, confere o processamento e apaga do canal.",
  tiktok: "Envia um vídeo de teste para a caixa de rascunhos do app (não publica) e confere o status.",
  instagram: "Cria um Reel de teste sem publicar e confere se a Meta processou. O Instagram não deixa apagar pela API.",
  payments: "Confere a chave do Asaas e manda um evento de teste para o webhook de pagamento.",
};

export default function AccountsPage() {
  return (
    <Suspense>
      <Accounts />
    </Suspense>
  );
}

function Accounts() {
  const params = useSearchParams();
  const toast = useToast();
  const conns = useApi<{ items: Connection[]; payments_last_diagnostic: Diagnostic | null }>("/api/v1/connections");
  const history = useApi<{ items: Diagnostic[] }>("/api/v1/diagnostics?limit=20");
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState<{ id: string; jobId: string; target: string } | null>(null);
  const [opened, setOpened] = useState<Diagnostic | null>(null);

  const job = useJob(running?.jobId, async () => {
    const d = await api<{ diagnostic: Diagnostic }>(`/api/v1/diagnostics/${running!.id}`);
    setOpened(d.diagnostic);
    setRunning(null);
    void conns.reload();
    void history.reload();
  });

  const error = params.get("connection_error");
  const justConnected = params.get("connected");

  async function test(target: string) {
    try {
      const out = await api<{ diagnostic: Diagnostic; job: { id: string } }>("/api/v1/diagnostics", { method: "POST", body: { target } });
      setRunning({ id: out.diagnostic.id, jobId: out.job.id, target });
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível começar o teste.");
    }
  }

  async function refresh(c: Connection) {
    setBusy(c.platform);
    try {
      await api(`/api/v1/connections/${c.platform}/refresh`, { method: "POST" });
      toast("success", `Acesso ao ${c.label} renovado.`);
      void conns.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível renovar.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Redes sociais"
        description="Conecte as contas onde o Clipo publica. O botão de testes confere de ponta a ponta se envio, publicação e exclusão funcionam."
      />
      <div className="grid gap-3">
        {error ? <Notice tone="error">{CONNECT_ERRORS[error] ?? "Não foi possível conectar. Tente de novo."}</Notice> : null}
        {justConnected ? <Notice tone="success">Conta conectada. Que tal rodar o teste para conferir?</Notice> : null}
      </div>

      {conns.error ? (
        <ErrorState message={conns.error.message} onRetry={conns.reload} />
      ) : (
        <div className="mt-2 grid gap-4 lg:grid-cols-3">
          {(conns.data?.items ?? [null, null, null]).map((c, i) =>
            !c ? (
              <Skeleton key={i} className="h-64 rounded-xl" />
            ) : (
              <Panel key={c.platform} as="article" className="flex flex-col">
                <div className="flex items-center gap-3 border-b border-line px-5 py-4">
                  <PlatformIcon platform={c.platform} className="h-6 w-6" />
                  <h2 className="flex-1 text-[15px] font-semibold">{c.label}</h2>
                  {c.status === "active" ? (
                    <Badge tone="success">Conectada</Badge>
                  ) : c.status === "needs_reconnect" ? (
                    <Badge tone="warning">Reconectar</Badge>
                  ) : !c.configured ? (
                    <Badge>Indisponível</Badge>
                  ) : (
                    <Badge>Desconectada</Badge>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-4 px-5 py-4">
                  {c.account ? (
                    <div className="flex items-center gap-3">
                      {c.account.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element -- avatar vindo da rede
                        <img src={c.account.avatar_url} alt="" className="h-10 w-10 rounded-full" />
                      ) : (
                        <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-3">
                          <PlatformIcon platform={c.platform} colored={false} className="h-4 w-4 text-muted" />
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{c.account.name}</p>
                        <p className="truncate text-xs text-muted">
                          {c.account.handle}
                          {c.account.followers ? ` · ${num(c.account.followers)} seguidores` : ""}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">{c.configured ? "Nenhuma conta conectada." : "O app desta rede ainda não foi configurado no servidor."}</p>
                  )}
                  {c.last_error && c.status === "needs_reconnect" ? <Notice tone="warning">{c.last_error}</Notice> : null}
                  {c.last_diagnostic ? (
                    <button
                      type="button"
                      onClick={() => setOpened(c.last_diagnostic)}
                      className="flex cursor-pointer items-center justify-between rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-left text-xs hover:border-line-strong focus-visible:outline-2 focus-visible:outline-brand-soft"
                    >
                      <span className="text-muted">Último teste {ago(c.last_diagnostic.created_at)}</span>
                      <Badge tone={DIAG_TONE[c.last_diagnostic.status]}>{DIAG_LABEL[c.last_diagnostic.status]}</Badge>
                    </button>
                  ) : null}
                  <p className="text-xs text-muted">{TEST_TEXT[c.platform]}</p>
                  <div className="mt-auto flex flex-wrap gap-2">
                    {c.status === "active" ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          pending={running?.target === c.platform}
                          disabled={Boolean(running)}
                          onClick={() => test(c.platform)}
                          icon={<FlaskConical aria-hidden className="h-3.5 w-3.5" />}
                        >
                          Testar
                        </Button>
                        <Button size="sm" variant="outline" pending={busy === c.platform} onClick={() => refresh(c)} icon={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}>
                          Renovar acesso
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDisconnecting(c)} icon={<Unplug aria-hidden className="h-3.5 w-3.5" />}>
                          Desconectar
                        </Button>
                      </>
                    ) : c.configured ? (
                      <a
                        href={`/api/v1/connections/${c.platform}/connect`}
                        className="btn-glow inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
                      >
                        <Link2 aria-hidden className="h-3.5 w-3.5" />
                        {c.status === "needs_reconnect" ? "Conectar de novo" : `Conectar ${c.label}`}
                      </a>
                    ) : null}
                  </div>
                </div>
              </Panel>
            ),
          )}
        </div>
      )}

      {running ? (
        <Notice tone="info" className="mt-4">
          Testando {running.target === "payments" ? "o pagamento" : running.target}: {job?.message ?? "na fila"} ({job?.progress ?? 0}%)
        </Notice>
      ) : null}

      <Panel className="mt-6">
        <PanelHeader
          title="Histórico de testes"
          description="Cada teste mostra o resultado passo a passo e fica registrado no log do sistema."
          actions={
            <Button size="sm" variant="outline" disabled={Boolean(running)} onClick={() => test("payments")} icon={<FlaskConical aria-hidden className="h-3.5 w-3.5" />}>
              Testar pagamento
            </Button>
          }
        />
        {history.loading ? (
          <div className="p-5">
            <Skeleton className="h-24" />
          </div>
        ) : (history.data?.items ?? []).length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">Nenhum teste rodado ainda.</p>
        ) : (
          <ul className="divide-y divide-line">
            {history.data!.items.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setOpened(d)}
                  className="flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                >
                  {d.target === "payments" ? (
                    <FlaskConical aria-hidden className="h-4 w-4 text-muted" />
                  ) : (
                    <PlatformIcon platform={d.target as Platform} />
                  )}
                  <span className="flex-1 text-sm text-ink">{d.target === "payments" ? "Pagamento" : d.target}</span>
                  <span className="hidden text-xs text-muted sm:block">{when(d.created_at)}</span>
                  <Badge tone={DIAG_TONE[d.status]}>{DIAG_LABEL[d.status]}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Dialog open={Boolean(opened)} onClose={() => setOpened(null)} title="Resultado do teste" description={opened ? `${opened.target} · ${when(opened.created_at)}` : undefined}>
        {opened ? (
          <ol className="grid gap-2">
            {opened.steps.map((s, i) => (
              <li key={i} className="flex gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                <span className="mt-0.5">{STEP_ICON[s.status]}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{s.name}</p>
                  {s.message ? <p className="mt-0.5 text-xs break-words text-muted">{s.message}</p> : null}
                </div>
                <span className="font-mono text-[11px] text-faint">{s.ms} ms</span>
              </li>
            ))}
          </ol>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(disconnecting)}
        onClose={() => setDisconnecting(null)}
        size="sm"
        title={`Desconectar ${disconnecting?.label}?`}
        description="As publicações agendadas para essa rede não vão sair até você conectar de novo."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisconnecting(null)}>
              Voltar
            </Button>
            <Button
              variant="danger"
              pending={busy === "disconnect"}
              onClick={async () => {
                setBusy("disconnect");
                try {
                  await api(`/api/v1/connections/${disconnecting!.platform}`, { method: "DELETE" });
                  toast("success", `${disconnecting!.label} desconectado.`);
                  invalidate("/api/v1/connections");
                  setDisconnecting(null);
                } catch (err) {
                  toast("error", err instanceof ApiError ? err.message : "Não foi possível desconectar.");
                } finally {
                  setBusy(null);
                }
              }}
            >
              Desconectar
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">O Clipo também revoga o acesso na rede, quando ela permite.</p>
      </Dialog>
    </>
  );
}

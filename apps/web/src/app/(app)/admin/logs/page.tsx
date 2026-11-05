"use client";

import { ChevronDown, Download, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Badge, EmptyState, ErrorState, PageHeader, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { when } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Log = {
  id: string;
  created_at: string;
  level: "info" | "warning" | "error";
  category: string;
  event: string;
  message: string;
  outcome: string | null;
  user_id: string | null;
  platform: string | null;
  request_id: string | null;
  duration_ms: number | null;
  details: Record<string, unknown>;
};

type Panel24 = {
  platforms: Record<string, { total: number; errors: number; warnings: number; error_rate: number }>;
  top_errors: { platform: string; event: string; count: number; last_message: string; last_at: string }[];
};

const LEVEL_TONE = { info: "neutral", warning: "warning", error: "danger" } as const;
const LEVEL_LABEL = { info: "Info", warning: "Aviso", error: "Erro" };

export default function LogsPage() {
  return (
    <Suspense>
      <Logs />
    </Suspense>
  );
}

function Logs() {
  const params = useSearchParams();
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [platform, setPlatform] = useState("");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [userId] = useState(params.get("user_id") ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState<{ query: string; items: Log[]; cursor: string | null }>({ query: "", items: [], cursor: null });

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (level) p.set("level", level);
    if (category) p.set("category", category);
    if (platform) p.set("platform", platform);
    if (debounced) p.set("q", debounced);
    if (userId) p.set("user_id", userId);
    return p.toString();
  }, [level, category, platform, debounced, userId]);

  const logs = useApi<{ items: Log[]; next_cursor: string | null; filters: { levels: string[]; categories: string[] } }>(`/api/v1/admin/logs?${query}&limit=50`);
  const panel = useApi<Panel24>("/api/v1/admin/logs/integrations?hours=24");
  const extra = more.query === query ? more : { items: [], cursor: null };
  const items = [...(logs.data?.items ?? []), ...extra.items];
  const next = more.query === query ? extra.cursor : (logs.data?.next_cursor ?? null);

  return (
    <>
      <PageHeader
        title="Logs do sistema"
        description="Tudo o que acontece no Clipo: chamadas às redes, webhooks, pagamentos, IA, jobs e ações de pessoas."
        actions={
          <a
            href={`/api/v1/admin/logs/export.csv?${query}`}
            className="inline-flex h-10 items-center gap-2 rounded-[0.625rem] border border-line-strong px-4 text-sm font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft"
          >
            <Download aria-hidden className="h-4 w-4" /> Exportar CSV
          </a>
        }
      />

      <Panel className="mb-6">
        <PanelHeader title="Erros por integração nas últimas 24 h" />
        {!panel.data ? (
          <div className="p-5"><Skeleton className="h-20" /></div>
        ) : (
          <div className="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <ul className="grid content-start gap-2">
              {Object.entries(panel.data.platforms)
                .sort((a, b) => b[1].errors - a[1].errors)
                .map(([name, v]) => (
                  <li key={name}>
                    <button
                      type="button"
                      onClick={() => setPlatform(platform === name ? "" : name)}
                      aria-pressed={platform === name}
                      className={`grid w-full cursor-pointer grid-cols-[7rem_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-brand-soft ${platform === name ? "bg-surface-3" : ""}`}
                    >
                      <span className="truncate text-ink">{name}</span>
                      <span aria-hidden className="h-1.5 rounded-full bg-surface-3">
                        <span className="block h-full rounded-full bg-danger/80" style={{ width: `${Math.min(100, v.error_rate * 100)}%` }} />
                      </span>
                      <span className="font-mono text-xs text-muted tabular-nums">
                        {v.errors}/{v.total}
                      </span>
                    </button>
                  </li>
                ))}
              {Object.keys(panel.data.platforms).length === 0 ? <li className="text-sm text-muted">Nenhum evento de integração.</li> : null}
            </ul>
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Erros que mais se repetem</p>
              {panel.data.top_errors.length === 0 ? (
                <p className="text-sm text-muted">Nenhum erro nas últimas 24 h.</p>
              ) : (
                <ul className="grid gap-1.5">
                  {panel.data.top_errors.slice(0, 6).map((e, i) => (
                    <li key={i} className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-[13px]">
                      <span className="font-mono text-xs font-semibold text-[#ffb0b0] tabular-nums">{e.count}×</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">{e.platform} · {e.event}</span>
                        <span className="block truncate text-xs text-muted">{e.last_message}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Panel>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="relative w-full sm:w-80">
          <span className="sr-only">Buscar na mensagem</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar na mensagem"
            className="h-10 w-full rounded-lg border border-line bg-surface-2/80 pr-3 pl-9 text-sm outline-none placeholder:text-faint focus:border-brand-soft/80"
          />
        </label>
        <Select label="Nível" value={level} onChange={(e) => setLevel(e.target.value)} className="w-36">
          <option value="">Todos</option>
          <option value="error">Erro</option>
          <option value="warning">Aviso</option>
          <option value="info">Info</option>
        </Select>
        <Select label="Categoria" value={category} onChange={(e) => setCategory(e.target.value)} className="w-44">
          <option value="">Todas</option>
          {(logs.data?.filters.categories ?? []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
        {platform || userId ? (
          <p className="text-xs text-muted">
            Filtrando {platform ? `plataforma ${platform}` : ""} {userId ? `pessoa ${userId.slice(0, 8)}` : ""}{" "}
            {platform ? <button type="button" className="cursor-pointer text-brand-soft hover:underline" onClick={() => setPlatform("")}>limpar</button> : null}
          </p>
        ) : null}
      </div>

      <Panel as="div">
        {logs.error ? (
          <ErrorState message={logs.error.message} onRetry={logs.reload} />
        ) : logs.loading ? (
          <div className="grid gap-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState title="Nenhum registro com esses filtros" />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  aria-expanded={open === l.id}
                  onClick={() => setOpen(open === l.id ? null : l.id)}
                  className="grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 text-left text-[13px] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none md:grid-cols-[9.5rem_4.5rem_8rem_1fr_auto]"
                >
                  <span className="hidden font-mono text-xs text-muted md:block">{when(l.created_at)}</span>
                  <Badge tone={LEVEL_TONE[l.level]}>{LEVEL_LABEL[l.level]}</Badge>
                  <span className="hidden truncate font-mono text-xs text-ink-2 md:block">{l.category}.{l.event}</span>
                  <span className="min-w-0 truncate text-ink">{l.message}</span>
                  <ChevronDown aria-hidden className={`h-4 w-4 text-muted transition-transform ${open === l.id ? "rotate-180" : ""}`} />
                </button>
                {open === l.id ? (
                  <dl className="grid gap-x-6 gap-y-1.5 border-t border-line bg-surface-2/40 px-4 py-3 text-xs sm:grid-cols-[8rem_1fr]">
                    <dt className="text-muted">Quando</dt>
                    <dd className="font-mono text-ink-2">{when(l.created_at)}</dd>
                    <dt className="text-muted">Evento</dt>
                    <dd className="font-mono text-ink-2">{l.category}.{l.event}</dd>
                    {l.platform ? (<><dt className="text-muted">Plataforma</dt><dd className="text-ink-2">{l.platform}</dd></>) : null}
                    {l.user_id ? (<><dt className="text-muted">Pessoa</dt><dd><a className="font-mono text-brand-soft hover:underline" href={`/admin/pessoas/${l.user_id}`}>{l.user_id}</a></dd></>) : null}
                    {l.request_id ? (<><dt className="text-muted">Requisição</dt><dd className="font-mono text-ink-2">{l.request_id}</dd></>) : null}
                    {l.duration_ms !== null ? (<><dt className="text-muted">Duração</dt><dd className="font-mono text-ink-2">{Math.round(l.duration_ms)} ms</dd></>) : null}
                    <dt className="text-muted">Detalhes</dt>
                    <dd>
                      <pre className="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-2">{JSON.stringify(l.details, null, 2)}</pre>
                    </dd>
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {next ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            onClick={async () => {
              const page = await api<{ items: Log[]; next_cursor: string | null }>(`/api/v1/admin/logs?${query}&limit=50&cursor=${encodeURIComponent(next)}`);
              setMore({ query, items: [...extra.items, ...page.items], cursor: page.next_cursor });
            }}
          >
            Carregar mais
          </Button>
        </div>
      ) : null}
    </>
  );
}

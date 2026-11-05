"use client";

import { CalendarClock, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { PLATFORM_LABEL, PlatformIcon } from "@/components/app/platform";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, TextArea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import type { Connection, Platform, Publication } from "@/lib/types";
import type { SettingsAll } from "@/lib/studio";
import { invalidate, useApi } from "@/lib/use-api";

export type PublishSource = { kind: "video" | "clip"; id: string; title: string; duration_s: number };

const PRIVACY: Record<Platform, { value: string; label: string }[]> = {
  youtube: [
    { value: "private", label: "Privado" },
    { value: "unlisted", label: "Não listado" },
    { value: "public", label: "Público" },
  ],
  tiktok: [
    { value: "SELF_ONLY", label: "Só eu" },
    { value: "MUTUAL_FOLLOW_FRIENDS", label: "Amigos" },
    { value: "FOLLOWER_OF_CREATOR", label: "Seguidores" },
    { value: "PUBLIC_TO_EVERYONE", label: "Todos" },
  ],
  instagram: [{ value: "public", label: "Público (o Instagram não tem post privado)" }],
};
const LIMITS: Record<Platform, { title: number; text: number }> = {
  youtube: { title: 100, text: 5000 },
  tiktok: { title: 150, text: 2200 },
  instagram: { title: 150, text: 2200 },
};

type TargetForm = { title: string; description: string; tags: string; privacy: string };
type Mode = "schedule" | "now" | "draft";

function localInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PublishDialog({
  source,
  open,
  onClose,
}: {
  source: PublishSource | null;
  open: boolean;
  onClose: () => void;
}) {
  // O formulário nasce de novo a cada abertura: nada do envio anterior fica para trás.
  return open && source ? <PublishForm key={`${source.kind}:${source.id}`} source={source} onClose={onClose} /> : null;
}

function PublishForm({ source, onClose }: { source: PublishSource; onClose: () => void }) {
  const open = true;
  const router = useRouter();
  const toast = useToast();
  const conns = useApi<{ items: Connection[] }>(open ? "/api/v1/connections" : null);
  const connected = (conns.data?.items ?? []).filter((c) => c.status === "active");
  const [picked, setPicked] = useState<Platform[] | null>(null);
  const [activeTab, setActive] = useState<Platform | null>(null);
  const [forms, setForms] = useState<Partial<Record<Platform, TargetForm>>>({});
  const [mode, setMode] = useState<Mode>("schedule");
  // Próximo quarto de hora, daqui a pelo menos 1 h.
  const [when, setWhen] = useState(() => localInput(new Date(Math.ceil((Date.now() + 3600_000) / 900_000) * 900_000)));
  const [pending, setPending] = useState(false);
  const [aiPending, setAiPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fuso escolhido em Configurações > Contas; sem ele, o do navegador.
  const prefs = useApi<SettingsAll>("/api/v1/settings");
  const browserTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const timezone = prefs.data?.me.timezone ?? browserTz;

  // Por padrão, todas as redes conectadas; depois, o que a pessoa marcar.
  const available = connected.map((c) => c.platform);
  const selected = (picked ?? available).filter((p) => available.includes(p));
  const setSelected = (fn: (prev: Platform[]) => Platform[]) => setPicked(fn(selected));
  const active = activeTab && selected.includes(activeTab) ? activeTab : (selected[0] ?? null);

  const form = (p: Platform): TargetForm =>
    forms[p] ?? { title: source?.title ?? "", description: "", tags: "", privacy: PRIVACY[p][0].value };
  const update = (p: Platform, patch: Partial<TargetForm>) => setForms((prev) => ({ ...prev, [p]: { ...form(p), ...patch } }));

  async function writeWithAi() {
    if (!source || !active) return;
    setAiPending(true);
    setError(null);
    try {
      const { metadata } = await api<{ metadata: { title: string; description: string; hashtags: string[]; call_to_action: string } }>(
        "/api/v1/ai/metadata",
        { method: "POST", body: { source_kind: source.kind, source_id: source.id, platforms: selected, tone: "viral" } },
      );
      const text = `${metadata.description}\n\n${metadata.call_to_action}`.trim();
      setForms((prev) => {
        const next = { ...prev };
        for (const p of selected) {
          next[p] = {
            ...form(p),
            title: metadata.title.slice(0, LIMITS[p].title),
            description: (p === "youtube" ? text : `${text}\n\n${metadata.hashtags.join(" ")}`).slice(0, LIMITS[p].text),
            tags: metadata.hashtags.map((h) => h.replace(/^#/, "")).join(", "),
          };
        }
        return next;
      });
      toast("success", "Texto escrito pela IA a partir da fala. Revise antes de publicar.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "A IA não respondeu agora.");
    } finally {
      setAiPending(false);
    }
  }

  async function submit() {
    if (!source || !selected.length) return;
    setPending(true);
    setError(null);
    try {
      const { publication } = await api<{ publication: Publication }>("/api/v1/publications", {
        method: "POST",
        body: {
          source_kind: source.kind,
          source_id: source.id,
          title: form(selected[0]).title || source.title,
          action: mode,
          timezone,
          scheduled_at: mode === "now" ? undefined : when ? `${when}:00` : undefined,
          targets: selected.map((p) => {
            const f = form(p);
            return {
              platform: p,
              title: f.title,
              description: f.description,
              tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
              privacy: f.privacy,
            };
          }),
        },
      });
      invalidate("/api/v1/publications");
      toast("success", mode === "now" ? "Publicação enviada para a fila." : mode === "draft" ? "Rascunho salvo." : "Publicação agendada.");
      onClose();
      router.push(`/publicacoes/${publication.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar.");
    } finally {
      setPending(false);
    }
  }

  const f = active ? form(active) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Publicar nas redes"
      description={source ? `${source.kind === "clip" ? "Corte" : "Vídeo"}: ${source.title}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={!selected.length || (mode === "schedule" && !when)}
            onClick={submit}
            icon={mode === "now" ? <Send aria-hidden className="h-4 w-4" /> : <CalendarClock aria-hidden className="h-4 w-4" />}
          >
            {mode === "now" ? "Publicar agora" : mode === "draft" ? "Salvar rascunho" : "Agendar"}
          </Button>
        </>
      }
    >
      {conns.loading ? (
        <div className="grid gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-40" />
        </div>
      ) : connected.length === 0 ? (
        <Notice tone="info">
          Nenhuma rede conectada ainda.{" "}
          <Link href="/contas" className="font-semibold text-brand-soft underline-offset-4 hover:underline">
            Conectar YouTube, Instagram ou TikTok
          </Link>
        </Notice>
      ) : (
        <div className="grid gap-5">
          {error ? <Notice tone="error">{error}</Notice> : null}
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink-2">Redes</legend>
            <div className="flex flex-wrap gap-2">
              {connected.map((c) => {
                const on = selected.includes(c.platform);
                return (
                  <label
                    key={c.platform}
                    className={`flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm transition-colors focus-within:outline-2 focus-within:outline-brand-soft ${
                      on ? "border-brand-soft/60 bg-brand/12 text-ink" : "border-line-strong text-ink-2 hover:border-line-strong hover:bg-surface-3"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={() => setSelected((prev) => (on ? prev.filter((p) => p !== c.platform) : [...prev, c.platform]))}
                    />
                    <PlatformIcon platform={c.platform} />
                    {c.label}
                    <span className="text-xs text-muted">{c.account?.handle}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {selected.length && active && f ? (
            <div className="rounded-xl border border-line">
              <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
                <div role="tablist" aria-label="Texto por rede" className="flex gap-1">
                  {selected.map((p) => (
                    <button
                      key={p}
                      role="tab"
                      type="button"
                      aria-selected={active === p}
                      onClick={() => setActive(p)}
                      className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-brand-soft ${
                        active === p ? "bg-surface-3 text-ink" : "text-muted hover:text-ink"
                      }`}
                    >
                      <PlatformIcon platform={p} className="h-3.5 w-3.5" />
                      {PLATFORM_LABEL[p]}
                    </button>
                  ))}
                </div>
                <Button size="sm" variant="outline" pending={aiPending} onClick={writeWithAi} icon={<Sparkles aria-hidden className="h-3.5 w-3.5" />}>
                  Escrever com IA
                </Button>
              </div>
              <div className="grid gap-4 p-4">
                <Field
                  label="Título"
                  value={f.title}
                  maxLength={LIMITS[active].title}
                  onChange={(e) => update(active, { title: e.target.value })}
                  hint={`${f.title.length}/${LIMITS[active].title}`}
                />
                <TextArea
                  label={active === "youtube" ? "Descrição" : "Legenda"}
                  value={f.description}
                  maxLength={LIMITS[active].text}
                  rows={5}
                  onChange={(e) => update(active, { description: e.target.value })}
                  hint={`${f.description.length}/${LIMITS[active].text}`}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Tags" value={f.tags} onChange={(e) => update(active, { tags: e.target.value })} hint="Separe por vírgula" />
                  <Select label="Quem vê" value={f.privacy} onChange={(e) => update(active, { privacy: e.target.value })}>
                    {PRIVACY[active].map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">Escolha pelo menos uma rede.</p>
          )}

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink-2">Quando</legend>
            <div className="flex flex-wrap items-end gap-3">
              <div role="radiogroup" aria-label="Quando publicar" className="flex rounded-lg border border-line bg-surface p-0.5">
                {(
                  [
                    ["schedule", "Agendar"],
                    ["now", "Agora"],
                    ["draft", "Rascunho"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={mode === value}
                    onClick={() => setMode(value)}
                    className={`h-8 cursor-pointer rounded-md px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-brand-soft ${
                      mode === value ? "bg-surface-3 text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {mode !== "now" ? (
                <Field
                  label="Data e hora"
                  hideLabel
                  type="datetime-local"
                  value={when}
                  min={localInput(new Date())}
                  onChange={(e) => setWhen(e.target.value)}
                  className="w-56"
                  hint={`Fuso: ${timezone.replace(/_/g, " ")}`}
                />
              ) : null}
            </div>
          </fieldset>
        </div>
      )}
    </Dialog>
  );
}

"use client";

import {
  ArrowLeft,
  Captions,
  Download,
  FileText,
  MoreVertical,
  Play,
  Scissors,
  Search,
  Send,
  Sparkles,
  SplitSquareHorizontal,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Timeline, type Range } from "@/components/app/editor/timeline";
import { PublishDialog, type PublishSource } from "@/components/app/publish-dialog";
import { ClipStatus, VideoStatus } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Popover, menuItemClass } from "@/components/ui/popover";
import { Badge, EmptyState, ErrorState, Progress, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { bytes, clock, clockPrecise, durationText } from "@/lib/format";
import type { AiCredits, Clip, Suggestion, Transcript, Video } from "@/lib/types";
import type { SettingsAll } from "@/lib/studio";
import { invalidate, useApi } from "@/lib/use-api";
import { JOB_LABEL, type Job } from "@/lib/use-job";

type Tab = "transcript" | "suggestions" | "clips";

export default function VideoEditorPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const player = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<Range | null>(null);
  const [clipTitle, setClipTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");
  const [dialog, setDialog] = useState<null | "highlights" | "split">(null);
  const [burnClip, setBurnClip] = useState<Clip | null>(null);
  const [publish, setPublish] = useState<PublishSource | null>(null);

  const detail = useApi<{ video: Video; clips: Clip[] }>(`/api/v1/videos/${id}`);
  const transcript = useApi<{ transcript: Transcript }>(`/api/v1/videos/${id}/transcript?words=true`);
  const suggestions = useApi<{ items: Suggestion[] }>(`/api/v1/videos/${id}/suggestions`);
  const credits = useApi<{ credits: AiCredits; costs: Record<string, number> }>("/api/v1/ai/usage");
  const jobs = useApi<{ items: Job[] }>("/api/v1/jobs?active=true&limit=30", { refreshMs: 3000 });
  const prefs = useApi<SettingsAll>("/api/v1/settings");
  const showWave = prefs.data?.me.waveform ?? true;
  const wave = useApi<{ peaks: number[] }>(showWave && detail.data?.video.status === "ready" ? `/api/v1/videos/${id}/waveform` : null);

  const video = detail.data?.video;
  const clips = useMemo(() => detail.data?.clips ?? [], [detail.data]);
  const clipIds = useMemo(() => new Set(clips.map((c) => c.id)), [clips]);
  const myJobs = (jobs.data?.items ?? []).filter(
    (j) => j.payload.video_id === id || (typeof j.payload.clip_id === "string" && clipIds.has(j.payload.clip_id)),
  );
  const hasTranscript = transcript.data?.transcript.status === "ready";
  const duration = video?.duration_s ?? 0;

  // Quando um job some da lista de ativos, recarrega o que ele pode ter mudado.
  const running = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(myJobs.map((j) => j.id));
    const finished = [...running.current].some((jid) => !now.has(jid));
    running.current = now;
    if (finished) {
      void detail.reload();
      void transcript.reload();
      void suggestions.reload();
      void credits.reload();
    }
  });

  const seek = useCallback((t: number) => {
    const el = player.current;
    if (!el) return;
    stopAt.current = null;
    el.currentTime = t;
    setCurrent(t);
  }, []);

  const playRange = useCallback((r: Range) => {
    const el = player.current;
    if (!el) return;
    el.currentTime = r.start;
    stopAt.current = r.end;
    void el.play();
  }, []);

  async function createClip() {
    if (!selection) return;
    setCreating(true);
    try {
      await api(`/api/v1/videos/${id}/clips`, {
        method: "POST",
        body: { start_s: +selection.start.toFixed(2), end_s: +selection.end.toFixed(2), title: clipTitle.trim() || undefined },
      });
      toast("success", "Corte na fila de renderização.");
      setSelection(null);
      setClipTitle("");
      setTab("clips");
      void detail.reload();
      void jobs.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível criar o corte.");
    } finally {
      setCreating(false);
    }
  }

  async function transcribe() {
    try {
      await api(`/api/v1/videos/${id}/transcribe`, { method: "POST", body: {} });
      toast("info", "Transcrição na fila. Você pode continuar usando o Clipo.");
      void jobs.reload();
      void credits.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível pedir a transcrição.");
    }
  }

  if (detail.error) {
    return detail.error.status === 404 ? (
      <EmptyState title="Vídeo não encontrado" description="Ele pode ter ido para a lixeira." action={<BackLink />} />
    ) : (
      <ErrorState message={detail.error.message} onRetry={detail.reload} />
    );
  }
  if (!video) {
    return (
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const minutes = Math.ceil(duration / 60);
  const transcribeCost = minutes * (credits.data?.costs.transcription_per_minute ?? 1);
  const ready = video.status === "ready";
  const visibleSuggestions = (suggestions.data?.items ?? []).filter((s) => s.status !== "dismissed");

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <BackLink />
          <h1 className="mt-2 truncate text-[1.45rem] leading-tight font-semibold">{video.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <VideoStatus status={video.status} />
            <span>{clock(duration)}</span>
            {video.width ? (
              <span>
                {video.width}×{video.height}
              </span>
            ) : null}
            <span>{bytes(video.size_bytes)}</span>
          </p>
        </div>
        {ready ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialog("split")} icon={<SplitSquareHorizontal aria-hidden className="h-4 w-4" />}>
              Dividir em partes
            </Button>
            <Button variant="outline" onClick={() => setDialog("highlights")} icon={<Sparkles aria-hidden className="h-4 w-4" />}>
              Cortes com IA
            </Button>
            <Button
              variant="primary"
              onClick={() => setPublish({ kind: "video", id: video.id, title: video.title, duration_s: duration })}
              icon={<Send aria-hidden className="h-4 w-4" />}
            >
              Publicar vídeo
            </Button>
          </div>
        ) : null}
      </header>

      {video.status === "failed" || video.status === "rejected" ? <Notice tone="error">{video.error ?? "O vídeo não pôde ser processado."}</Notice> : null}

      {myJobs.length ? (
        <div className="grid gap-3 rounded-xl border border-brand-soft/25 bg-brand/[0.06] px-4 py-3" aria-live="polite">
          {myJobs.map((j) => (
            <div key={j.id}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="font-medium text-ink">
                  {JOB_LABEL[j.type] ?? j.type}
                  <span className="ml-2 font-normal text-muted">{j.message}</span>
                </span>
                <span className="font-mono text-ink-2 tabular-nums">{j.progress}%</span>
              </div>
              <Progress value={j.progress} label={JOB_LABEL[j.type] ?? j.type} className="mt-2" />
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(22rem,1fr)]">
        <div className="grid min-w-0 content-start gap-4">
          <div className="overflow-hidden rounded-xl border border-line bg-black">
            {video.preview_url || video.source_url ? (
              <video
                ref={player}
                src={video.preview_url ?? video.source_url ?? undefined}
                controls
                playsInline
                preload="metadata"
                poster={video.thumbnail_url ?? undefined}
                className="aspect-video w-full"
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  setCurrent(t);
                  if (stopAt.current !== null && t >= stopAt.current) {
                    e.currentTarget.pause();
                    stopAt.current = null;
                  }
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              >
                {hasTranscript ? <track kind="captions" srcLang="pt" label="Português" src={`/api/v1/videos/${id}/subtitles.vtt`} /> : null}
              </video>
            ) : (
              <div className="flex aspect-video items-center justify-center text-sm text-muted">A prévia aparece quando o processamento terminar.</div>
            )}
          </div>

          {ready ? (
            <>
              <Timeline
                duration={duration}
                current={current}
                selection={selection}
                clips={clips.filter((c) => !c.deleted_at).map((c) => ({ id: c.id, start: c.start_s, end: c.end_s, title: c.title }))}
                suggestions={visibleSuggestions.filter((s) => s.status === "new").map((s) => ({ id: s.id, start: s.start_s, end: s.end_s, score: s.score, title: s.title }))}
                onSeek={seek}
                onSelect={setSelection}
                peaks={showWave ? (wave.data?.peaks ?? []) : []}
                snap={prefs.data?.me.timeline_snap ?? true}
              />
              <SelectionBar
                selection={selection}
                duration={duration}
                current={current}
                title={clipTitle}
                creating={creating}
                onTitle={setClipTitle}
                onChange={setSelection}
                onPlay={() => selection && playRange(selection)}
                onCreate={createClip}
              />
            </>
          ) : null}
        </div>

        <section aria-label="Painel do editor" className="flex min-h-[28rem] min-w-0 flex-col rounded-[0.875rem] border border-line bg-surface/80 xl:max-h-[calc(100dvh-10rem)] xl:sticky xl:top-20">
          <div role="tablist" aria-label="Painel do editor" className="flex gap-1 border-b border-line p-1.5">
            {(
              [
                ["transcript", "Transcrição", null],
                ["suggestions", "Sugestões da IA", visibleSuggestions.filter((s) => s.status === "new").length || null],
                ["clips", "Cortes", clips.length || null],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={tab === value}
                aria-controls={`painel-${value}`}
                onClick={() => setTab(value)}
                className={`flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand-soft ${
                  tab === value ? "bg-surface-3 text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {label}
                {count ? <span className="rounded bg-brand/25 px-1.5 font-mono text-[11px] text-[#a9cbff]">{count}</span> : null}
              </button>
            ))}
          </div>
          <div id={`painel-${tab}`} role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
            {tab === "transcript" ? (
              <TranscriptPanel
                loading={transcript.loading}
                transcript={hasTranscript ? transcript.data!.transcript : null}
                busy={myJobs.some((j) => j.type === "video.transcribe" || j.type === "video.highlights")}
                ready={ready}
                cost={transcribeCost}
                current={current}
                playing={playing}
                onTranscribe={transcribe}
                onSeek={seek}
                onSelect={setSelection}
                selection={selection}
              />
            ) : tab === "suggestions" ? (
              <SuggestionsPanel
                items={visibleSuggestions}
                loading={suggestions.loading}
                busy={myJobs.some((j) => j.type === "video.highlights")}
                onAsk={() => setDialog("highlights")}
                onPlay={playRange}
                onChanged={() => {
                  void suggestions.reload();
                  void detail.reload();
                  void jobs.reload();
                }}
              />
            ) : (
              <ClipsPanel
                clips={clips}
                hasTranscript={hasTranscript}
                onPlay={(c) => playRange({ start: c.start_s, end: c.end_s })}
                onBurn={setBurnClip}
                onPublish={(c) => setPublish({ kind: "clip", id: c.id, title: c.title, duration_s: c.duration_s })}
                onChanged={() => {
                  void detail.reload();
                  invalidate("/api/v1/usage");
                }}
              />
            )}
          </div>
        </section>
      </div>

      <HighlightsDialog
        open={dialog === "highlights"}
        onClose={() => setDialog(null)}
        videoId={id}
        cost={(credits.data?.costs.highlights ?? 5) + (hasTranscript ? 0 : transcribeCost)}
        remaining={credits.data?.credits.remaining}
        onStarted={() => {
          setTab("suggestions");
          void jobs.reload();
          void credits.reload();
        }}
      />
      <SplitDialog
        open={dialog === "split"}
        onClose={() => setDialog(null)}
        videoId={id}
        duration={duration}
        onStarted={() => {
          setTab("clips");
          void jobs.reload();
          void detail.reload();
        }}
      />
      <BurnDialog clip={burnClip} onClose={() => setBurnClip(null)} onStarted={() => void jobs.reload()} />
      <PublishDialog open={Boolean(publish)} source={publish} onClose={() => setPublish(null)} />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/videos" className="inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft">
      <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
      Vídeos
    </Link>
  );
}

function SelectionBar({
  selection,
  duration,
  current,
  title,
  creating,
  onTitle,
  onChange,
  onPlay,
  onCreate,
}: {
  selection: Range | null;
  duration: number;
  current: number;
  title: string;
  creating: boolean;
  onTitle: (v: string) => void;
  onChange: (r: Range | null) => void;
  onPlay: () => void;
  onCreate: () => void;
}) {
  const set = (key: "start" | "end", value: number) => {
    const base = selection ?? { start: current, end: Math.min(duration, current + 30) };
    const next = { ...base, [key]: Math.max(0, Math.min(duration, value)) };
    if (next.end > next.start) onChange(next);
  };
  if (!selection) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-[13px] text-muted">
        Arraste na linha do tempo para marcar um trecho, clique numa frase da transcrição com Shift para estender, ou use I e O no ponto atual.
        <button
          type="button"
          onClick={() => onChange({ start: current, end: Math.min(duration, current + 30) })}
          className="ml-2 cursor-pointer font-medium text-brand-soft hover:underline"
        >
          Marcar 30 s a partir daqui
        </button>
      </p>
    );
  }
  const length = selection.end - selection.start;
  return (
    <div className="grid min-w-0 gap-3 rounded-xl border border-brand-soft/30 bg-brand/[0.06] p-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-[auto_auto_minmax(0,1fr)] sm:items-end">
        <TimeInput label="Início" value={selection.start} onChange={(v) => set("start", v)} onUseCurrent={() => set("start", current)} />
        <TimeInput label="Fim" value={selection.end} onChange={(v) => set("end", v)} onUseCurrent={() => set("end", current)} />
        <Field label="Título do corte" value={title} onChange={(e) => onTitle(e.target.value)} placeholder="Opcional" maxLength={200} />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto font-mono text-xs text-muted">Duração: {durationText(length)}</span>
        <Button variant="ghost" onClick={() => onChange(null)} aria-label="Limpar seleção" icon={<X aria-hidden className="h-4 w-4" />} />
        <Button variant="outline" onClick={onPlay} icon={<Play aria-hidden className="h-4 w-4" />}>
          Ouvir
        </Button>
        <Button variant="primary" pending={creating} disabled={length < 1} onClick={onCreate} icon={<Scissors aria-hidden className="h-4 w-4" />}>
          Criar corte
        </Button>
      </div>
    </div>
  );
}

function TimeInput({ label, value, onChange, onUseCurrent }: { label: string; value: number; onChange: (v: number) => void; onUseCurrent: () => void }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={0.1}
          min={0}
          aria-label={`${label} em segundos`}
          value={value.toFixed(1)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-10 w-24 rounded-field border border-line bg-surface-2/80 px-2.5 font-mono text-sm text-ink tabular-nums outline-none focus:border-brand-soft/80"
        />
        <button
          type="button"
          onClick={onUseCurrent}
          title="Usar o ponto atual"
          className="h-10 cursor-pointer rounded-field border border-line px-2 font-mono text-xs text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft"
        >
          {clockPrecise(value)}
        </button>
      </div>
    </div>
  );
}

function TranscriptPanel({
  loading,
  transcript,
  busy,
  ready,
  cost,
  current,
  playing,
  selection,
  onTranscribe,
  onSeek,
  onSelect,
}: {
  loading: boolean;
  transcript: Transcript | null;
  busy: boolean;
  ready: boolean;
  cost: number;
  current: number;
  playing: boolean;
  selection: Range | null;
  onTranscribe: () => void;
  onSeek: (t: number) => void;
  onSelect: (r: Range) => void;
}) {
  const [query, setQuery] = useState("");
  const activeRef = useRef<HTMLLIElement>(null);
  const segments = transcript?.segments ?? [];
  const activeIndex = segments.findIndex((s) => current >= s.start && current < s.end + 0.3);

  useEffect(() => {
    if (playing && activeRef.current) activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex, playing]);

  if (loading) {
    return (
      <div className="grid gap-3 p-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }
  if (!transcript) {
    return (
      <EmptyState
        icon={<FileText />}
        title={busy ? "Transcrevendo…" : "Sem transcrição ainda"}
        description={
          busy
            ? "O andamento aparece acima. A transcrição fica guardada e não é cobrada de novo."
            : `A transcrição tem o tempo de cada palavra: dá para achar trechos pela fala e gerar legendas. Usa ${cost} créditos de IA.`
        }
        action={
          busy || !ready ? null : (
            <Button variant="primary" onClick={onTranscribe} icon={<FileText aria-hidden className="h-4 w-4" />}>
              Transcrever
            </Button>
          )
        }
      />
    );
  }
  if (segments.length === 0) {
    return (
      <EmptyState
        icon={<FileText />}
        title="Nenhuma fala encontrada"
        description="A transcrição terminou, mas o vídeo não tem fala reconhecível (só música ou silêncio). Cortes e legendas pela IA precisam de fala."
      />
    );
  }
  const q = query.trim().toLowerCase();
  const shown = segments.map((s, i) => ({ s, i })).filter(({ s }) => !q || s.text.toLowerCase().includes(q));
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface/95 p-3 backdrop-blur">
        <label className="relative flex-1">
          <span className="sr-only">Buscar na transcrição</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar na fala"
            className="h-9 w-full rounded-lg border border-line bg-surface-2/80 pr-3 pl-8 text-sm outline-none placeholder:text-faint focus:border-brand-soft/80"
          />
        </label>
        <a
          href={`/api/v1/videos/${transcript.video_id}/subtitles.srt`}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-ink-2 hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft"
        >
          <Download aria-hidden className="h-3.5 w-3.5" /> .srt
        </a>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nada encontrado para “{query}”.</p>
      ) : (
        <ol className="p-2">
          {shown.map(({ s, i }) => {
            const active = i === activeIndex;
            const inSelection = selection && s.start >= selection.start - 0.2 && s.end <= selection.end + 0.2;
            return (
              <li key={i} ref={active ? activeRef : undefined}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (e.shiftKey && selection) onSelect({ start: Math.min(selection.start, s.start), end: Math.max(selection.end, s.end) });
                    else if (e.shiftKey) onSelect({ start: s.start, end: s.end });
                    else onSeek(s.start);
                  }}
                  className={`flex w-full cursor-pointer gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] leading-relaxed transition-colors focus-visible:outline-2 focus-visible:outline-brand-soft ${
                    active ? "bg-brand/15 text-ink" : inSelection ? "bg-brand/[0.07] text-ink" : "text-ink-2 hover:bg-surface-3"
                  }`}
                >
                  <span className="w-11 shrink-0 pt-0.5 font-mono text-[11px] text-muted tabular-nums">{clock(s.start)}</span>
                  <span>{s.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="border-t border-line px-4 py-3 text-xs text-muted">
        {transcript.word_count} palavras · clique para ir ao ponto · Shift+clique para marcar o trecho
      </p>
    </div>
  );
}

function SuggestionsPanel({
  items,
  loading,
  busy,
  onAsk,
  onPlay,
  onChanged,
}: {
  items: Suggestion[];
  loading: boolean;
  busy: boolean;
  onAsk: () => void;
  onPlay: (r: Range) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  if (loading) return <div className="p-4"><Skeleton className="h-32" /></div>;
  if (!items.length) {
    return (
      <EmptyState
        icon={<Sparkles />}
        title={busy ? "A IA está escolhendo os trechos…" : "Nenhuma sugestão ainda"}
        description={busy ? "O andamento aparece acima." : "A IA lê a transcrição e sugere os melhores trechos para cortes curtos, com nota e motivo."}
        action={busy ? null : <Button variant="primary" onClick={onAsk} icon={<Sparkles aria-hidden className="h-4 w-4" />}>Pedir sugestões</Button>}
      />
    );
  }
  async function act(s: Suggestion, action: "accept" | "dismiss") {
    setPending(s.id);
    try {
      await api(`/api/v1/suggestions/${s.id}/${action}`, { method: "POST", body: {} });
      toast("success", action === "accept" ? "Virou corte. Renderizando." : "Sugestão dispensada.");
      onChanged();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível concluir.");
    } finally {
      setPending(null);
    }
  }
  return (
    <ul className="grid gap-3 p-3">
      {items.map((s) => (
        <li key={s.id} className="rounded-xl border border-line bg-surface-2/60 p-4">
          <div className="flex items-start gap-3">
            <span
              className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border font-mono ${
                s.score >= 80 ? "border-success/40 text-[#9eecc4]" : s.score >= 60 ? "border-brand-soft/40 text-[#a9cbff]" : "border-line-strong text-ink-2"
              }`}
              aria-label={`Nota ${s.score} de 100`}
            >
              <span className="text-base leading-none font-semibold">{s.score}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{s.title}</p>
              <p className="mt-0.5 font-mono text-[11.5px] text-muted">
                {clock(s.start_s)} a {clock(s.end_s)} · {durationText(s.duration_s)}
              </p>
            </div>
            {s.status === "accepted" ? <Badge tone="success">Virou corte</Badge> : null}
          </div>
          {s.hook ? <p className="mt-3 border-l-2 border-brand-soft/50 pl-3 text-[13px] text-ink-2 italic">{s.hook}</p> : null}
          <p className="mt-2 text-[13px] text-muted">{s.reason}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onPlay({ start: s.start_s, end: s.end_s })} icon={<Play aria-hidden className="h-3.5 w-3.5" />}>
              Ouvir
            </Button>
            {s.status === "new" ? (
              <>
                <Button size="sm" variant="primary" pending={pending === s.id} onClick={() => act(s, "accept")} icon={<Scissors aria-hidden className="h-3.5 w-3.5" />}>
                  Criar corte
                </Button>
                <Button size="sm" variant="ghost" disabled={pending === s.id} onClick={() => act(s, "dismiss")}>
                  Dispensar
                </Button>
              </>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ClipsPanel({
  clips,
  hasTranscript,
  onPlay,
  onBurn,
  onPublish,
  onChanged,
}: {
  clips: Clip[];
  hasTranscript: boolean;
  onPlay: (c: Clip) => void;
  onBurn: (c: Clip) => void;
  onPublish: (c: Clip) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  if (!clips.length) {
    return <EmptyState icon={<Scissors />} title="Nenhum corte ainda" description="Marque um trecho na linha do tempo, aceite uma sugestão da IA ou divida o vídeo em partes." />;
  }
  async function trash(c: Clip) {
    try {
      await api(`/api/v1/clips/${c.id}`, { method: "DELETE" });
      toast("success", "Corte na lixeira.");
      onChanged();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Não foi possível mover.");
    }
  }
  return (
    <ul className="divide-y divide-line">
      {clips.map((c) => (
        <li key={c.id} className="flex items-center gap-3 px-3 py-3">
          <button
            type="button"
            onClick={() => onPlay(c)}
            aria-label={`Ouvir ${c.title}`}
            className="relative aspect-video w-24 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line bg-surface-3 focus-visible:outline-2 focus-visible:outline-brand-soft"
          >
            {c.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada
              <img src={c.thumbnail_url} alt="" className="h-full w-full object-cover" />
            ) : null}
            <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity hover:opacity-100">
              <Play aria-hidden className="h-4 w-4 text-white" />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{c.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted">
              {clock(c.start_s)} a {clock(c.end_s)}
              {c.status !== "ready" ? <ClipStatus status={c.status} /> : null}
              {c.subtitled_url ? <Badge tone="info">Legendado</Badge> : null}
            </p>
          </div>
          {c.status === "ready" ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => onPublish(c)} aria-label={`Publicar ${c.title}`} icon={<Send aria-hidden className="h-3.5 w-3.5" />} />
              <Popover
                label={`Mais ações para ${c.title}`}
                panelClassName="w-56"
                buttonClassName="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink"
                trigger={<MoreVertical aria-hidden className="h-4 w-4" />}
              >
                {(close) => (
                  <>
                    <button type="button" className={menuItemClass} disabled={!hasTranscript} onClick={() => { close(); onBurn(c); }}>
                      <Captions aria-hidden />
                      {hasTranscript ? "Gravar legendas" : "Legendas (transcreva antes)"}
                    </button>
                    {hasTranscript ? (
                      <a className={menuItemClass} href={`/api/v1/clips/${c.id}/subtitles.srt`} onClick={close}>
                        <FileText aria-hidden />
                        Baixar legenda (.srt)
                      </a>
                    ) : null}
                    {c.media_url ? (
                      <a className={menuItemClass} href={c.media_url} onClick={close}>
                        <Download aria-hidden />
                        Baixar corte
                      </a>
                    ) : null}
                    {c.subtitled_url ? (
                      <a className={menuItemClass} href={c.subtitled_url} onClick={close}>
                        <Download aria-hidden />
                        Baixar com legenda
                      </a>
                    ) : null}
                    <div className="my-1 h-px bg-line" />
                    <button type="button" className={`${menuItemClass} text-[#ffb0b0]`} onClick={() => { close(); void trash(c); }}>
                      <Trash2 aria-hidden />
                      Mover para a lixeira
                    </button>
                  </>
                )}
              </Popover>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const DURATIONS = [
  { id: "short", label: "Curtos (15 a 45 s)", min: 15, max: 45 },
  { id: "reels", label: "Reels e Shorts (20 a 75 s)", min: 20, max: 75 },
  { id: "long", label: "Mais longos (45 s a 2 min)", min: 45, max: 120 },
];

function HighlightsDialog({
  open,
  onClose,
  videoId,
  cost,
  remaining,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  videoId: string;
  cost: number;
  remaining?: number;
  onStarted: () => void;
}) {
  const toast = useToast();
  const [count, setCount] = useState("5");
  const [size, setSize] = useState("reels");
  const [language, setLanguage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const range = DURATIONS.find((d) => d.id === size)!;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Cortes com IA"
      description="A IA transcreve o vídeo (se ainda não tiver transcrição) e escolhe os melhores trechos, com nota de 0 a 100 e o motivo."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={remaining !== undefined && remaining < cost}
            icon={<Sparkles aria-hidden className="h-4 w-4" />}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api(`/api/v1/videos/${videoId}/highlights`, {
                  method: "POST",
                  body: { count: Number(count), min_s: range.min, max_s: range.max, language: language || undefined },
                });
                toast("info", "A IA começou. As sugestões aparecem na aba ao lado.");
                onStarted();
                onClose();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Não foi possível começar.");
              } finally {
                setPending(false);
              }
            }}
          >
            Sugerir cortes
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Quantos cortes" value={count} onChange={(e) => setCount(e.target.value)}>
            {[3, 5, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n} sugestões
              </option>
            ))}
          </Select>
          <Select label="Duração de cada corte" value={size} onChange={(e) => setSize(e.target.value)}>
            {DURATIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </Select>
          <Select label="Idioma da fala" value={language} onChange={(e) => setLanguage(e.target.value)} hint="Usado só se ainda for transcrever">
            <option value="">O da minha conta</option>
            <option value="pt">Português</option>
            <option value="en">Inglês</option>
            <option value="es">Espanhol</option>
            <option value="auto">Detectar</option>
          </Select>
        </div>
        <p className="text-sm text-muted">
          Usa <strong className="font-semibold text-ink">{cost} créditos</strong> de IA
          {remaining !== undefined ? ` (restam ${remaining} este mês)` : ""}. Se der errado, os créditos voltam.
        </p>
      </div>
    </Dialog>
  );
}

function SplitDialog({
  open,
  onClose,
  videoId,
  duration,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  videoId: string;
  duration: number;
  onStarted: () => void;
}) {
  const toast = useToast();
  const [seconds, setSeconds] = useState("60");
  const [pending, setPending] = useState(false);
  const parts = Math.ceil(duration / Math.max(5, Number(seconds) || 60));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Dividir em partes iguais"
      description="Corta o vídeo inteiro em partes do mesmo tamanho, na ordem. Bom para séries e aulas."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            pending={pending}
            icon={<SplitSquareHorizontal aria-hidden className="h-4 w-4" />}
            onClick={async () => {
              setPending(true);
              try {
                await api(`/api/v1/videos/${videoId}/split`, { method: "POST", body: { segment_seconds: Number(seconds) } });
                toast("info", `Gerando ${parts} partes.`);
                onStarted();
                onClose();
              } catch (err) {
                toast("error", err instanceof ApiError ? err.message : "Não foi possível dividir.");
              } finally {
                setPending(false);
              }
            }}
          >
            Gerar {parts} partes
          </Button>
        </>
      }
    >
      <Select label="Tamanho de cada parte" value={seconds} onChange={(e) => setSeconds(e.target.value)}>
        {[30, 45, 60, 90, 120, 180, 300].map((s) => (
          <option key={s} value={s}>
            {durationText(s)}
          </option>
        ))}
      </Select>
    </Dialog>
  );
}

const PRESETS = [
  { id: "destaque", label: "Destaque", sample: "PALAVRA ACENDE", className: "font-extrabold uppercase text-white [&>b]:text-[#ffd400]" },
  { id: "classico", label: "Clássico", sample: "Texto com contorno", className: "font-bold text-white [text-shadow:0_0_3px_#000,0_0_3px_#000]" },
  { id: "minimal", label: "Minimal", sample: "Caixa discreta", className: "rounded bg-black/60 px-2 py-0.5 font-medium text-white" },
] as const;

function BurnDialog({ clip, onClose, onStarted }: { clip: Clip | null; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("destaque");
  const [position, setPosition] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={Boolean(clip)}
      onClose={onClose}
      title="Gravar legendas no corte"
      description="Gera um arquivo novo com a legenda gravada na imagem. O corte original continua igual."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            pending={pending}
            icon={<Captions aria-hidden className="h-4 w-4" />}
            onClick={async () => {
              setPending(true);
              try {
                await api(`/api/v1/clips/${clip!.id}/subtitles`, { method: "POST", body: { preset, position: position || undefined } });
                toast("info", "Gravando as legendas. Você é avisado quando terminar.");
                onStarted();
                onClose();
              } catch (err) {
                toast("error", err instanceof ApiError ? err.message : "Não foi possível começar.");
              } finally {
                setPending(false);
              }
            }}
          >
            Gravar legendas
          </Button>
        </>
      }
    >
      <fieldset className="grid gap-4">
        <legend className="sr-only">Estilo</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {PRESETS.map((p) => (
            <label
              key={p.id}
              className={`cursor-pointer rounded-xl border p-3 transition-colors focus-within:outline-2 focus-within:outline-brand-soft ${
                preset === p.id ? "border-brand-soft/70 bg-brand/10" : "border-line-strong hover:bg-surface-3"
              }`}
            >
              <input type="radio" name="preset" value={p.id} checked={preset === p.id} onChange={() => setPreset(p.id)} className="sr-only" />
              <span className="flex aspect-[9/12] items-end justify-center rounded-lg bg-[linear-gradient(160deg,#16314f,#05101b)] pb-6">
                <span className={`text-center text-[13px] ${p.className}`}>
                  {p.id === "destaque" ? (
                    <>
                      <b>PALAVRA</b> ACENDE
                    </>
                  ) : (
                    p.sample
                  )}
                </span>
              </span>
              <span className="mt-2 block text-center text-sm font-medium text-ink">{p.label}</span>
            </label>
          ))}
        </div>
        <Select label="Posição" value={position} onChange={(e) => setPosition(e.target.value)}>
          <option value="">Padrão do estilo</option>
          <option value="bottom">Embaixo</option>
          <option value="middle">No meio</option>
          <option value="top">Em cima</option>
        </Select>
      </fieldset>
    </Dialog>
  );
}


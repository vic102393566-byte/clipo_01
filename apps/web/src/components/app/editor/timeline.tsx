"use client";

import { useRef } from "react";

import { clock } from "@/lib/format";

export type Range = { start: number; end: number };

/**
 * Linha do tempo do editor. Clique: vai para o ponto. Arrastar: marca um trecho para cortar.
 * Teclado (com a barra focada): ← → andam 1 s (Shift: 10 s); I marca o início e O o fim no ponto atual.
 */
export function Timeline({
  duration,
  current,
  selection,
  clips,
  suggestions,
  onSeek,
  onSelect,
  peaks = [],
  snap = false,
}: {
  duration: number;
  current: number;
  selection: Range | null;
  clips: { id: string; start: number; end: number; title: string }[];
  suggestions: { id: string; start: number; end: number; score: number; title: string }[];
  onSeek: (t: number) => void;
  onSelect: (r: Range | null) => void;
  /** Picos do áudio (0 a 1) para desenhar a forma de onda. */
  peaks?: number[];
  /** Encaixa o trecho em segundos inteiros e nas bordas dos cortes e sugestões. */
  snap?: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; moved: boolean } | null>(null);
  const pct = (t: number) => `${(Math.max(0, Math.min(duration, t)) / Math.max(duration, 1)) * 100}%`;

  const edges = [...clips, ...suggestions].flatMap((c) => [c.start, c.end]);
  const timeAt = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
    if (!snap) return t;
    const near = edges.find((x) => Math.abs(x - t) <= duration * 0.01);
    return near ?? Math.round(t);
  };

  const ticks = Math.min(10, Math.max(4, Math.floor(duration / 60)));

  return (
    <div className="select-none">
      <div
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label="Linha do tempo"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={`${clock(current)} de ${clock(duration)}`}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { from: timeAt(e.clientX), moved: false };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const t = timeAt(e.clientX);
          if (Math.abs(t - drag.current.from) > duration * 0.004) {
            drag.current.moved = true;
            onSelect({ start: Math.min(t, drag.current.from), end: Math.max(t, drag.current.from) });
          }
        }}
        onPointerUp={(e) => {
          if (drag.current && !drag.current.moved) onSeek(timeAt(e.clientX));
          drag.current = null;
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === "ArrowRight") onSeek(Math.min(duration, current + step));
          else if (e.key === "ArrowLeft") onSeek(Math.max(0, current - step));
          else if (e.key.toLowerCase() === "i") onSelect({ start: current, end: Math.max(current + 1, selection?.end ?? current + 30) });
          else if (e.key.toLowerCase() === "o") onSelect({ start: Math.min(selection?.start ?? Math.max(0, current - 30), current - 1), end: current });
          else if (e.key === "Escape") onSelect(null);
          else return;
          e.preventDefault();
        }}
        className="relative h-[4.5rem] cursor-crosshair touch-none overflow-hidden rounded-lg border border-line bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
      >
        {/* forma de onda do áudio */}
        {peaks.length > 0 && (
          <span aria-hidden className="absolute inset-x-0 top-1/2 flex h-10 -translate-y-1/2 items-center gap-px px-px opacity-60">
            {peaks.map((v, i) => (
              <span key={i} className="flex-1 rounded-full bg-[#3b82f6]" style={{ height: `${Math.max(4, v * 100)}%` }} />
            ))}
          </span>
        )}
        {/* marcas de tempo */}
        {Array.from({ length: ticks + 1 }, (_, i) => (
          <span key={i} aria-hidden className="absolute top-0 bottom-0 w-px bg-line" style={{ left: `${(i / ticks) * 100}%` }} />
        ))}
        {/* sugestões da IA (faixa de cima) */}
        {suggestions.map((s) => (
          <span
            key={s.id}
            title={`${s.title} · nota ${s.score}`}
            className="absolute top-1.5 h-5 rounded border border-cyan/60 bg-cyan/15"
            style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }}
          >
            <span className="block truncate px-1 font-mono text-[10px] leading-[18px] text-[#9fe0fb]">{s.score}</span>
          </span>
        ))}
        {/* cortes (faixa de baixo) */}
        {clips.map((c) => (
          <span
            key={c.id}
            title={c.title}
            className="absolute bottom-1.5 h-5 rounded bg-brand/45 ring-1 ring-brand-soft/50"
            style={{ left: pct(c.start), width: `calc(${pct(c.end)} - ${pct(c.start)})` }}
          />
        ))}
        {selection ? (
          <span
            aria-hidden
            className="absolute inset-y-0 border-x-2 border-brand-soft bg-brand/20"
            style={{ left: pct(selection.start), width: `calc(${pct(selection.end)} - ${pct(selection.start)})` }}
          />
        ) : null}
        <span aria-hidden className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_8px_rgb(255_255_255/0.6)]" style={{ left: pct(current) }} />
      </div>
      <div aria-hidden className="mt-1.5 flex justify-between font-mono text-[10.5px] text-faint">
        {Array.from({ length: ticks + 1 }, (_, i) => (
          // No celular, só metade das marcas (senão os tempos se encostam).
          <span key={i} className={i % 2 && i !== ticks ? "max-sm:hidden" : ""}>
            {clock((i / ticks) * duration)}
          </span>
        ))}
      </div>
    </div>
  );
}

"use client";

import { ChevronDown, Download, FileSpreadsheet, FileText, Table } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const OPTIONS = [
  { format: "pdf", label: "PDF", hint: "Relatório com a marca Clipo", icon: FileText },
  { format: "xlsx", label: "Excel (.xlsx)", hint: "Abas: resumo, por dia, por rede, top vídeos", icon: FileSpreadsheet },
  { format: "csv", label: "CSV (;)", hint: "Separado por ponto e vírgula", icon: Table },
] as const;

/** Menu "Exportar": baixa o relatório no formato escolhido com os mesmos filtros da tela. */
export function ExportMenu({ query, disabled }: { query: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Fixo na tela: o banner do topo esconde o que transborda.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = button.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-1.5 rounded-xl border border-[#1b3456] bg-[#08182d] px-3.5 text-xs font-semibold text-[#c0d0e6] transition hover:border-[#2b5182] hover:bg-[#0c233f] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Download className="h-4 w-4 text-[#3b82f6]" />
        <span>Exportar</span>
        <ChevronDown className={`h-3.5 w-3.5 text-[#6e87a8] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          role="menu"
          style={pos ? { top: pos.top, right: pos.right } : { visibility: "hidden" }}
          className="fixed z-[1000] w-64 rounded-xl border border-[#1b3456] bg-[#061224] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.6)] animate-rise-in">
          {OPTIONS.map(({ format, label, hint, icon: Icon }) => (
            <a
              key={format}
              role="menuitem"
              href={`/api/v1/analytics/export?format=${format}&${query}`}
              onClick={() => setOpen(false)}
              className="flex items-start gap-2.5 rounded-lg px-3 py-2 hover:bg-[#0c2444] focus-visible:bg-[#0c2444] focus-visible:outline-none"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#38bdf8]" />
              <span>
                <span className="block text-xs font-semibold text-white">{label}</span>
                <span className="block text-[11px] text-[#6e87a8]">{hint}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

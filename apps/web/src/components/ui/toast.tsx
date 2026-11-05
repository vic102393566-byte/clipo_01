"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Toast = { id: number; tone: "success" | "error" | "info"; message: string };

const ToastContext = createContext<(tone: Toast["tone"], message: string) => void>(() => {});

/** Avisos curtos e passageiros ("Corte criado", "Não foi possível salvar"). Erros de formulário ficam no campo. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { id, tone, message }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), tone === "error" ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:pr-6"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="glass pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl px-4 py-3 text-sm text-ink animate-rise-in"
          >
            {t.tone === "success" ? (
              <CheckCircle2 aria-hidden className="mt-px h-4 w-4 shrink-0 text-success" />
            ) : t.tone === "error" ? (
              <XCircle aria-hidden className="mt-px h-4 w-4 shrink-0 text-danger" />
            ) : (
              <Info aria-hidden className="mt-px h-4 w-4 shrink-0 text-brand-soft" />
            )}
            <span className="min-w-0 flex-1">{t.message}</span>
            <button
              type="button"
              aria-label="Fechar aviso"
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
              className="-m-1 cursor-pointer rounded p-1 text-muted hover:text-ink"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

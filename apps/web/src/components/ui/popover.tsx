"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Painel que abre ao clicar num botão (menu do usuário, avisos). Fecha com Esc, clique fora ou
 * ao escolher algo; o foco volta para o botão.
 */
export function Popover({
  trigger,
  label,
  children,
  align = "end",
  side = "bottom",
  panelClassName = "w-64",
  buttonClassName = "",
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
  panelClassName?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRestoreFocus(true);
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Ao escolher um item ou apertar Esc, o foco volta para o botão (clicar fora não rouba o foco).
  useEffect(() => {
    if (!open && restoreFocus) button.current?.focus();
  }, [open, restoreFocus]);
  const close = () => {
    setRestoreFocus(true);
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setRestoreFocus(false);
          setOpen((v) => !v);
        }}
        className={`cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft ${buttonClassName}`}
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={id}
          className={`glass absolute z-50 rounded-xl p-1.5 animate-rise-in ${side === "bottom" ? "top-full mt-2" : "bottom-full mb-2"} ${align === "end" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export const menuItemClass =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:bg-surface-3 focus-visible:text-ink focus-visible:outline-none [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-muted";

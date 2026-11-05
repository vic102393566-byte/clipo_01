"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Diálogo modal com o <dialog> nativo: foco preso dentro, Esc fecha, o foco volta para quem abriu.
 * Fecha também clicando fora.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const width = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" }[size];

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-desc` : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`glass m-auto w-[calc(100%-2rem)] ${width} max-h-[calc(100dvh-2rem)] overflow-hidden rounded-card p-0 text-ink backdrop:bg-overlay backdrop:backdrop-blur-[2px] open:animate-rise-in`}
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 pt-5 pb-4">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-lg font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={`${id}-desc`} className="mt-1 text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="-mr-2 cursor-pointer rounded-lg p-2 text-muted transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">{footer}</div> : null}
      </div>
    </dialog>
  );
}

import type { ComponentProps, ReactNode } from "react";

/*
 * Sistema de cantos (um só para o produto inteiro):
 * campos 8px · botões 10px (pílula só nos botões grandes de entrada) · painéis 14px · diálogos 22px.
 */

export function Panel({
  className = "",
  as = "section",
  ...rest
}: Omit<ComponentProps<"section">, "ref"> & { as?: "section" | "div" | "article" | "aside" }) {
  const Tag = as as "section";
  return <Tag className={`rounded-[0.875rem] border border-line bg-surface/80 ${className}`} {...rest} />;
}

export function PanelHeader({ title, description, actions, id }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 id={id} className="text-[15px] font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.6rem] leading-tight font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-[65ch] text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const badgeTones: Record<Tone, string> = {
  neutral: "border-line-strong bg-surface-3 text-ink-2",
  brand: "border-brand-soft/30 bg-brand/15 text-[#a9cbff]",
  info: "border-cyan/30 bg-cyan/10 text-[#9fe0fb]",
  success: "border-success/30 bg-success/10 text-[#9eecc4]",
  warning: "border-warning/30 bg-warning/10 text-[#f8d58f]",
  danger: "border-danger/30 bg-danger/10 text-[#ffb0b0]",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border px-2 text-[11.5px] font-semibold whitespace-nowrap ${badgeTones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded-md bg-surface-3/80 motion-reduce:animate-none ${className}`} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-14 text-center ${className}`}>
      {icon ? (
        <span aria-hidden className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-line-strong bg-surface-2 text-brand-soft [&>svg]:h-6 [&>svg]:w-6">
          {icon}
        </span>
      ) : null}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Progress({
  value,
  label,
  tone = "brand",
  className = "",
}: {
  value: number;
  label: string;
  tone?: "brand" | "warning" | "danger" | "success";
  className?: string;
}) {
  const bar = { brand: "bg-brand", warning: "bg-warning", danger: "bg-danger", success: "bg-success" }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className={`h-1.5 overflow-hidden rounded-full bg-surface-3 ${className}`}
    >
      <div className={`h-full rounded-full ${bar} transition-[width] duration-300 ease-out`} style={{ width: `${v}%` }} />
    </div>
  );
}

/** Um par termo/valor de uma lista <dl>; quem usa envolve cada Stat num <div> filho direto da lista. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <>
      <dt className="text-[12.5px] font-medium text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-[1.35rem] leading-none font-semibold tabular-nums text-ink">{value}</dd>
      {hint ? <dd className="mt-1.5 truncate text-xs text-muted">{hint}</dd> : null}
    </>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface-3 px-1 font-mono text-[11px] text-ink-2">
      {children}
    </kbd>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <p className="text-[15px] font-semibold text-ink">Não foi possível carregar</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 cursor-pointer rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium text-ink-2 hover:border-brand-soft/60 hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft"
        >
          Tentar de novo
        </button>
      ) : null}
    </div>
  );
}

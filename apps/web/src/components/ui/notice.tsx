import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";

type Tone = "error" | "success" | "info" | "warning";

const styles: Record<Tone, string> = {
  error: "border-danger/35 bg-danger/[0.08] text-[#ffc4c4]",
  success: "border-success/35 bg-success/[0.08] text-[#b6f2d3]",
  info: "border-brand-soft/30 bg-brand/[0.08] text-ink-2",
  warning: "border-warning/35 bg-warning/[0.08] text-[#fbe0ad]",
};

const icons: Record<Tone, ReactNode> = {
  error: <XCircle aria-hidden className="mt-px h-4 w-4 shrink-0" />,
  success: <CheckCircle2 aria-hidden className="mt-px h-4 w-4 shrink-0" />,
  info: <Info aria-hidden className="mt-px h-4 w-4 shrink-0" />,
  warning: <AlertTriangle aria-hidden className="mt-px h-4 w-4 shrink-0" />,
};

export function Notice({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-snug animate-fade-in ${styles[tone]} ${className}`}
    >
      {icons[tone]}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

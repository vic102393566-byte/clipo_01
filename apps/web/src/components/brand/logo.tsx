import Link from "next/link";
import { useId } from "react";

/** O "C" do Clipo: anel grosso aberto à direita, do ciano (em cima) ao azul profundo (embaixo). */
export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  const id = useId();
  // Anel com centro (50,50), raio médio 33 e espessura 30; abertura de ±40° à direita.
  const r = 33;
  const a = (40 * Math.PI) / 180;
  const x = (50 + r * Math.cos(a)).toFixed(2);
  const y1 = (50 - r * Math.sin(a)).toFixed(2);
  const y2 = (50 + r * Math.sin(a)).toFixed(2);
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}-c`} x1="85" y1="8" x2="20" y2="95" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2ad0f7" />
          <stop offset="0.38" stopColor="#0a8bff" />
          <stop offset="0.75" stopColor="#1150ff" />
          <stop offset="1" stopColor="#2a2df0" />
        </linearGradient>
        <linearGradient id={`${id}-shade`} x1="20" y1="20" x2="60" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`M ${x} ${y1} A ${r} ${r} 0 1 0 ${x} ${y2}`}
        fill="none"
        stroke={`url(#${id}-c)`}
        strokeWidth="30"
      />
      <path d={`M ${x} ${y1} A ${r} ${r} 0 0 0 17 50`} fill="none" stroke={`url(#${id}-shade)`} strokeWidth="30" />
    </svg>
  );
}

/** Logo completo (símbolo + "clipo"). `size` controla a altura. */
export function Logo({ size = "md", href }: { size?: "sm" | "md" | "lg"; href?: string }) {
  const s = {
    sm: { mark: "h-7 w-7", text: "text-[1.55rem]", gap: "gap-1.5" },
    md: { mark: "h-9 w-9", text: "text-[2rem]", gap: "gap-2" },
    lg: {
      mark: "h-10 w-10 sm:h-12 sm:w-12",
      text: "text-[2.4rem] sm:text-[3rem]",
      gap: "gap-2.5 sm:gap-3",
    },
  }[size];
  const content = (
    <>
      <LogoMark className={s.mark} />
      <span
        className={`font-display ${s.text} leading-none font-medium tracking-[-0.02em] text-transparent bg-clip-text bg-[linear-gradient(180deg,#ffffff_0%,#e3e9f2_55%,#c3ccd8_100%)]`}
      >
        clipo
      </span>
    </>
  );
  const className = `inline-flex items-center ${s.gap}`;
  if (!href) {
    return (
      <span className={className} role="img" aria-label="Clipo">
        {content}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label="Clipo, ir para o início"
      className={`${className} rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-soft`}
    >
      {content}
    </Link>
  );
}

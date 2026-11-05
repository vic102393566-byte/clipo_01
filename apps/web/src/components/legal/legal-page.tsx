import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";

export type LegalSection = { title: string; body: ReactNode };

/** Páginas públicas de texto (Privacidade, Termos): leitura confortável, sem login. */
export function LegalPage({
  eyebrow,
  title,
  updated,
  intro,
  sections,
  other,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
  other: { href: string; label: string };
}) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between gap-4 px-4 sm:px-6">
          <Logo size="sm" href="/" />
          <nav aria-label="Páginas" className="flex items-center gap-4 text-sm">
            <Link href={other.href} className="text-ink-2 hover:text-ink">
              {other.label}
            </Link>
            <Link href="/login" className="btn-glow inline-flex h-9 items-center rounded-lg px-3.5 font-semibold text-white">
              Entrar
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 pt-12 pb-20 sm:px-6">
        <p className="text-sm font-medium text-brand-soft">{eyebrow}</p>
        <h1 className="mt-2 text-[2rem] leading-tight font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        <p className="mt-2 text-sm text-muted">Última atualização: {updated}</p>
        <div className="mt-6 max-w-[68ch] text-[15px] leading-relaxed text-ink-2">{intro}</div>
        <nav aria-label="Nesta página" className="mt-8 rounded-xl border border-line bg-surface/70 p-5">
          <ol className="grid gap-1.5 text-sm sm:grid-cols-2">
            {sections.map((s, i) => (
              <li key={s.title}>
                <a href={`#s${i + 1}`} className="text-ink-2 hover:text-brand-soft">
                  {i + 1}. {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="mt-10 grid gap-10">
          {sections.map((s, i) => (
            <section key={s.title} id={`s${i + 1}`} className="scroll-mt-24">
              <h2 className="text-lg font-semibold text-ink">
                <span className="mr-2 font-mono text-brand-soft">{i + 1}.</span>
                {s.title}
              </h2>
              <div className="mt-3 grid max-w-[68ch] gap-3 text-[15px] leading-relaxed text-ink-2 [&_li]:ml-5 [&_li]:list-disc [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:grid [&_ul]:gap-1.5">
                {s.body}
              </div>
            </section>
          ))}
        </div>
        <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6 text-sm text-muted">
          <span>© 2026 Clipo. Todos os direitos reservados.</span>
          <Link href={other.href} className="text-brand-soft hover:underline">
            {other.label}
          </Link>
        </footer>
      </main>
    </div>
  );
}

import Image from "next/image";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";

/**
 * Moldura das telas de entrada (login, cadastro, senha, e-mail), igual à tela de referência:
 * foto da mesa de edição à esquerda, card de vidro à direita do centro, textos nas laterais.
 * Proporções medidas na referência (1672×941): card começa em 44% e termina em 80% da largura.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 isolate h-dvh w-full overflow-hidden overscroll-none bg-canvas">
      <Image
        src="/login/fundo.jpg"
        alt=""
        fill
        priority
        sizes="100vw"
        className="-z-20 object-cover object-[28%_50%] max-lg:opacity-60"
      />
      {/* Garante a noite escura à direita em telas mais largas que a foto. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,transparent_45%,rgb(2_7_13/0.35)_75%,rgb(2_7_13/0.6)_100%)] max-lg:bg-[linear-gradient(180deg,rgb(2_7_13/0.35),rgb(2_7_13/0.85))]"
      />

      <SideWords className="absolute top-[13.6%] right-[5.3%] hidden lg:block" words={["Planeje", "Edite", "Publique", "Evolua"]} />
      <SideWords
        className="absolute bottom-[8.2%] left-[4.25%] hidden lg:block"
        words={["Conteúdo", "com propósito", "em menos tempo"]}
      />

      <main className="flex h-full w-full items-center justify-center px-4 py-3 lg:justify-end lg:pr-[20%]">
        <section className="glass no-scrollbar max-h-[calc(100dvh-1.5rem)] w-full max-w-[33rem] overflow-x-hidden overflow-y-auto overscroll-contain rounded-card px-6 pt-7 pb-6 animate-rise-in sm:px-11 sm:pt-8 sm:pb-6">
          <div className="flex justify-center">
            <Logo size="lg" />
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}

function SideWords({ words, className }: { words: string[]; className: string }) {
  return (
    <div className={className} aria-hidden>
      <ul className="grid gap-[0.42rem] text-[0.82rem] leading-none font-medium tracking-[0.34em] text-[#aab4c2] uppercase">
        {words.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <span className="mt-[1.85rem] block h-[3px] w-[1.65rem] rounded-full bg-brand" />
    </div>
  );
}

/** Título e subtítulo do card ("Entrar no Clipo" / "Gerencie cortes..."). */
export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <header className="mt-5 mb-3.5 sm:mt-6">
      <h1 className="text-[1.45rem] leading-tight sm:text-[1.65rem] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      {subtitle ? <p className="mt-1 text-[0.95rem] text-muted">{subtitle}</p> : null}
    </header>
  );
}

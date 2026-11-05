import Link from "next/link";
import type { ReactNode } from "react";

import { buttonClass } from "@/components/ui/button";

/** Linha com "ou" no meio, como na referência. */
export function OrDivider() {
  return (
    <div className="mt-3.5 mb-3 flex items-center gap-3 text-[0.85rem] text-muted" role="separator" aria-label="ou">
      <span aria-hidden className="h-px flex-1 bg-line-strong/80" />
      <span aria-hidden>ou</span>
      <span aria-hidden className="h-px flex-1 bg-line-strong/80" />
    </div>
  );
}

export function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[1.25rem] w-[1.25rem] shrink-0" aria-hidden focusable="false">
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.55-5.17 3.55-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.38-2.29V6.6H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.4l4-3.11Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4 3.11C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

export function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[1.2rem] w-[1.2rem] shrink-0" aria-hidden focusable="false" fill="currentColor">
      <path d="M16.37 12.62c-.02-2.29 1.87-3.4 1.96-3.45-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.89 1.15 9.15.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.78.74 2.99.72 1.24-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.68ZM14.1 5.9c.63-.77 1.06-1.83.94-2.9-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.51 2.69-1.27Z" />
    </svg>
  );
}

function ProviderLink({ provider, icon, children, next }: { provider: string; icon: ReactNode; children: ReactNode; next?: string }) {
  // Navegação de página inteira: o provedor redireciona de volta para a API, que abre a sessão.
  const href = `/api/v1/auth/oauth/${provider}/start${next ? `?${new URLSearchParams({ next })}` : ""}`;
  return (
    <Link href={href} prefetch={false} className={buttonClass("secondary", "xl", "w-full min-w-0 gap-2.5 px-3.5 text-[0.92rem] font-medium")}>
      {icon}
      {children}
    </Link>
  );
}

export function OAuthButtons({ next, verb = "Entrar" }: { next?: string; verb?: string }) {
  return (
    // Lado a lado no desktop: o card mantém a altura da referência (que só tinha o Google).
    <div className="grid gap-3 sm:grid-cols-2">
      <ProviderLink provider="google" icon={<GoogleIcon />} next={next}>
        {verb} com Google
      </ProviderLink>
      <ProviderLink provider="apple" icon={<AppleIcon />} next={next}>
        {verb} com Apple
      </ProviderLink>
    </div>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  not_configured: "O login com {provider} ainda não está disponível. Entre com e-mail e senha.",
  cancelled: "O login com {provider} foi cancelado.",
  access_denied: "O login com {provider} foi cancelado.",
  account_suspended: "Esta conta está suspensa. Fale com o suporte.",
  email_not_verified: "O {provider} não confirmou este e-mail. Use outro jeito de entrar.",
};

export function oauthErrorMessage(code: string | null, provider: string | null): string | null {
  if (!code) return null;
  const name = provider === "apple" ? "Apple" : "Google";
  return (OAUTH_ERRORS[code] ?? "Não foi possível entrar com {provider}. Tente de novo.").replace("{provider}", name);
}

export function AuthLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-sm font-medium text-brand-soft underline-offset-4 transition-colors hover:text-[#7db6ff] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
    >
      {children}
    </Link>
  );
}

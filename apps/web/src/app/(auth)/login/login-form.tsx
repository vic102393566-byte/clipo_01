"use client";

import { Lock, Mail } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { AuthLink, OAuthButtons, OrDivider, oauthErrorMessage } from "@/components/auth/oauth";
import { AuthShell, Field, Notice, SubmitButton } from "@/components/auth-ui";
import { api, ApiError, safeNext } from "@/lib/api";

const DEV_ACCOUNTS =
  process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_DEV_LOGIN !== "1"
    ? []
    : [
        { label: "Normal", email: process.env.NEXT_PUBLIC_DEV_USER_EMAIL, password: process.env.NEXT_PUBLIC_DEV_USER_PASSWORD },
        { label: "Master", email: process.env.NEXT_PUBLIC_DEV_ADMIN_EMAIL, password: process.env.NEXT_PUBLIC_DEV_ADMIN_PASSWORD },
      ].filter((a): a is { label: string; email: string; password: string } => Boolean(a.email && a.password));

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [resent, setResent] = useState(false);
  const next = safeNext(params.get("next"));
  const oauthError = oauthErrorMessage(params.get("oauth_error"), params.get("provider"));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError(new ApiError(0, "missing", "Informe o e-mail e a senha."));
      return;
    }
    setPending(true);
    setError(null);
    setResent(false);
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "error", "Não foi possível entrar."));
      setPending(false);
    }
  }

  async function resend() {
    await api("/api/auth/resend-verification", { method: "POST", body: { email } }).catch(() => undefined);
    setResent(true);
  }

  return (
    <AuthShell
      title="Entrar no Clipo"
      subtitle="Gerencie cortes, legendas e agendamentos."
      footer={
        <>
          Ainda não tem conta?{" "}
          <span className="[&_a]:underline">
            <AuthLink href="/cadastro">Criar conta</AuthLink>
          </span>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid" noValidate>
        <div className="grid gap-3 empty:hidden" aria-live="polite">
          {params.get("expired") ? <Notice tone="info">Sua sessão terminou. Entre de novo.</Notice> : null}
          {oauthError && !error ? <Notice tone="error">{oauthError}</Notice> : null}
          {error ? (
            <Notice tone="error">
              {error.message}
              {error.code === "email_not_verified" ? (
                <button
                  type="button"
                  onClick={resend}
                  className="mt-1 block cursor-pointer font-medium text-brand-soft underline underline-offset-4 hover:text-[#7db6ff]"
                >
                  Reenviar link de confirmação
                </button>
              ) : null}
            </Notice>
          ) : null}
          {resent ? <Notice tone="success">Se a conta estiver pendente, enviamos um novo link.</Notice> : null}
        </div>
        <Field
          className="[div:not(:empty)+&]:mt-3.5"
          label="E-mail"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="seu@email.com"
          icon={<Mail strokeWidth={1.6} />}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          className="mt-3.5"
          label="Senha"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Sua senha"
          icon={<Lock strokeWidth={1.6} />}
          required
          revealable
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="mt-2 mb-2.5 flex items-center justify-between text-[0.88rem]">
          {/* Atalhos de contas de teste: só aparecem se o .env.local do front definir as contas
              (nunca em produção, e as senhas não ficam no código). */}
          {DEV_ACCOUNTS.length > 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>Preencher:</span>
              {DEV_ACCOUNTS.map((acc, i) => (
                <span key={acc.label} className="flex items-center gap-2">
                  {i > 0 ? <span>·</span> : null}
                  <button
                    type="button"
                    onClick={() => {
                      setEmail(acc.email);
                      setPassword(acc.password);
                    }}
                    className="cursor-pointer text-brand-soft hover:underline"
                  >
                    {acc.label}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span />
          )}
          <AuthLink href="/esqueci-senha">Esqueci minha senha</AuthLink>
        </div>
        <SubmitButton pending={pending}>{pending ? "Entrando…" : "Entrar"}</SubmitButton>
      </form>
      <OrDivider />
      <OAuthButtons next={next === "/dashboard" ? undefined : next} />
    </AuthShell>
  );
}

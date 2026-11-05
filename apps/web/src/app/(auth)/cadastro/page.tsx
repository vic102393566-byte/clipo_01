"use client";

import { Lock, Mail, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";

import { OAuthButtons, OrDivider } from "@/components/auth/oauth";
import { AuthShell, Field, Notice, SubmitButton, TextLink } from "@/components/auth-ui";
import { api, ApiError } from "@/lib/api";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const fieldError = (field: string) => error?.fields.find((f) => f.field === field)?.message;
  const passwordTooShort = password.length > 0 && password.length < 10;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 10) return;
    setPending(true);
    setError(null);
    try {
      await api("/api/auth/register", { method: "POST", body: { name, email, password } });
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "error", "Não foi possível criar a conta."));
    } finally {
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <AuthShell
        title="Confira seu e-mail"
        footer={
          <>
            Já confirmou? <TextLink href="/login">Entrar</TextLink>
          </>
        }
      >
        <Notice tone="success">
          Enviamos um link de confirmação para <strong className="font-semibold">{sentTo}</strong>. Ele vale por 24
          horas.
        </Notice>
        <p className="mt-4 text-sm text-muted">Não chegou? Veja a caixa de spam ou tente entrar para pedir um novo.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Criar conta"
      subtitle="Comece com um teste grátis, sem cartão."
      footer={
        <>
          Já tem conta? <TextLink href="/login">Entrar</TextLink>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-3.5" noValidate>
        {error && error.code !== "validation_error" ? <Notice tone="error">{error.message}</Notice> : null}
        <Field
          label="Nome"
          name="name"
          placeholder="Como quer ser chamado"
          icon={<UserRound strokeWidth={1.6} />}
          autoComplete="name"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldError("name")}
        />
        <Field
          label="E-mail"
          type="email"
          name="email"
          placeholder="seu@email.com"
          icon={<Mail strokeWidth={1.6} />}
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError("email") ? "Informe um e-mail válido." : undefined}
        />
        <Field
          label="Senha"
          type="password"
          name="password"
          placeholder="Crie uma senha"
          icon={<Lock strokeWidth={1.6} />}
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          revealable
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="Pelo menos 10 caracteres."
          error={passwordTooShort ? `Faltam ${10 - password.length} caracteres.` : fieldError("password")}
        />
        <SubmitButton pending={pending}>{pending ? "Criando conta…" : "Criar conta"}</SubmitButton>
      </form>
      <OrDivider />
      <OAuthButtons verb="Continuar" />
    </AuthShell>
  );
}

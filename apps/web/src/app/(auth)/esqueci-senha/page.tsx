"use client";

import { Mail } from "lucide-react";
import { useState, type FormEvent } from "react";

import { AuthShell, Field, Notice, SubmitButton, TextLink } from "@/components/auth-ui";
import { api, ApiError } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api("/api/auth/forgot-password", { method: "POST", body: { email } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível enviar o link.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Esqueci minha senha"
      subtitle="Enviamos um link para você escolher uma senha nova."
      footer={
        <>
          Lembrou? <TextLink href="/login">Entrar</TextLink>
        </>
      }
    >
      {done ? (
        <Notice tone="success">
          Se houver uma conta com <strong className="font-semibold">{email.trim()}</strong>, o link chega em alguns
          minutos. Ele vale por 30 minutos.
        </Notice>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field
            label="E-mail da conta"
            type="email"
            placeholder="seu@email.com"
            icon={<Mail strokeWidth={1.6} />}
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <SubmitButton pending={pending}>{pending ? "Enviando…" : "Enviar link"}</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}

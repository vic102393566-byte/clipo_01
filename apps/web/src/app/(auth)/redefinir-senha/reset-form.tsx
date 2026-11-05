"use client";

import { useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import { useState, type FormEvent } from "react";

import { AuthShell, Field, Notice, SubmitButton, TextLink } from "@/components/auth-ui";
import { api, ApiError } from "@/lib/api";

export function ResetPasswordForm() {
  const token = useSearchParams().get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 10;
  const mismatch = confirm.length > 0 && confirm !== password;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token || password.length < 10 || password !== confirm) return;
    setPending(true);
    setError(null);
    try {
      await api("/api/auth/reset-password", { method: "POST", body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível trocar a senha.");
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Nova senha">
        <div className="grid gap-4">
          <Notice tone="error">Link incompleto. Abra o link direto do e-mail.</Notice>
          <TextLink href="/esqueci-senha">Pedir um novo link</TextLink>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Senha alterada">
        <div className="grid gap-4">
          <Notice tone="success">Pronto. Por segurança, encerramos as sessões abertas em outros aparelhos.</Notice>
          <TextLink href="/login">Entrar com a nova senha</TextLink>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Escolha uma senha nova">
      <form onSubmit={onSubmit} className="grid gap-5" noValidate>
        {error ? (
          <Notice tone="error">
            {error} <TextLink href="/esqueci-senha">Pedir outro link</TextLink>
          </Notice>
        ) : null}
        <Field
          label="Nova senha"
          type="password"
          icon={<Lock strokeWidth={1.6} />}
          name="password"
          autoComplete="new-password"
          required
          revealable
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="Pelo menos 10 caracteres."
          error={tooShort ? `Faltam ${10 - password.length} caracteres.` : undefined}
        />
        <Field
          label="Repita a senha"
          type="password"
          icon={<Lock strokeWidth={1.6} />}
          name="confirm"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? "As senhas não são iguais." : undefined}
        />
        <SubmitButton pending={pending}>{pending ? "Salvando…" : "Salvar senha"}</SubmitButton>
      </form>
    </AuthShell>
  );
}

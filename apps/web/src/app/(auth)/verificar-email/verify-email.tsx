"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AuthShell, Notice, TextLink } from "@/components/auth-ui";
import { api, ApiError } from "@/lib/api";

type State = { kind: "checking" } | { kind: "done" } | { kind: "failed"; message: string };

export function VerifyEmail() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<State>(
    token ? { kind: "checking" } : { kind: "failed", message: "Link incompleto. Abra o link direto do e-mail." },
  );
  // O link só pode ser usado uma vez: evita a segunda chamada do modo estrito do React.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api("/api/auth/verify-email", { method: "POST", body: { token } })
      .then(() => setState({ kind: "done" }))
      .catch((err) =>
        setState({ kind: "failed", message: err instanceof ApiError ? err.message : "Não foi possível confirmar." }),
      );
  }, [token]);

  return (
    <AuthShell title="Confirmar e-mail">
      {state.kind === "checking" ? <Notice tone="info">Confirmando seu e-mail…</Notice> : null}
      {state.kind === "done" ? (
        <div className="grid gap-4">
          <Notice tone="success">E-mail confirmado. Sua conta está pronta.</Notice>
          <TextLink href="/login">Entrar no Clipo</TextLink>
        </div>
      ) : null}
      {state.kind === "failed" ? (
        <div className="grid gap-4">
          <Notice tone="error">{state.message}</Notice>
          <p className="text-sm text-muted">
            Para receber um novo link, <TextLink href="/login">tente entrar</TextLink> com seu e-mail e senha.
          </p>
        </div>
      ) : null}
    </AuthShell>
  );
}

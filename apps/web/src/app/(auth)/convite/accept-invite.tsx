"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AuthShell, Notice, SubmitButton, TextLink } from "@/components/auth-ui";
import { api, ApiError } from "@/lib/api";

type Preview = { email: string; role_label: string; workspace: string };
type State =
  | { kind: "loading" }
  | { kind: "ready"; invite: Preview }
  | { kind: "login"; invite: Preview }
  | { kind: "failed"; message: string };

export function AcceptInvite() {
  const token = useSearchParams().get("token");
  const router = useRouter();
  const [state, setState] = useState<State>(
    token ? { kind: "loading" } : { kind: "failed", message: "Link incompleto. Abra o link direto do e-mail." },
  );
  const [pending, setPending] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    (async () => {
      try {
        const invite = await api<Preview>("/api/v1/workspace/invites/preview", { method: "POST", body: { token } });
        // Sem sessão, a pessoa entra (ou cria a conta) com o e-mail do convite e volta para cá.
        const logged = await api("/api/me").then(
          () => true,
          () => false,
        );
        setState({ kind: logged ? "ready" : "login", invite });
      } catch (err) {
        setState({ kind: "failed", message: err instanceof ApiError ? err.message : "Convite inválido." });
      }
    })();
  }, [token]);

  const accept = async () => {
    setPending(true);
    try {
      await api("/api/v1/workspace/invites/accept", { method: "POST", body: { token } });
      router.replace("/dashboard");
    } catch (err) {
      setState({ kind: "failed", message: err instanceof ApiError ? err.message : "Não foi possível aceitar." });
      setPending(false);
    }
  };

  const next = token ? `/convite?token=${encodeURIComponent(token)}` : "/dashboard";

  return (
    <AuthShell title="Convite para o workspace">
      {state.kind === "loading" ? <Notice tone="info">Conferindo o convite…</Notice> : null}
      {state.kind === "ready" || state.kind === "login" ? (
        <div className="grid gap-4">
          <Notice tone="info">
            {state.invite.workspace} convidou <strong>{state.invite.email}</strong> como {state.invite.role_label}.
          </Notice>
          {state.kind === "ready" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void accept();
              }}
            >
              <SubmitButton pending={pending}>{pending ? "Entrando no workspace…" : "Aceitar convite"}</SubmitButton>
            </form>
          ) : (
            <>
              <TextLink href={`/login?next=${encodeURIComponent(next)}`}>Entrar com {state.invite.email}</TextLink>
              <TextLink href={`/cadastro?next=${encodeURIComponent(next)}`}>Criar conta com esse e-mail</TextLink>
            </>
          )}
        </div>
      ) : null}
      {state.kind === "failed" ? (
        <div className="grid gap-4">
          <Notice tone="error">{state.message}</Notice>
          <TextLink href="/dashboard">Ir para o Clipo</TextLink>
        </div>
      ) : null}
    </AuthShell>
  );
}

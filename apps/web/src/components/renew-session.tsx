"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Aparece quando a página abre sem token de acesso válido (ele vence a cada 15 min).
 * Tenta renovar com o token de renovação e recarrega a área logada; se não der, vai para o login.
 * A renovação é um POST com CSRF, nunca um GET, para nenhum site de fora poder disparar.
 */
export function RenewSession({ canRenew }: { canRenew: boolean }) {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const next = window.location.pathname + window.location.search;
    const toLogin = () => router.replace(`/login?${new URLSearchParams({ next, expired: "1" })}`);
    if (!canRenew) {
      toLogin();
      return;
    }
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("clipo_csrf="))?.slice("clipo_csrf=".length) ?? "";
    fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } })
      .then((res) => (res.ok || res.status === 409 ? router.refresh() : toLogin()))
      .catch(toLogin);
  }, [canRenew, router]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted" role="status">
      Abrindo sua sessão…
    </div>
  );
}

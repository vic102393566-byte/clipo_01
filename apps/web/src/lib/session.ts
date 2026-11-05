import "server-only";

import { cookies } from "next/headers";

import type { User } from "@/lib/api";

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

/** Há token de renovação, então dá para tentar recuperar a sessão no navegador. */
export async function canRenewSession(): Promise<boolean> {
  return (await cookies()).has("clipo_refresh");
}

/** Usuário da sessão, lido no servidor. `null` quando não há sessão válida. */
export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
  if (!jar.has("clipo_access")) return null;
  const res = await fetch(`${API_INTERNAL_URL}/api/me`, {
    headers: { cookie: jar.toString() },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data: { user: User } = await res.json();
  return data.user;
}

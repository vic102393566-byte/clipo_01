// Cliente da API para o navegador. Mesma origem (o Next repassa /api/*), cookies HttpOnly.

export type Role = "user" | "support" | "admin" | "super_admin";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  plan_id: string;
  email_verified: boolean;
  has_password: boolean;
  providers: string[];
  avatar_url: string | null;
  locale: "pt-BR" | "en-US";
  theme: "dark" | "light" | "system";
  status: "active" | "suspended" | "pending_deletion";
};

export const STAFF_ROLES: Role[] = ["support", "admin", "super_admin"];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

const NO_RETRY = new Set(["/api/auth/login", "/api/auth/refresh", "/api/auth/register"]);

function csrfToken(): string {
  const entry = document.cookie.split("; ").find((c) => c.startsWith("clipo_csrf="));
  return entry ? decodeURIComponent(entry.slice("clipo_csrf=".length)) : "";
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-CSRF-Token": csrfToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  let res: Response;
  try {
    res = await send(path, method, init.body);
    if (!NO_RETRY.has(path)) {
      if (res.status === 409) {
        // Outra aba acabou de renovar a sessão; os cookies novos já valem.
        res = await send(path, method, init.body);
      } else if (res.status === 401) {
        const refreshed = await send("/api/auth/refresh", "POST");
        if (refreshed.ok || refreshed.status === 409) res = await send(path, method, init.body);
      }
    }
  } catch {
    throw new ApiError(0, "network_error", "Sem conexão com o servidor. Confira sua internet e tente de novo.");
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = data?.error;
    throw new ApiError(
      res.status,
      error?.code ?? "error",
      error?.message ?? "Não foi possível concluir. Tente de novo.",
      error?.fields ?? [],
    );
  }
  return data as T;
}

/** Destino seguro depois do login: só caminhos internos, nunca outro site. */
export function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/dashboard";
  return value;
}

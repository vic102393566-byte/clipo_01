"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { STAFF_ROLES, type User } from "@/lib/api";

type Session = { user: User; setUser: (u: User) => void; isStaff: boolean };

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ user: initial, children }: { user: User; children: ReactNode }) {
  const [user, setUser] = useState(initial);
  return (
    <SessionContext.Provider value={{ user, setUser, isStaff: STAFF_ROLES.includes(user.role) }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession fora da área logada");
  return ctx;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function Avatar({ user, size = "h-8 w-8 text-xs" }: { user: Pick<User, "name" | "avatar_url">; size?: string }) {
  if (user.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element -- arquivo da própria pessoa, servido por URL assinada
    return <img src={user.avatar_url} alt="" className={`${size} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--color-cyan),var(--color-brand-strong))] font-semibold text-white`}
    >
      {initials(user.name)}
    </span>
  );
}

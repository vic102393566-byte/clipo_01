"use client";

import type { User } from "@/lib/api";
import type { Billing } from "@/lib/types";
import { useApi } from "@/lib/use-api";

// Rodapé da barra lateral de cada tela: nome, foto e plano de quem está usando.

export function CurrentUserName() {
  const { data } = useApi<{ user: User }>("/api/me");
  return <>{data?.user.name ?? ""}</>;
}

export function CurrentPlanName() {
  const { data } = useApi<Billing>("/api/v1/billing");
  return <>{data ? `Plano ${data.plan.name}` : ""}</>;
}

export function CurrentUserAvatar({ className = "object-cover" }: { className?: string }) {
  const { data } = useApi<{ user: User }>("/api/me");
  const user = data?.user;
  if (user?.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element -- foto por URL assinada
    return <img src={user.avatar_url} alt="" className={`absolute inset-0 h-full w-full ${className}`} />;
  }
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-[#0b213d] text-sm font-black text-[#38bdf8]">
      {user?.name.charAt(0).toUpperCase() ?? ""}
    </span>
  );
}

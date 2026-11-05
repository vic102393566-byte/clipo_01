"use client";

import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

import { useSession } from "@/components/app/session";
import { EmptyState } from "@/components/ui/primitives";

/** A API já recusa quem não tem permissão; aqui só evitamos mostrar uma tela vazia de erros. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const { isStaff } = useSession();
  if (!isStaff) {
    return <EmptyState icon={<ShieldAlert />} title="Área restrita" description="Esta parte do Clipo é só para a equipe." />;
  }
  return <>{children}</>;
}

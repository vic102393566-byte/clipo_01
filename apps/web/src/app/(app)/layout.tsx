import { Suspense } from "react";

import { SessionProvider } from "@/components/app/session";
import { JobPump } from "@/components/app/job-pump";
import { ThemeApplier } from "@/components/app/theme-applier";
import { RenewSession } from "@/components/renew-session";
import { UploadProvider } from "@/components/app/upload";
import { ToastProvider } from "@/components/ui/toast";
import { canRenewSession, getCurrentUser } from "@/lib/session";

async function AuthenticatedApp({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) return <RenewSession canRenew={await canRenewSession()} />;
  // Avisos dos formulários compartilhados (publicar, enviar vídeo) aparecem em qualquer tela.
  return (
    <SessionProvider user={user}>
      <ToastProvider>
        <UploadProvider>
          {children}
          <ThemeApplier />
          <JobPump />
        </UploadProvider>
      </ToastProvider>
    </SessionProvider>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense>
      <AuthenticatedApp>{children}</AuthenticatedApp>
    </Suspense>
  );
}

"use client";

import {
  Activity,
  BrainCircuit,
  CalendarDays,
  Clapperboard,
  CreditCard,
  Flag,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MoreHorizontal,
  Plug,
  Plus,
  ScrollText,
  Settings,
  Share2,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { NotificationsBell } from "@/components/app/notifications";
import { Avatar, SessionProvider, useSession } from "@/components/app/session";
import { UploadProvider, useUpload } from "@/components/app/upload";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Popover, menuItemClass } from "@/components/ui/popover";
import { Progress } from "@/components/ui/primitives";
import { ToastProvider } from "@/components/ui/toast";
import { api, type Role, type User } from "@/lib/api";
import { bytes, percent } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type NavItem = { href: string; label: string; icon: LucideIcon; roles?: Role[] };

const MAIN: NavItem[] = [
  { href: "/dashboard", label: "Início", icon: LayoutDashboard },
  { href: "/videos", label: "Vídeos", icon: Clapperboard },
  { href: "/agenda", label: "Agenda", icon: CalendarDays },
  { href: "/contas", label: "Redes sociais", icon: Share2 },
  { href: "/plano", label: "Plano", icon: CreditCard },
];

const ACCOUNT: NavItem[] = [
  { href: "/armazenamento", label: "Armazenamento", icon: HardDrive },
  { href: "/configuracoes", label: "Configurações", icon: Settings },
];

const ADMIN: NavItem[] = [
  { href: "/admin", label: "Visão geral", icon: Activity, roles: ["admin", "super_admin"] },
  { href: "/admin/pessoas", label: "Pessoas", icon: Users },
  { href: "/admin/logs", label: "Logs", icon: ScrollText },
  { href: "/admin/jobs", label: "Fila de jobs", icon: ListChecks },
  { href: "/admin/integracoes", label: "Integrações", icon: Plug, roles: ["admin", "super_admin"] },
  { href: "/admin/ia", label: "IA", icon: BrainCircuit, roles: ["super_admin"] },
  { href: "/admin/planos", label: "Planos e cupons", icon: Tags, roles: ["admin", "super_admin"] },
  { href: "/admin/flags", label: "Feature flags", icon: Flag, roles: ["super_admin"] },
];

const visible = (items: NavItem[], role: Role) => items.filter((i) => !i.roles || i.roles.includes(role));

function isActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group relative flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-soft ${
        active ? "bg-brand/12 text-ink" : "text-ink-2 hover:bg-surface-3 hover:text-ink"
      }`}
    >
      {active ? <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-brand" /> : null}
      <Icon aria-hidden className={`h-[17px] w-[17px] ${active ? "text-brand-soft" : "text-muted group-hover:text-ink-2"}`} strokeWidth={1.8} />
      {item.label}
    </Link>
  );
}

function StorageMeter() {
  const { data } = useApi<{ usage: { storage_used_bytes: number; storage_limit_bytes: number; plan_id: string } }>(
    "/api/v1/usage",
  );
  if (!data) return null;
  const { storage_used_bytes: used, storage_limit_bytes: limit } = data.usage;
  const p = percent(used, limit);
  return (
    <Link
      href="/armazenamento"
      className="block rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-brand-soft"
    >
      <span className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink-2">Espaço</span>
        <span className="font-mono text-muted tabular-nums">{p}%</span>
      </span>
      <Progress value={p} label="Espaço usado" tone={p >= 90 ? "danger" : p >= 75 ? "warning" : "brand"} className="mt-2" />
      <span className="mt-1.5 block text-[11px] text-muted">
        {bytes(used)} de {bytes(limit)}
      </span>
    </Link>
  );
}

function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user } = useSession();
  const router = useRouter();
  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }
  return (
    <Popover
      label="Menu da conta"
      side={compact ? "bottom" : "top"}
      align={compact ? "end" : "start"}
      panelClassName="w-60"
      buttonClassName={
        compact
          ? "rounded-full"
          : "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-3"
      }
      trigger={
        compact ? (
          <Avatar user={user} />
        ) : (
          <>
            <Avatar user={user} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-ink">{user.name}</span>
              <span className="block truncate text-[11.5px] text-muted">{user.email}</span>
            </span>
            <MoreHorizontal aria-hidden className="h-4 w-4 shrink-0 text-muted" />
          </>
        )
      }
    >
      {(close) => (
        <>
          <div className="px-2.5 pt-1.5 pb-2">
            <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link href="/configuracoes" onClick={close} className={menuItemClass}>
            <Settings aria-hidden />
            Configurações
          </Link>
          <Link href="/plano" onClick={close} className={menuItemClass}>
            <CreditCard aria-hidden />
            Plano e faturas
          </Link>
          <div className="my-1 h-px bg-line" />
          <button type="button" onClick={logout} className={menuItemClass}>
            <LogOut aria-hidden />
            Sair
          </button>
        </>
      )}
    </Popover>
  );
}

function Sidebar({ pathname }: { pathname: string }) {
  const { user, isStaff } = useSession();
  return (
    <aside aria-label="Menu do Clipo" className="fixed inset-y-0 left-0 z-30 hidden w-[15.5rem] flex-col border-r border-line bg-[linear-gradient(180deg,#040b13,#02070d)] lg:flex">
      <div className="flex h-16 items-center px-5">
        <Logo size="sm" href="/dashboard" />
      </div>
      <nav aria-label="Principal" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 pt-2 pb-4">
        <ul className="grid gap-0.5">
          {MAIN.map((item) => (
            <li key={item.href}>
              <NavLink item={item} pathname={pathname} />
            </li>
          ))}
        </ul>
        <div>
          <p className="px-3 pb-1.5 text-[11px] font-semibold text-faint">Conta</p>
          <ul className="grid gap-0.5">
            {ACCOUNT.map((item) => (
              <li key={item.href}>
                <NavLink item={item} pathname={pathname} />
              </li>
            ))}
          </ul>
        </div>
        {isStaff ? (
          <div>
            <p className="px-3 pb-1.5 text-[11px] font-semibold text-faint">Administração</p>
            <ul className="grid gap-0.5">
              {visible(ADMIN, user.role).map((item) => (
                <li key={item.href}>
                  <NavLink item={item} pathname={pathname} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </nav>
      <div className="grid gap-3 border-t border-line p-3">
        <StorageMeter />
        <UserMenu />
      </div>
    </aside>
  );
}

function MobileNav({ pathname }: { pathname: string }) {
  const upload = useUpload();
  const { user, isStaff } = useSession();
  const [more, setMore] = useState(false);
  const items = MAIN.slice(0, 3);
  const rest = [...MAIN.slice(3), ...ACCOUNT, ...(isStaff ? visible(ADMIN, user.role) : [])];
  return (
    <>
      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[#040a12]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
      >
        <ul className="grid h-16 grid-cols-5">
          {items.slice(0, 2).map((item) => (
            <MobileTab key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
          <li className="flex items-center justify-center">
            <button
              type="button"
              onClick={upload}
              aria-label="Enviar vídeo"
              className="btn-glow flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
            >
              <Plus aria-hidden className="h-5 w-5" />
            </button>
          </li>
          <MobileTab item={items[2]} active={isActive(pathname, items[2].href)} />
          <li>
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              aria-expanded={more}
              aria-controls="mobile-more"
              className={`flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1 text-[11px] font-medium ${more ? "text-ink" : "text-muted"}`}
            >
              <MoreHorizontal aria-hidden className="h-5 w-5" />
              Mais
            </button>
          </li>
        </ul>
      </nav>
      {more ? (
        <div className="fixed inset-0 z-30 lg:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-0 bg-overlay" />
          <div
            id="mobile-more"
            className="glass absolute inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-h-[70dvh] overflow-y-auto rounded-2xl p-2 animate-rise-in"
            onClick={(e) => e.stopPropagation()}
          >
            <ul className="grid gap-0.5">
              {rest.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} pathname={pathname} onNavigate={() => setMore(false)} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}

function MobileTab({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? "text-ink" : "text-muted"}`}
      >
        <Icon aria-hidden className={`h-5 w-5 ${active ? "text-brand-soft" : ""}`} strokeWidth={1.8} />
        {item.label}
      </Link>
    </li>
  );
}

function Topbar() {
  const upload = useUpload();
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur-md sm:px-6">
      <div className="lg:hidden">
        <Logo size="sm" href="/dashboard" />
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {/* No celular o envio fica no botão "+" da barra de baixo. */}
        <div className="hidden sm:block">
          <Button variant="primary" size="md" onClick={upload} icon={<Plus aria-hidden className="h-4 w-4" />}>
            Enviar vídeo
          </Button>
        </div>
        <NotificationsBell />
        <div className="lg:hidden">
          <UserMenu compact />
        </div>
      </div>
    </header>
  );
}

function SuspendedBanner() {
  const { user } = useSession();
  if (user.status !== "pending_deletion") return null;
  return (
    <div role="status" className="border-b border-warning/30 bg-warning/10 px-6 py-2.5 text-center text-sm text-[#fbe0ad]">
      Sua conta está agendada para exclusão. Para desistir, vá em{" "}
      <Link href="/configuracoes#privacidade" className="font-semibold underline underline-offset-4">
        Configurações
      </Link>
      .
    </div>
  );
}

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <SessionProvider user={user}>
      <ToastProvider>
        <UploadProvider>
          <a
            href="#conteudo"
            className="sr-only z-[80] rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
          >
            Pular para o conteúdo
          </a>
          <Sidebar pathname={pathname} />
          <div className="min-h-dvh lg:pl-[15.5rem]">
            <Topbar />
            <SuspendedBanner />
            <main id="conteudo" className="mx-auto w-full max-w-[1320px] px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pb-12">
              {children}
            </main>
          </div>
          <MobileNav pathname={pathname} />
        </UploadProvider>
      </ToastProvider>
    </SessionProvider>
  );
}

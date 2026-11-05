"use client";

import { Bell, CheckCheck, CreditCard, HardDrive, Link2Off, Send, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";

import { Popover } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Notification = {
  id: string;
  kind: "publish_success" | "publish_failure" | "reconnect_required" | "storage_alert" | "billing";
  title: string;
  body: string;
  link: string;
  read: boolean;
  created_at: string;
};

const ICONS = {
  publish_success: <Send aria-hidden className="text-success" />,
  publish_failure: <TriangleAlert aria-hidden className="text-danger" />,
  reconnect_required: <Link2Off aria-hidden className="text-warning" />,
  storage_alert: <HardDrive aria-hidden className="text-warning" />,
  billing: <CreditCard aria-hidden className="text-brand-soft" />,
};

export function NotificationsBell() {
  const router = useRouter();
  const { data, mutate } = useApi<{ items: Notification[]; unread: number }>("/api/v1/notifications?limit=12", {
    refreshMs: 60_000,
  });
  const unread = data?.unread ?? 0;

  async function open(n: Notification, close: () => void) {
    close();
    if (!n.read) {
      mutate((prev) => ({
        items: (prev?.items ?? []).map((x) => (x.id === n.id ? { ...x, read: true } : x)),
        unread: Math.max(0, (prev?.unread ?? 1) - 1),
      }));
      void api(`/api/v1/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    }
    router.push(n.link);
  }

  async function readAll() {
    mutate((prev) => ({ items: (prev?.items ?? []).map((x) => ({ ...x, read: true })), unread: 0 }));
    await api("/api/v1/notifications/read-all", { method: "POST" }).catch(() => undefined);
  }

  return (
    <Popover
      label={unread ? `Avisos, ${unread} não lidos` : "Avisos"}
      panelClassName="w-[min(24rem,calc(100vw-1.5rem))] p-0"
      buttonClassName="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
      trigger={
        <>
          <Bell aria-hidden className="h-[18px] w-[18px]" />
          {unread ? (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 font-mono text-[10px] font-bold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </>
      }
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-semibold">Avisos</p>
            {unread ? (
              <button
                type="button"
                onClick={readAll}
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-brand-soft hover:bg-surface-3"
              >
                <CheckCheck aria-hidden className="h-3.5 w-3.5" />
                Marcar todos como lidos
              </button>
            ) : null}
          </div>
          {data && data.items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted">Nenhum aviso por enquanto.</p>
          ) : (
            <ul className="max-h-[min(26rem,70dvh)] overflow-y-auto p-1.5">
              {(data?.items ?? []).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n, close)}
                    className="flex w-full cursor-pointer gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-3 [&>svg]:h-4 [&>svg]:w-4">
                      {ICONS[n.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[13px] leading-snug ${n.read ? "text-ink-2" : "font-semibold text-ink"}`}>
                        {n.title}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>
                      <span className="mt-1 block text-[11px] text-faint">{ago(n.created_at)}</span>
                    </span>
                    {n.read ? null : <span className="sr-only">Não lido</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Popover>
  );
}

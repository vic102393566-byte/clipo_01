"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Avatar } from "@/components/app/session";
import { Select } from "@/components/ui/field";
import { Badge, EmptyState, ErrorState, PageHeader, Panel, Skeleton } from "@/components/ui/primitives";
import { ago, day } from "@/lib/format";
import { ROLE_LABEL, STATUS, type AdminUser } from "@/lib/admin";
import { useApi } from "@/lib/use-api";

export default function PeoplePage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const path = useMemo(() => {
    const p = new URLSearchParams({ limit: "50" });
    if (debounced) p.set("q", debounced);
    if (status) p.set("status", status);
    if (role) p.set("role", role);
    return `/api/v1/admin/users?${p}`;
  }, [debounced, status, role]);
  const list = useApi<{ items: AdminUser[]; total: number }>(path);

  return (
    <>
      <PageHeader title="Pessoas" description={list.data ? `${list.data.total} contas` : undefined} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="relative w-full sm:w-80">
          <span className="sr-only">Buscar por nome, e-mail ou id</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nome, e-mail ou id"
            className="h-10 w-full rounded-lg border border-line bg-surface-2/80 pr-3 pl-9 text-sm outline-none placeholder:text-faint focus:border-brand-soft/80"
          />
        </label>
        <Select label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">Todas</option>
          <option value="active">Ativas</option>
          <option value="suspended">Suspensas</option>
          <option value="pending_deletion">Excluindo</option>
        </Select>
        <Select label="Papel" value={role} onChange={(e) => setRole(e.target.value)} className="w-40">
          <option value="">Todos</option>
          {Object.entries(ROLE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      <Panel as="div">
        {list.error ? (
          <ErrorState message={list.error.message} onRetry={list.reload} />
        ) : list.loading ? (
          <div className="grid gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !list.data?.items.length ? (
          <EmptyState title="Ninguém encontrado" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th scope="col" className="px-5 py-2.5 font-medium">Pessoa</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Plano</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Situação</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Papel</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Última atividade</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Desde</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.items.map((u) => (
                  <tr key={u.id} className="transition-colors hover:bg-surface-2">
                    <td className="px-5 py-2.5">
                      <Link href={`/admin/pessoas/${u.id}`} className="flex items-center gap-3 rounded focus-visible:outline-2 focus-visible:outline-brand-soft">
                        <Avatar user={{ name: u.name, avatar_url: null }} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{u.name}</span>
                          <span className="block truncate text-xs text-muted">{u.email}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">
                      {u.plan_id}
                      {u.subscription_status === "trialing" ? <span className="ml-1.5 text-xs text-muted">(teste)</span> : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={(STATUS[u.status] ?? ["success"])[0]}>{(STATUS[u.status] ?? ["", u.status])[1]}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">{ROLE_LABEL[u.role] ?? u.role}</td>
                    <td className="px-3 py-2.5 text-ink-2">{u.last_active_at ? ago(u.last_active_at) : "-"}</td>
                    <td className="px-5 py-2.5 text-ink-2">{day(u.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

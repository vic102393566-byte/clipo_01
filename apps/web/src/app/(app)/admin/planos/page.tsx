"use client";

import { Pencil, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, TextArea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Badge, ErrorState, PageHeader, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { brl, bytes, day, durationText } from "@/lib/format";
import type { Plan } from "@/lib/types";
import { useApi } from "@/lib/use-api";

type AdminPlan = Plan & { users: number };
type Coupon = { code: string; kind: "percent" | "amount"; value: number; duration: string; plan_ids: string[]; max_redemptions: number | null; redemptions: number; expires_at: string | null; active: boolean };

const GB = 1024 ** 3;

export default function PlansAdminPage() {
  const toast = useToast();
  const plans = useApi<{ items: AdminPlan[] }>("/api/v1/admin/plans");
  const coupons = useApi<{ items: Coupon[] }>("/api/v1/admin/coupons");
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [couponForm, setCouponForm] = useState<null | Record<string, string>>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function edit(p: AdminPlan) {
    setEditing(p);
    setError(null);
    setForm({
      name: p.name,
      price_monthly: String(p.price_monthly_cents / 100),
      price_yearly: String(p.price_yearly_cents / 100),
      storage_gb: String(p.storage_bytes / GB),
      file_gb: String(p.max_file_bytes / GB),
      minutes: String(p.max_duration_seconds / 60),
      videos: String(p.videos_per_month),
      accounts: String(p.social_accounts),
      credits: String(p.ai_credits_month),
      features: p.features.join("\n"),
      public: p.public ? "1" : "",
      active: p.active ? "1" : "",
      order: String(p.order),
    });
  }

  async function savePlan() {
    if (!editing) return;
    setPending(true);
    setError(null);
    try {
      await api(`/api/v1/admin/plans/${editing.id}`, {
        method: "PUT",
        body: {
          name: form.name,
          price_monthly_cents: Math.round(Number(form.price_monthly) * 100),
          price_yearly_cents: Math.round(Number(form.price_yearly) * 100),
          storage_bytes: Math.round(Number(form.storage_gb) * GB),
          max_file_bytes: Math.round(Number(form.file_gb) * GB),
          max_duration_seconds: Math.round(Number(form.minutes) * 60),
          videos_per_month: Number(form.videos),
          social_accounts: Number(form.accounts),
          ai_credits_month: Number(form.credits),
          features: form.features.split("\n").map((f) => f.trim()).filter(Boolean),
          public: Boolean(form.public),
          active: Boolean(form.active),
          order: Number(form.order),
        },
      });
      toast("success", "Plano salvo. Quem já assina segue no valor atual.");
      setEditing(null);
      void plans.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar.");
    } finally {
      setPending(false);
    }
  }

  async function saveCoupon() {
    if (!couponForm) return;
    setPending(true);
    setError(null);
    try {
      await api("/api/v1/admin/coupons", {
        method: "POST",
        body: {
          code: couponForm.code,
          kind: couponForm.kind,
          value: couponForm.kind === "amount" ? Math.round(Number(couponForm.value) * 100) : Number(couponForm.value),
          duration: couponForm.duration,
          plan_ids: couponForm.plan ? [couponForm.plan] : [],
          max_redemptions: couponForm.max ? Number(couponForm.max) : undefined,
          expires_at: couponForm.expires ? new Date(`${couponForm.expires}T23:59:59`).toISOString() : undefined,
        },
      });
      toast("success", "Cupom criado.");
      setCouponForm(null);
      void coupons.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível criar.");
    } finally {
      setPending(false);
    }
  }

  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Planos e cupons" description="Preços e limites valem para checkouts novos. Quem já assina segue no valor que contratou." />
      <div className="grid gap-6">
        <Panel>
          <PanelHeader title="Planos" />
          {plans.error ? (
            <ErrorState message={plans.error.message} onRetry={plans.reload} />
          ) : !plans.data ? (
            <div className="p-5"><Skeleton className="h-32" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    {["Plano", "Mensal", "Anual", "Espaço", "Por arquivo", "Duração", "Vídeos/mês", "Redes", "IA", "Pessoas", ""].map((h, i) => (
                      <th key={i} scope="col" className="px-4 py-2.5 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {plans.data.items.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-ink">{p.name}</span>{" "}
                        {!p.public ? <Badge>Não vendido</Badge> : null} {!p.active ? <Badge tone="warning">Inativo</Badge> : null}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-ink-2">{brl(p.price_monthly_cents)}</td>
                      <td className="px-4 py-2.5 font-mono text-ink-2">{brl(p.price_yearly_cents)}</td>
                      <td className="px-4 py-2.5 text-ink-2">{bytes(p.storage_bytes)}</td>
                      <td className="px-4 py-2.5 text-ink-2">{bytes(p.max_file_bytes)}</td>
                      <td className="px-4 py-2.5 text-ink-2">{durationText(p.max_duration_seconds)}</td>
                      <td className="px-4 py-2.5 font-mono text-ink-2">{p.videos_per_month}</td>
                      <td className="px-4 py-2.5 font-mono text-ink-2">{p.social_accounts}</td>
                      <td className="px-4 py-2.5 font-mono text-ink-2">{p.ai_credits_month}</td>
                      <td className="px-4 py-2.5 font-mono text-ink-2">{p.users}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button size="sm" variant="ghost" onClick={() => edit(p)} aria-label={`Editar ${p.name}`} icon={<Pencil aria-hidden className="h-3.5 w-3.5" />} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Cupons"
            actions={
              <Button size="sm" variant="outline" onClick={() => { setError(null); setCouponForm({ code: "", kind: "percent", value: "10", duration: "once", plan: "", max: "", expires: "" }); }} icon={<Plus aria-hidden className="h-3.5 w-3.5" />}>
                Novo cupom
              </Button>
            }
          />
          {!coupons.data ? (
            <div className="p-5"><Skeleton className="h-20" /></div>
          ) : coupons.data.items.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">Nenhum cupom.</p>
          ) : (
            <ul className="divide-y divide-line">
              {coupons.data.items.map((c) => (
                <li key={c.code} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <span className="w-32 font-mono font-semibold text-ink">{c.code}</span>
                  <span className="text-ink-2">
                    {c.kind === "percent" ? `${c.value}%` : brl(c.value)} {c.duration === "once" ? "na 1ª cobrança" : "sempre"}
                  </span>
                  <span className="flex-1 text-xs text-muted">
                    {c.redemptions}{c.max_redemptions ? `/${c.max_redemptions}` : ""} usos
                    {c.plan_ids.length ? ` · ${c.plan_ids.join(", ")}` : ""}
                    {c.expires_at ? ` · até ${day(c.expires_at)}` : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api(`/api/v1/admin/coupons/${c.code}`, { method: "PATCH", body: { active: !c.active } }).catch(() => undefined);
                      void coupons.reload();
                    }}
                  >
                    {c.active ? "Desativar" : "Ativar"}
                  </Button>
                  {!c.active ? <Badge>Inativo</Badge> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        size="lg"
        title={`Editar plano ${editing?.name ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button variant="primary" pending={pending} onClick={savePlan}>Salvar plano</Button>
          </>
        }
      >
        <div className="grid gap-4">
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Nome" value={form.name ?? ""} onChange={set("name")} />
            <Field label="Preço mensal (R$)" type="number" step="0.01" min={0} value={form.price_monthly ?? ""} onChange={set("price_monthly")} />
            <Field label="Preço anual (R$)" type="number" step="0.01" min={0} value={form.price_yearly ?? ""} onChange={set("price_yearly")} />
            <Field label="Espaço (GB)" type="number" min={0} value={form.storage_gb ?? ""} onChange={set("storage_gb")} />
            <Field label="Arquivo até (GB)" type="number" min={0} step="0.5" value={form.file_gb ?? ""} onChange={set("file_gb")} />
            <Field label="Vídeo até (min)" type="number" min={0} value={form.minutes ?? ""} onChange={set("minutes")} />
            <Field label="Vídeos por mês" type="number" min={0} value={form.videos ?? ""} onChange={set("videos")} />
            <Field label="Redes sociais" type="number" min={0} max={20} value={form.accounts ?? ""} onChange={set("accounts")} />
            <Field label="Créditos de IA/mês" type="number" min={0} value={form.credits ?? ""} onChange={set("credits")} />
          </div>
          <TextArea label="O que aparece na tela de planos (um por linha)" rows={5} value={form.features ?? ""} onChange={set("features")} />
          <div className="flex flex-wrap gap-6 text-sm text-ink-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(form.public)} onChange={(e) => setForm({ ...form, public: e.target.checked ? "1" : "" })} className="h-4 w-4 accent-[var(--color-brand)]" />
              Vendido (aparece na tela de planos)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(form.active)} onChange={(e) => setForm({ ...form, active: e.target.checked ? "1" : "" })} className="h-4 w-4 accent-[var(--color-brand)]" />
              Ativo
            </label>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(couponForm)}
        onClose={() => setCouponForm(null)}
        title="Novo cupom"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCouponForm(null)}>Cancelar</Button>
            <Button variant="primary" pending={pending} disabled={!couponForm?.code || !couponForm.value} onClick={saveCoupon}>Criar cupom</Button>
          </>
        }
      >
        {couponForm ? (
          <div className="grid gap-4">
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Código" value={couponForm.code} onChange={(e) => setCouponForm({ ...couponForm, code: e.target.value.toUpperCase() })} placeholder="LANCAMENTO20" />
              <Select label="Tipo" value={couponForm.kind} onChange={(e) => setCouponForm({ ...couponForm, kind: e.target.value })}>
                <option value="percent">Percentual</option>
                <option value="amount">Valor fixo (R$)</option>
              </Select>
              <Field label={couponForm.kind === "percent" ? "Desconto (%)" : "Desconto (R$)"} type="number" min={1} value={couponForm.value} onChange={(e) => setCouponForm({ ...couponForm, value: e.target.value })} />
              <Select label="Vale" value={couponForm.duration} onChange={(e) => setCouponForm({ ...couponForm, duration: e.target.value })}>
                <option value="once">Só na primeira cobrança</option>
                <option value="forever">Em todas as cobranças</option>
              </Select>
              <Select label="Plano" value={couponForm.plan} onChange={(e) => setCouponForm({ ...couponForm, plan: e.target.value })}>
                <option value="">Todos</option>
                {(plans.data?.items ?? []).filter((p) => p.public).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
              <Field label="Limite de usos" type="number" min={1} value={couponForm.max} onChange={(e) => setCouponForm({ ...couponForm, max: e.target.value })} placeholder="Sem limite" />
              <Field label="Válido até" type="date" value={couponForm.expires} onChange={(e) => setCouponForm({ ...couponForm, expires: e.target.value })} />
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

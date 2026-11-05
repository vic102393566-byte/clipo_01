"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Badge, EmptyState, ErrorState, PageHeader, Panel, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";

type Flag = { key: string; enabled: boolean; description: string; rollout_percent: number; plan_ids: string[]; user_ids: string[] };
type Form = { key: string; enabled: boolean; description: string; rollout: string; plans: string; users: string; isNew: boolean };

export default function FlagsPage() {
  const toast = useToast();
  const flags = useApi<{ items: Flag[] }>("/api/v1/admin/flags");
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    if (!form) return;
    setPending(true);
    setError(null);
    try {
      await api(`/api/v1/admin/flags/${form.key}`, {
        method: "PUT",
        body: {
          enabled: form.enabled,
          description: form.description,
          rollout_percent: Number(form.rollout),
          plan_ids: form.plans.split(",").map((s) => s.trim()).filter(Boolean),
          user_ids: form.users.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        },
      });
      toast("success", "Flag salva.");
      setForm(null);
      void flags.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Feature flags"
        description="Ligue funções para todos, para planos, para pessoas ou para uma parte das contas, sem publicar código novo."
        actions={
          <Button variant="primary" onClick={() => { setError(null); setForm({ key: "", enabled: false, description: "", rollout: "100", plans: "", users: "", isNew: true }); }} icon={<Plus aria-hidden className="h-4 w-4" />}>
            Nova flag
          </Button>
        }
      />
      <Panel as="div">
        {flags.error ? (
          <ErrorState message={flags.error.message} onRetry={flags.reload} />
        ) : !flags.data ? (
          <div className="p-5"><Skeleton className="h-24" /></div>
        ) : flags.data.items.length === 0 ? (
          <EmptyState title="Nenhuma flag" description="Crie uma para liberar uma função aos poucos." />
        ) : (
          <ul className="divide-y divide-line">
            {flags.data.items.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-brand-soft"
                  onClick={() => { setError(null); setForm({ key: f.key, enabled: f.enabled, description: f.description, rollout: String(f.rollout_percent), plans: f.plan_ids.join(", "), users: f.user_ids.join("\n"), isNew: false }); }}
                >
                  <span className="block font-mono font-semibold text-ink">{f.key}</span>
                  <span className="block truncate text-xs text-muted">{f.description || "Sem descrição"}</span>
                </button>
                <span className="text-xs text-muted">
                  {f.rollout_percent}%{f.plan_ids.length ? ` · ${f.plan_ids.join(", ")}` : ""}{f.user_ids.length ? ` · ${f.user_ids.length} pessoas` : ""}
                </span>
                {f.enabled ? <Badge tone="success">Ligada</Badge> : <Badge>Desligada</Badge>}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Apagar ${f.key}`}
                  icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
                  onClick={async () => {
                    await api(`/api/v1/admin/flags/${f.key}`, { method: "DELETE" }).catch(() => undefined);
                    void flags.reload();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Dialog
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.isNew ? "Nova flag" : `Editar ${form?.key}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>Cancelar</Button>
            <Button variant="primary" pending={pending} disabled={!form || !/^[a-z0-9_.-]{2,60}$/.test(form.key)} onClick={save}>Salvar</Button>
          </>
        }
      >
        {form ? (
          <div className="grid gap-4">
            {error ? <Notice tone="error">{error}</Notice> : null}
            {form.isNew ? <Field label="Chave" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase() })} placeholder="editor-novo" hint="Letras minúsculas, números, ponto, hífen e sublinhado." /> : null}
            <Field label="Descrição" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4 accent-[var(--color-brand)]" />
              Ligada
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Porcentagem das contas" type="number" min={0} max={100} value={form.rollout} onChange={(e) => setForm({ ...form, rollout: e.target.value })} />
              <Field label="Só nos planos" value={form.plans} onChange={(e) => setForm({ ...form, plans: e.target.value })} placeholder="pro, premium" hint="Vazio: todos" />
            </div>
            <Field label="Sempre ligada para (ids, separados por vírgula)" value={form.users} onChange={(e) => setForm({ ...form, users: e.target.value })} />
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

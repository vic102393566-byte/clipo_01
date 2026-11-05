"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  Layers,
  LayoutDashboard,
  Percent,
  Receipt,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  User,
  Users,
  Video as VideoIcon,
  Zap,
} from "lucide-react";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { brl, bytes, day, percent } from "@/lib/format";
import type { Billing, Connection, Plan } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface Invoice {
  id: string;
  number: string;
  period: string;
  amount: string;
  status: "Paga" | "Pendente";
  date: string;
  pdfUrl?: string;
}

const PAY_STATUS: Record<string, Invoice["status"]> = {
  RECEIVED: "Paga",
  CONFIRMED: "Paga",
  RECEIVED_IN_CASH: "Paga",
};

const brlMonth = (cents: number) => brl(cents);

const SUB_LABEL: Record<string, string> = {
  trialing: "Teste grátis",
  active: "Ativo",
  past_due: "Pagamento pendente",
  manual: "Cortesia",
  expired: "Gratuito",
};

export default function PlanoConfiguracoesPage() {
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const bill = useApi<Billing>("/api/v1/billing");
  const plans = useApi<{ items: Plan[] }>("/api/v1/plans");
  const conns = useApi<{ items: Connection[] }>("/api/v1/connections");
  const team = useApi<{ seats: { used: number; limit: number } }>("/api/v1/workspace/members");
  const [busy, setBusy] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };
  const sub = bill.data?.subscription;
  const current = bill.data?.plan;
  const usage = bill.data?.usage;
  const storagePct = usage ? percent(usage.storage_used_bytes, usage.storage_limit_bytes) : 0;
  const connected = (conns.data?.items ?? []).filter((c) => c.connected).length;
  const socialLimit = current?.social_accounts ?? 1;
  const seats = team.data?.seats;
  const nextDate = sub?.trial_ends_at ?? sub?.current_period_end ?? null;
  const pending = bill.data?.payments.find((x) => !PAY_STATUS[x.status] && x.invoice_url && !x.refunded);
  const INVOICES: Invoice[] = (bill.data?.payments ?? []).map((x, i) => ({
    id: x.id,
    number: `Fatura #${String((bill.data?.payments.length ?? 0) - i).padStart(3, "0")}`,
    period: x.billing_type === "UNDEFINED" ? "Pix, boleto ou cartão" : x.billing_type,
    amount: brl(x.value_cents),
    status: x.refunded ? "Pendente" : (PAY_STATUS[x.status] ?? "Pendente"),
    date: `Vencimento ${day(x.due_date)}`,
    pdfUrl: x.invoice_url ?? undefined,
  }));

  const choose = async (plan: Plan) => {
    setBusy(plan.id);
    try {
      const paying = sub && ["active", "past_due"].includes(sub.status) && sub.plan_id !== "gratis";
      if (paying) {
        await api("/api/v1/billing/change-plan", { method: "POST", body: { plan_id: plan.id, cycle: billingCycle } });
        showToast("Plano alterado. Subir vale na hora; descer vale no fim do período pago.");
      } else {
        const out = await api<{ invoice_url: string }>("/api/v1/billing/checkout", {
          method: "POST",
          body: { plan_id: plan.id, cycle: billingCycle },
        });
        if (out.invoice_url) window.open(out.invoice_url, "_blank", "noopener");
        showToast("Fatura aberta numa nova aba. O plano libera assim que o pagamento confirmar.");
      }
      await bill.reload();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Não foi possível mudar o plano.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-screen bg-[#030914] text-[#c3d0e5] font-sans antialiased selection:bg-[#0066ff] selection:text-white">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-5 right-6 z-50 flex items-center gap-2.5 rounded-xl border border-[#22487a] bg-[#0c1f38]/95 px-4 py-3 text-sm font-semibold text-white shadow-2xl backdrop-blur-md animate-in fade-in">
          <Sparkles className="h-4 w-4 text-[#00e5ff]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* =========================================================================
          BARRA LATERAL FIXA (SIDEBAR CLIPO PADRÃO)
         ========================================================================= */}
      <aside className="fixed top-0 bottom-0 left-0 z-30 flex w-[270px] flex-col border-r border-[#0f1f35] bg-[#040c1a]">
        <div className="flex h-16 items-center justify-between px-5">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-[#0055ff] to-[#00c8ff] shadow-[0_0_15px_rgba(0,140,255,0.4)]">
              <span className="text-lg font-black text-white">C</span>
            </div>
            <span className="text-xl font-extrabold tracking-tight text-white">clipo</span>
          </Link>

          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#142640] text-[#7187a5] hover:bg-[#0c1b30] hover:text-white transition"
            aria-label="Recolher menu"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3.5 py-2 scrollbar-none">
          <nav className="space-y-4">
            <div>
              <Link
                href="/dashboard"
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-[#8fa2be] hover:bg-[#08162b] hover:text-white transition"
              >
                <LayoutDashboard className="h-4 w-4 text-[#7187a5]" />
                <span>Início</span>
              </Link>
            </div>

            {/* SEÇÃO CONTEÚDO */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Conteúdo</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>

              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => setIsVideoMenuOpen(!isVideoMenuOpen)}
                  className="w-full flex items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold text-[#8fa2be] hover:bg-[#08162b] hover:text-white transition"
                >
                  <div className="flex items-center gap-2.5">
                    <VideoIcon className="h-4 w-4 text-[#7187a5]" />
                    <span>Vídeos</span>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 text-[#5e779d] transition-transform duration-200 ${
                      isVideoMenuOpen ? "rotate-0" : "-rotate-90"
                    }`}
                  />
                </button>

                {isVideoMenuOpen && (
                  <div className="relative ml-4 pl-4 pt-1 pb-1 before:absolute before:top-2.5 before:bottom-2.5 before:left-[3px] before:w-px before:bg-[#193356]">
                    <ul className="space-y-2.5 text-[13px]">
                      <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                        <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                        <Link href="/videos" className="w-full py-0.5">Meus vídeos</Link>
                      </li>
                      <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                        <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                        <Link href="/fila" className="w-full py-0.5">Fila de publicação</Link>
                      </li>
                      <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                        <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                        <Link href="/biblioteca" className="w-full py-0.5">Biblioteca</Link>
                      </li>
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {/* SEÇÃO PLANEJAMENTO */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Planejamento</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>
              <Link
                href="/calendario"
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-[#8fa2be] hover:bg-[#08162b] hover:text-white transition"
              >
                <Layers className="h-4 w-4 text-[#7187a5]" />
                <span>Calendário</span>
              </Link>
            </div>

            {/* SEÇÃO ANÁLISES */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Análises</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>
              <Link
                href="/resultados"
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-[#8fa2be] hover:bg-[#08162b] hover:text-white transition"
              >
                <Zap className="h-4 w-4 text-[#7187a5]" />
                <span>Resultados</span>
              </Link>
            </div>

            {/* SEÇÃO ESTÚDIO IA */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Estúdio IA</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>
              <div className="relative ml-4 pl-4 pt-1 pb-1 before:absolute before:top-2.5 before:bottom-2.5 before:left-[3px] before:w-px before:bg-[#193356]">
                <ul className="space-y-2.5 text-[13px]">
                  <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                    <Link href="/ideias" className="w-full py-0.5">Ideias de conteúdo</Link>
                  </li>
                  <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                    <Link href="/roteiros" className="w-full py-0.5">Roteiros</Link>
                  </li>
                  <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                    <Link href="/modelos" className="w-full py-0.5">Modelos</Link>
                  </li>
                </ul>
              </div>
            </div>

            {/* Item Configurações (ATIVO) */}
            <div className="pt-1">
              <Link
                href="/configuracoes"
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-bold text-white bg-[#0b213d] border border-[#1b3d68] shadow-[0_0_15px_rgba(0,102,255,0.25)] transition"
              >
                <Settings className="h-4 w-4 text-[#38bdf8]" />
                <span className="text-[#38bdf8]">Configurações</span>
              </Link>
            </div>
          </nav>
        </div>

        {/* Perfil */}
        <div className="border-t border-[#0f1f35] p-3.5">
          <Link
            href="/configuracoes/plano"
            className="flex items-center justify-between rounded-xl border border-[#1b3d68] bg-[#08162b] p-2 transition shadow-[0_0_15px_rgba(0,102,255,0.2)]"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-[#23436d] shadow-md">
                <CurrentUserAvatar />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-bold text-white"><CurrentUserName /></p>
                <p className="text-xs font-semibold text-[#00e5ff]"><CurrentPlanName /></p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-[#00e5ff]" />
          </Link>
        </div>
      </aside>

      {/* =========================================================================
          ÁREA PRINCIPAL: ASSINATURA & FATURAMENTO
         ========================================================================= */}
      <div className="flex-1 pl-[270px]">
        {/* Banner com Montanhas */}
        <div className="relative px-8 pt-6 pb-4 border-b border-[#0f2138]">
          <div
            className="absolute top-0 right-10 w-[550px] h-40 pointer-events-none opacity-35"
            style={{
              WebkitMaskImage: "linear-gradient(to bottom, black 20%, transparent 100%)",
              maskImage: "linear-gradient(to bottom, black 20%, transparent 100%)",
            }}
          >
            <Image
              src="/dashboard/mountains-glow.png"
              alt=""
              fill
              priority
              className="object-cover object-top"
            />
          </div>

          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Link
                href="/configuracoes"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#19365c] bg-[#081b33] text-[#7187a5] hover:border-[#00a6ff] hover:text-white transition shadow-sm"
                title="Voltar para Configurações"
                aria-label="Voltar para Configurações"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div>
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">Assinatura, Planos & Faturamento</h1>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Controle de créditos de renderização 4K, faturas Asaas, cartão cadastrado e upgrade de plano.
              </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => (pending?.invoice_url ? window.open(pending.invoice_url, "_blank", "noopener") : showToast("Nenhuma fatura em aberto."))}
                className="flex items-center gap-1.5 rounded-xl border border-[#1b3d68] bg-[#07172e] px-3.5 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#0d2342] hover:text-white transition"
              >
                <CreditCard className="h-3.5 w-3.5 text-[#38bdf8]" />
                <span>{pending ? "Pagar fatura em aberto" : "Faturas em dia"}</span>
              </button>

              <button
                type="button"
                onClick={() => document.getElementById("planos")?.scrollIntoView({ behavior: "smooth" })}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#0055ff] to-[#00c8ff] px-4 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,140,255,0.4)] hover:brightness-110 active:scale-95 transition"
              >
                <Zap className="h-3.5 w-3.5" />
                <span>Fazer Upgrade</span>
              </button>
            </div>
          </div>
        </div>

        {/* 4 KPIS NO TOPO (PADRÃO CLIPO DE ALTA DENSIDADE) */}
        <div className="px-8 pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Plano Ativo</span>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                  {SUB_LABEL[sub?.status ?? "expired"]}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{current ? `Plano ${current.name}` : "—"}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">
                {current && current.price_monthly_cents
                  ? sub?.cycle === "yearly"
                    ? `${brl(current.price_yearly_cents)} / ano`
                    : `${brl(current.price_monthly_cents)} / mês`
                  : "Sem cobrança"}
              </p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Vídeos no mês</span>
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#10b981]">
                  {usage ? `${usage.videos_this_month}/${usage.videos_per_month}` : "—"}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{usage ? `${usage.videos_this_month} enviados` : "—"}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Vídeos de até {usage ? Math.round(usage.max_duration_seconds / 60) : "—"} min</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Próxima Cobrança</span>
                <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#c084fc]">
                  {bill.data?.gateway === "simulado" ? "Simulada" : "Asaas"}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{nextDate ? day(nextDate) : "—"}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">
                {sub?.cancel_at_period_end ? "Cancela no fim do período" : sub?.status === "trialing" ? "Fim do teste grátis" : "Pix, boleto ou cartão"}
              </p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Armazenamento</span>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                  {bytes(usage?.storage_used_bytes)} / {bytes(usage?.storage_limit_bytes)}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{storagePct}% ocupado</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Vídeos, cortes e biblioteca</p>
            </div>
          </div>
        </div>

        {/* CONTEÚDO PRINCIPAL: 2 COLUNAS (PLANOS & CONSUMO + PAGAMENTO & NOTAS) */}
        <main className="px-8 pt-6 pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* COLUNA ESQUERDA: PLANOS & CONSUMO (7 COLS) */}
            <div className="lg:col-span-7 space-y-6">
              {/* 1. SELEÇÃO DE PLANOS */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Zap className="h-5 w-5 text-[#00e5ff]" />
                    <h2 className="text-base font-bold text-white">Planos de Assinatura Clipo</h2>
                  </div>

                  {/* Toggle Mensal / Anual */}
                  <div className="flex items-center gap-1.5 bg-[#08162b] p-1 rounded-lg border border-[#16355d]">
                    <button
                      type="button"
                      onClick={() => setBillingCycle("monthly")}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition ${
                        billingCycle === "monthly"
                          ? "bg-[#0055ff] text-white shadow-[0_0_10px_rgba(0,102,255,0.5)]"
                          : "text-[#7187a5] hover:text-white"
                      }`}
                    >
                      Mensal
                    </button>
                    <button
                      type="button"
                      onClick={() => setBillingCycle("yearly")}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition flex items-center gap-1 ${
                        billingCycle === "yearly"
                          ? "bg-[#0055ff] text-white shadow-[0_0_10px_rgba(0,102,255,0.5)]"
                          : "text-[#7187a5] hover:text-white"
                      }`}
                    >
                      <span>Anual</span>
                      <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] text-[#10b981]">
                        -20%
                      </span>
                    </button>
                  </div>
                </div>

                <div id="planos" className="mt-4 space-y-3">
                  {(plans.data?.items ?? []).map((plan) => {
                    const isCurrent = plan.id === current?.id;
                    const price = billingCycle === "monthly" ? plan.price_monthly_cents : Math.round(plan.price_yearly_cents / 12);
                    return isCurrent ? (
                      <div key={plan.id} className="rounded-xl border-2 border-[#00e5ff] bg-[#081c38] p-4 shadow-[0_0_25px_rgba(0,229,255,0.2)] flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-black text-white">Plano {plan.name}</h3>
                            <span className="rounded bg-[#00e5ff]/20 px-2 py-0.5 text-[10px] font-bold text-[#00e5ff] border border-[#00e5ff]/30">
                              Seu Plano Atual
                            </span>
                            <span className="text-xs font-bold text-white">{brlMonth(price)}/mês</span>
                          </div>
                          <p className="mt-1 text-xs text-[#8fa2be]">{plan.features.join(" • ")}</p>
                        </div>
                        <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-bold">
                          <Check className="h-4 w-4 stroke-[3]" />
                          <span>Ativo</span>
                        </div>
                      </div>
                    ) : (
                      <div key={plan.id} className="rounded-xl border border-[#142845] bg-[#050e1c] p-4 flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-white">Plano {plan.name}</h3>
                            <span className="text-xs text-[#7187a5]">{brlMonth(price)}/mês</span>
                          </div>
                          <p className="mt-1 text-xs text-[#7187a5]">{plan.features.join(" • ")}</p>
                        </div>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void choose(plan)}
                          className={
                            plan.order > (current?.order ?? 0)
                              ? "shrink-0 rounded-lg bg-gradient-to-r from-[#0055ff] to-[#00c8ff] px-3.5 py-1.5 text-xs font-bold text-white shadow-[0_0_12px_rgba(0,140,255,0.4)] hover:brightness-110 transition disabled:opacity-60"
                              : "shrink-0 rounded-lg border border-[#16355d] bg-[#07162b] px-3 py-1.5 text-xs font-semibold text-[#8fa2be] hover:bg-[#0c1f38] hover:text-white transition disabled:opacity-60"
                          }
                        >
                          {busy === plan.id ? "Abrindo..." : plan.order > (current?.order ?? 0) ? "Fazer Upgrade" : "Mudar para este"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 2. CONSUMO DE RECURSOS DO MÊS */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <TrendingUp className="h-5 w-5 text-[#38bdf8]" />
                    <h2 className="text-base font-bold text-white">Consumo de Recursos (Ciclo Vigente)</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#5e779d]">{nextDate ? `Renova em ${day(nextDate)}` : "Mês corrente"}</span>
                </div>

                <div className="mt-4 space-y-4">
                  {/* Item 1: Armazenamento DAM */}
                  <div>
                    <div className="flex justify-between text-xs font-semibold mb-1">
                      <span className="text-[#8fa2be]">Armazenamento</span>
                      <span className="text-white font-bold">
                        {bytes(usage?.storage_used_bytes)} / {bytes(usage?.storage_limit_bytes)} ({storagePct}%)
                      </span>
                    </div>
                    <div className="h-2 w-full bg-[#050e1b] rounded-full overflow-hidden border border-[#11243e]">
                      <div className="h-full bg-gradient-to-r from-[#0066ff] to-[#00e5ff]" style={{ width: `${storagePct}%` }} />
                    </div>
                  </div>

                  {/* Item 2: Contas Conectadas */}
                  <div>
                    <div className="flex justify-between text-xs font-semibold mb-1">
                      <span className="text-[#8fa2be]">Canais de Redes Sociais Conectados</span>
                      <span className="text-white font-bold">
                        {connected} de {socialLimit} ({percent(connected, socialLimit)}%)
                      </span>
                    </div>
                    <div className="h-2 w-full bg-[#050e1b] rounded-full overflow-hidden border border-[#11243e]">
                      <div className="h-full bg-gradient-to-r from-[#0066ff] to-[#10b981]" style={{ width: `${percent(connected, socialLimit)}%` }} />
                    </div>
                  </div>

                  {/* Item 3: Vagas de Membros */}
                  <div>
                    <div className="flex justify-between text-xs font-semibold mb-1">
                      <span className="text-[#8fa2be]">Pessoas no workspace</span>
                      <span className="text-white font-bold">
                        {seats ? `${seats.used} de ${seats.limit} (${percent(seats.used, seats.limit)}%)` : "—"}
                      </span>
                    </div>
                    <div className="h-2 w-full bg-[#050e1b] rounded-full overflow-hidden border border-[#11243e]">
                      <div className="h-full bg-gradient-to-r from-[#0066ff] to-[#c084fc]" style={{ width: `${seats ? percent(seats.used, seats.limit) : 0}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* COLUNA DIREITA: CARTÃO & FATURAS (5 COLS) */}
            <div className="lg:col-span-5 space-y-6">
              {/* 3. CARTÃO DE CRÉDITO CADASTRADO */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <CreditCard className="h-5 w-5 text-[#00b4d8]" />
                    <h2 className="text-base font-bold text-white">Forma de Pagamento</h2>
                  </div>
                  <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-[#10b981]">
                    Verificado
                  </span>
                </div>

                <div className="mt-4 rounded-xl border border-[#16355d] bg-gradient-to-br from-[#0c2242] to-[#040e1c] p-4 shadow-lg text-xs text-[#8fa2be]">
                  <p className="font-bold text-[#38bdf8] uppercase tracking-wider">Fatura do Asaas</p>
                  <p className="mt-2">
                    Cada cobrança chega como fatura: você paga por Pix, boleto ou cartão na página do Asaas. O Clipo não guarda dados de cartão.
                  </p>
                  {sub?.document_last4 ? <p className="mt-2">CPF/CNPJ final {sub.document_last4}</p> : null}
                </div>
                <div className="mt-4 flex items-center justify-between text-xs text-[#7187a5]">
                  <span>Gateway Seguro Asaas Criptografado</span>
                  <button
                    type="button"
                    onClick={() => (pending?.invoice_url ? window.open(pending.invoice_url, "_blank", "noopener") : showToast("Nenhuma fatura em aberto."))}
                    className="text-[#00e5ff] font-bold hover:underline"
                  >
                    Alterar cartão
                  </button>
                </div>
              </div>

              {/* 4. HISTÓRICO DE FATURAS & NOTAS FISCAIS */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Receipt className="h-5 w-5 text-[#38bdf8]" />
                    <h2 className="text-base font-bold text-white">Faturas & Notas Fiscais</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#5e779d]">NF-e Automática</span>
                </div>

                <div className="mt-4 space-y-2.5">
                  {bill.data && INVOICES.length === 0 && (
                    <p className="rounded-xl border border-dashed border-[#15273f] p-3 text-xs text-[#6e84a3]">Nenhuma fatura ainda.</p>
                  )}
                  {INVOICES.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between rounded-xl border border-[#142845] bg-[#050e1c] p-3 hover:border-[#1c3c66] transition"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold text-white">{inv.number}</p>
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9px] font-bold text-[#10b981] border border-emerald-500/30">
                            {inv.status}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#7187a5] mt-0.5">{inv.period}</p>
                        <p className="text-[10px] text-[#5e779d]">{inv.date}</p>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-white">{inv.amount}</span>
                        <button
                          type="button"
                          onClick={() => (inv.pdfUrl ? window.open(inv.pdfUrl, "_blank", "noopener") : showToast("Esta fatura não tem link."))}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#16355d] bg-[#07162b] text-[#38bdf8] hover:bg-[#0d2342] hover:text-white transition"
                          title="Abrir a fatura"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}


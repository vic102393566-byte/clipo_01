"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Flame,
  Globe,
  HardDrive,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Terminal,
  Trash2,
  Tv,
  Upload,
  Video as VideoIcon,
  Wifi,
  Zap,
} from "lucide-react";
import { useSession } from "@/components/app/session";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { ago } from "@/lib/format";
import { useApi } from "@/lib/use-api";

interface WebhookItem {
  id: string;
  name: string;
  url: string;
  event: string;
  status: "ativo" | "pausado";
  lastTrigger: string;
  successRate: string;
}

type ApiWebhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  last_triggered_at: string | null;
  success_rate: number | null;
  deliveries: number;
};
type Status = {
  services: { id: string; name: string; status: "online" | "offline"; latency_ms?: number | null; seen_at?: string | null }[];
  queue: { queued: number; running: number; failed_24h: number };
};

const EVENT_LABEL: Record<string, string> = {
  "*": "Todos os eventos",
  "publication.published": "Publicação saiu",
  "publication.failed": "Publicação falhou",
  "video.ready": "Vídeo processado",
  "clips.ready": "Cortes prontos",
  "clip.ready": "Corte renderizado",
  "transcript.ready": "Transcrição pronta",
  "subtitles.ready": "Legendas gravadas",
};

function toHook(w: ApiWebhook): WebhookItem {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    event: w.events.map((e) => EVENT_LABEL[e] ?? e).join(", "),
    status: w.active ? "ativo" : "pausado",
    lastTrigger: w.last_triggered_at ? ago(w.last_triggered_at) : "nunca",
    successRate: w.success_rate == null ? "—" : `${w.success_rate.toLocaleString("pt-BR")}%`,
  };
}

export default function RedeConfigPage() {
  const { user } = useSession();
  if (!["admin", "super_admin"].includes(user.role)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#030914] p-6 text-center">
        <div>
          <p className="text-lg font-bold text-white">Área do administrador</p>
          <p className="mt-1 text-sm text-[#8fa2be]">Webhooks e integrações do servidor são configurados pela equipe do Clipo.</p>
          <Link href="/configuracoes" className="mt-4 inline-block rounded-xl border border-[#1a3861] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:text-white">
            Voltar às configurações
          </Link>
        </div>
      </div>
    );
  }
  return <RedeAdmin />;
}

function RedeAdmin() {
  const hooks = useApi<{ items: ApiWebhook[] }>("/api/v1/webhooks");
  const status = useApi<Status>("/api/v1/system/status", { refreshMs: 30000 });
  const webhooks = (hooks.data?.items ?? []).map(toHook);
  const svc = (id: string) => status.data?.services.find((x) => x.id === id);
  const allDeliveries = (hooks.data?.items ?? []).reduce((n, w) => n + w.deliveries, 0);
  const rated = (hooks.data?.items ?? []).filter((w) => w.success_rate != null);
  const avgRate = rated.length ? rated.reduce((n, w) => n + (w.success_rate ?? 0) * w.deliveries, 0) / Math.max(1, allDeliveries) : null;
  const sslEnforce = true;
  const [isTestingNet, setIsTestingNet] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };
  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  const handleTestLatency = async () => {
    setIsTestingNet(true);
    try {
      await status.reload();
      const out = await api<Status>("/api/v1/system/status");
      const off = out.services.filter((x) => x.status !== "online").map((x) => x.name);
      showToast(off.length ? `Fora do ar: ${off.join(", ")}.` : "Todos os serviços respondendo.");
    } catch (err) {
      fail(err, "Não foi possível testar.");
    } finally {
      setIsTestingNet(false);
    }
  };

  const toggleWebhook = async (id: string) => {
    const w = hooks.data?.items.find((x) => x.id === id);
    if (!w) return;
    try {
      await api(`/api/v1/webhooks/${id}`, { method: "PATCH", body: { active: !w.active } });
      await hooks.reload();
      showToast(`Webhook "${w.name}" ${w.active ? "pausado" : "ativo"}.`);
    } catch (err) {
      fail(err, "Não foi possível mudar o webhook.");
    }
  };

  const testWebhook = async (id: string) => {
    try {
      await api(`/api/v1/webhooks/${id}/test`, { method: "POST" });
      showToast("Ping enviado. Veja o resultado em alguns segundos.");
      window.setTimeout(() => void hooks.reload(), 4000);
    } catch (err) {
      fail(err, "Não foi possível testar o webhook.");
    }
  };

  const removeWebhook = async (id: string, name: string) => {
    if (!window.confirm(`Apagar o webhook "${name}"?`)) return;
    try {
      await api(`/api/v1/webhooks/${id}`, { method: "DELETE" });
      await hooks.reload();
    } catch (err) {
      fail(err, "Não foi possível apagar.");
    }
  };

  const addWebhook = async () => {
    const url = window.prompt("URL que vai receber os avisos (https://...):");
    if (!url) return;
    const name = window.prompt("Nome do webhook (ex.: n8n, Zapier):", "Meu webhook") || "Meu webhook";
    try {
      const out = await api<{ secret: string }>("/api/v1/webhooks", {
        method: "POST",
        body: { name, url: url.trim(), events: ["*"] },
      });
      await hooks.reload();
      window.prompt("Guarde o segredo para conferir a assinatura (X-Clipo-Signature). Ele não aparece de novo:", out.secret);
    } catch (err) {
      fail(err, "Não foi possível criar o webhook.");
    }
  };

  return (
    <div className="flex min-h-screen bg-[#030914] text-[#c3d0e5] font-sans antialiased selection:bg-[#0066ff] selection:text-white">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-5 right-6 z-50 flex items-center gap-2.5 rounded-xl border border-[#22487a] bg-[#0c1f38]/95 px-4 py-3 text-sm font-semibold text-white shadow-2xl backdrop-blur-md animate-in fade-in">
          <Sparkles className="h-4 w-4 text-[#00b4d8]" />
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

        {/* Perfil Vinicius Reinehr */}
        <div className="border-t border-[#0f1f35] p-3.5">
          <Link
            href="/plano"
            className="flex items-center justify-between rounded-xl border border-transparent p-2 transition hover:border-[#1c3559] hover:bg-[#08162b]"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-[#23436d] shadow-md">
                <CurrentUserAvatar />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-bold text-white"><CurrentUserName /></p>
                <p className="text-xs font-semibold text-[#3b82f6]"><CurrentPlanName /></p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-[#5e779d]" />
          </Link>
        </div>
      </aside>

      {/* =========================================================================
          ÁREA PRINCIPAL: REDE & INFRAESTRUTURA DE INTERNET
         ========================================================================= */}
      <div className="flex-1 pl-[270px]">
        {/* Header com Breadcrumb, Título & Montanhas */}
        <header className="relative px-8 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar endpoints, webhooks, portas de rede, proxies..."
                className="h-10 w-full rounded-xl border border-[#162942] bg-[#061120] pr-12 pl-10 text-[13px] text-[#cad5e6] placeholder:text-[#587194] focus:border-[#3b82f6] focus:outline-none transition shadow-inner"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-[#1d3557] bg-[#0c1f38] px-1.5 py-0.5 text-[11px] font-semibold text-[#5e779d]">
                ⌘ K
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleTestLatency()}
                className="flex h-10 items-center gap-2 rounded-xl border border-[#162b45] bg-[#07162b] px-3.5 text-xs font-semibold text-[#8fa2be] hover:border-[#3b82f6] hover:text-white transition"
              >
                <Activity className={`h-4 w-4 ${isTestingNet ? "animate-pulse text-[#00e5ff]" : ""}`} />
                <span>Testar Ping & Latência</span>
              </button>

              <button
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[#8fa2be] transition hover:bg-[#08162b] hover:text-white"
                aria-label="Notificações"
              >
                <Bell className="h-5 w-5 text-[#38bdf8]" />
              </button>
            </div>
          </div>

          {/* Banner de Título com Montanhas */}
          <div className="relative mt-4 flex items-center justify-between min-h-[90px] rounded-2xl overflow-hidden px-4">
            <div
              className="absolute inset-y-0 right-36 w-[540px] pointer-events-none"
              style={{
                WebkitMaskImage: "linear-gradient(to right, transparent 0%, rgba(0,0,0,0.8) 35%, black 100%)",
                maskImage: "linear-gradient(to right, transparent 0%, rgba(0,0,0,0.8) 35%, black 100%)",
              }}
            >
              <Image
                src="/dashboard/mountains-glow.png"
                alt=""
                fill
                priority
                className="object-cover object-center"
              />
            </div>

            <div className="relative z-10 py-2 flex items-center gap-4">
              <Link
                href="/configuracoes"
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#19365c] bg-[#081b33] text-[#7187a5] hover:border-[#00a6ff] hover:text-white transition shadow-sm"
                title="Voltar para Configurações"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-[26px] font-extrabold tracking-tight text-white">
                    Rede, Endpoints & Internet
                  </h1>
                  <span className="flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#38bdf8] backdrop-blur-md">
                    <Globe className="h-3.5 w-3.5" />
                    Área do administrador
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-[#7187a5]">
                  Armazenamento, webhooks para n8n/Make e saúde dos serviços do Clipo.
                </p>
              </div>
            </div>

            <div className="relative z-10 flex items-center gap-2.5">
              <Link
                href="/configuracoes"
                className="flex h-10 items-center gap-2 rounded-xl border border-[#1a3861] bg-[#07162b] px-4 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
              >
                <span>Central de Hubs</span>
              </Link>

              <button
                type="button"
                onClick={() => void addWebhook()}
                className="flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-4 text-xs font-bold text-white shadow-[0_0_20px_rgba(0,102,255,0.4)] hover:brightness-110 active:scale-[0.98] transition"
              >
                <Plus className="h-4 w-4" />
                <span>Adicionar Webhook</span>
              </button>
            </div>
          </div>
        </header>

        {/* =========================================================================
            CORPO DA PÁGINA (ESTILO DASHBOARD CLIPO)
           ========================================================================= */}
        <main className="space-y-6 px-8 pt-2 pb-12">
          {/* 1. ROW DE KPIS DE REDE & VAZÃO */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Armazenamento (S3)</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/10 text-[#00e5ff]">
                  <Upload className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">
                {svc("storage")?.latency_ms != null ? `${svc("storage")!.latency_ms} ms` : "—"}
              </p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className={`${svc("storage")?.status === "online" ? "text-emerald-400" : "text-red-400"} font-bold`}>
                  ● {svc("storage")?.status === "online" ? "Respondendo" : "Fora do ar"}
                </span>
                <span className="text-[#5e779d]">tempo de resposta</span>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Webhooks</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/10 text-[#38bdf8]">
                  <Zap className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">{webhooks.filter((w) => w.status === "ativo").length} ativo(s)</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-emerald-400 font-bold">
                  {avgRate == null ? "Sem entregas" : `${avgRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% entregues`}
                </span>
                <span className="text-[#5e779d]">{allDeliveries} envio(s)</span>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Banco de dados</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-[#10b981]">
                  <Globe className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">
                {svc("database")?.latency_ms != null ? `${svc("database")!.latency_ms} ms` : "—"}
              </p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-[#38bdf8]">MongoDB</span>
                <span className={`${svc("database")?.status === "online" ? "text-emerald-400" : "text-red-400"} font-bold`}>
                  {svc("database")?.status === "online" ? "Respondendo" : "Fora do ar"}
                </span>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Segurança dos avisos</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-purple-500/20 bg-purple-500/10 text-[#c084fc]">
                  <Lock className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">HMAC SHA-256</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-emerald-400 font-bold">Webhooks assinados</span>
                <span className="text-[#5e779d]">https em produção</span>
              </div>
            </div>
          </div>

          {/* 2. GRID PRINCIPAL: ENDPOINTS S3 & WEBHOOKS (7 COLS) + MONITOR DE PROXY E REDE (5 COLS) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* COLUNA ESQUERDA: INFRAESTRUTURA DE ENDPOINTS & WEBHOOKS (7 COLUNAS) */}
            <div className="lg:col-span-7 space-y-5">
              {/* Box 1: Configuração do Bucket S3 & CDN */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-[#00e5ff]" />
                    <h2 className="text-sm font-bold text-white">Armazenamento S3 (SeaweedFS Object Store)</h2>
                  </div>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/20">
                    Cluster Ativo
                  </span>
                </div>

                <div className="mt-4 space-y-3 text-xs">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-[#12243d] bg-[#030a17] p-3.5">
                    <div>
                      <p className="font-bold text-white">Endpoint Interno da API S3</p>
                      <p className="text-[11px] font-mono text-[#38bdf8] mt-0.5">http://clipo-platform-s3-1:8333</p>
                    </div>
                    <span className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 shrink-0">
                      Docker Bridge Conectado
                    </span>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-[#12243d] bg-[#030a17] p-3.5">
                    <div>
                      <p className="font-bold text-white">Bucket Principal de Mídia (DAM)</p>
                      <p className="text-[11px] font-mono text-[#a0b8d8] mt-0.5">clipo-dam-storage (Região: us-east-1 compat)</p>
                    </div>
                    <span className="text-[11px] font-bold text-white">{svc("storage")?.status === "online" ? "Online" : "Fora do ar"}</span>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-[#12243d] bg-[#030a17] p-3.5">
                    <div>
                      <p className="font-bold text-white">Forçar Conexão Criptografada SSL/TLS</p>
                      <p className="text-[11px] text-[#7187a5] mt-0.5">
                        Exige certificados HTTPS em todos os uploads e downloads de B-Rolls.
                      </p>
                    </div>
<span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-[#10b981]" title="Em produção o Clipo só aceita webhooks https">
                      Sempre em produção
                    </span>
                  </div>
                </div>
              </div>

              {/* Box 2: Webhooks Ativos para Automações (n8n, Make, Discord) */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-[#38bdf8]" />
                    <h3 className="text-sm font-bold text-white">Webhooks de Automação & Triggers</h3>
                  </div>
                  <span className="text-xs text-[#7187a5]">Assinatura HMAC-SHA256</span>
                </div>

                <div className="mt-3 space-y-3">
                  {hooks.data && webhooks.length === 0 && (
                    <p className="rounded-xl border border-dashed border-[#15273f] p-4 text-xs text-[#6e84a3]">
                      Nenhum webhook. Adicione um para avisar o n8n, Zapier ou seu servidor quando algo acontecer.
                    </p>
                  )}
                  {webhooks.map((wh) => (
                    <div
                      key={wh.id}
                      className="rounded-xl border border-[#12243d] bg-[#030a17] p-3.5 text-xs space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="font-bold text-white truncate">{wh.name}</p>
                          <span className="rounded bg-[#081b33] border border-[#16355d] px-2 py-0.2 text-[10px] font-mono text-[#38bdf8]">
                            {wh.event}
                          </span>
                        </div>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            wh.status === "ativo"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                          }`}
                        >
                          {wh.status}
                        </span>
                      </div>

                      <p className="font-mono text-[11px] text-[#7187a5] truncate">{wh.url}</p>

                      <div className="flex items-center justify-between border-t border-[#0e213b] pt-2 text-[11px] text-[#5e779d]">
                        <span>Último disparo: <strong className="text-[#a0b8d8]">{wh.lastTrigger}</strong></span>
                        <div className="flex items-center gap-2">
                          <span className="text-emerald-400 font-bold">{wh.successRate} entrega</span>
                          <button
                            type="button"
                            onClick={() => void testWebhook(wh.id)}
                            disabled={wh.status !== "ativo"}
                            className="rounded border border-[#162d4a] px-2 py-0.5 text-[#8fa2be] hover:text-white transition disabled:opacity-40"
                          >
                            Testar
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleWebhook(wh.id)}
                            className="rounded border border-[#162d4a] px-2 py-0.5 text-[#8fa2be] hover:text-white transition"
                          >
                            {wh.status === "ativo" ? "Pausar" : "Ativar"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeWebhook(wh.id, wh.name)}
                            className="rounded border border-red-500/30 px-2 py-0.5 text-red-400 hover:bg-red-500/10 transition"
                          >
                            Apagar
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* COLUNA DIREITA: PROXY RESIDENCIAL BR & STATUS DE REDE (5 COLUNAS) */}
            <div className="lg:col-span-5 space-y-5">
              {/* Box 1: Serviços do Clipo */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-[#00e5ff]" />
                    <h3 className="text-sm font-bold text-white">Serviços do Clipo</h3>
                  </div>
                  <span className="text-[11px] font-bold text-[#7187a5]">
                    Fila: {status.data?.queue.queued ?? 0} • rodando {status.data?.queue.running ?? 0}
                  </span>
                </div>
                <div className="mt-3 space-y-2 text-xs">
                  {(status.data?.services ?? []).map((x) => (
                    <div key={x.id} className="flex items-center justify-between rounded-lg border border-[#0d1e33] bg-[#020712] p-2">
                      <span className="text-white">{x.name}</span>
                      <span className={x.status === "online" ? "text-emerald-400" : "text-red-400"}>
                        {x.status === "online" ? (x.latency_ms != null ? `${x.latency_ms} ms` : "online") : "fora do ar"}
                      </span>
                    </div>
                  ))}
                  <p className="pt-1 text-[11px] text-[#5e779d]">
                    Proxy residencial para as redes foi removido: publicar por IP de terceiros arrisca bloqueio da conta.
                  </p>
                </div>
              </div>

              {/* Box 2: Monitor de Sockets & Conexões Ativas */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-[#38bdf8]" />
                    <h3 className="text-sm font-bold text-white">Sockets & Portas Mapeadas</h3>
                  </div>
                  <span className="text-[10px] text-emerald-400 font-mono">127.0.0.1 bridge</span>
                </div>

                <div className="mt-3 space-y-2 text-xs font-mono">
                  <div className="flex items-center justify-between rounded-lg border border-[#0d1e33] bg-[#020712] p-2">
                    <span className="text-white">Web Frontend (Next.js)</span>
                    <span className="text-[#38bdf8]">:3200</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-[#0d1e33] bg-[#020712] p-2">
                    <span className="text-white">Core API (FastAPI)</span>
                    <span className="text-[#38bdf8]">:8000</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-[#0d1e33] bg-[#020712] p-2">
                    <span className="text-white">SeaweedFS S3 Storage</span>
                    <span className="text-[#38bdf8]">:8333</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-[#0d1e33] bg-[#020712] p-2">
                    <span className="text-white">Mailpit SMTP & Web</span>
                    <span className="text-[#38bdf8]">:8025</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}


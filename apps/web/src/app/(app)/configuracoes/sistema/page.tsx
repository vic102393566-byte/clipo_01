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
  Flame,
  Globe,
  HardDrive,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Play,
  Power,
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
  Video as VideoIcon,
  Zap,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import type { SettingsAll } from "@/lib/studio";
import type { Usage } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { JOB_LABEL } from "@/lib/use-job";

interface ServiceStatus {
  name: string;
  role: string;
  port: string;
  status: "online" | "warning" | "offline";
  uptime: string;
  load: string;
}

type Status = {
  services: { id: string; name: string; status: "online" | "offline"; latency_ms?: number | null; seen_at?: string | null; subtitles?: boolean }[];
  queue: { queued: number; running: number; failed_24h: number };
};
type JobRow = { id: string; type: string; status: string; message: string; error: string | null; updated_at: string };

const RESOLUTIONS: Record<string, { max_height: 0 | 720 | 1080 | 1440 | 2160; fps: 0 | 24 | 30 | 60 }> = {
  "Original • fps original": { max_height: 0, fps: 0 },
  "1080p (1080 x 1920) • 60fps": { max_height: 1080, fps: 60 },
  "1080p (1080 x 1920) • 30fps": { max_height: 1080, fps: 30 },
  "720p (720 x 1280) • 30fps": { max_height: 720, fps: 30 },
  "4K (2160 x 3840) • fps original": { max_height: 2160, fps: 0 },
};
const QUALITY: Record<string, "small" | "balanced" | "high"> = {
  "Alta qualidade (arquivo maior)": "high",
  "Equilibrado (padrão)": "balanced",
  "Arquivo leve (envio mais rápido)": "small",
};
const SOON = "Em breve";

export default function SistemaConfigPage() {
  const settings = useApi<SettingsAll>("/api/v1/settings");
  const status = useApi<Status>("/api/v1/system/status", { refreshMs: 30000 });
  const jobs = useApi<{ items: JobRow[] }>("/api/v1/jobs?active=false&limit=8");
  const usage = useApi<{ usage: Usage }>("/api/v1/usage");
  const canEdit = settings.data?.can_edit_workspace ?? false;
  const exp = (settings.data?.workspace.render as unknown as { export?: { max_height: number; fps: number; quality: string } })?.export;
  const resolutionMaster =
    Object.entries(RESOLUTIONS).find(([, v]) => v.max_height === (exp?.max_height ?? 0) && v.fps === (exp?.fps ?? 0))?.[0] ?? "Original • fps original";
  const bitrateMode = Object.entries(QUALITY).find(([, v]) => v === (exp?.quality ?? "balanced"))?.[0] ?? "Equilibrado (padrão)";
  const nightQueueProcessing = settings.data?.workspace.render.night_queue ?? false;
  const hdrRec2020 = false;
  const svc = (id: string) => status.data?.services.find((x) => x.id === id);
  const SERVICES: ServiceStatus[] = (status.data?.services ?? []).map((x) => ({
    name: x.name,
    role: x.id === "worker" ? (x.seen_at ? `visto ${ago(x.seen_at)}` : "sem sinal") : x.id === "ffmpeg" ? (x.subtitles ? "com libass (legendas)" : "sem libass") : "serviço",
    port: x.id,
    status: x.status === "online" ? "online" : "offline",
    uptime: x.status === "online" ? "online" : "fora do ar",
    load: x.latency_ms != null ? `${x.latency_ms} ms` : "",
  }));
  const LOG_ENTRIES = (jobs.data?.items ?? []).map((j) => ({
    time: new Date(j.updated_at).toLocaleTimeString("pt-BR"),
    level: j.status === "done" ? "SUCCESS" : j.status === "failed" ? "ERROR" : j.status === "cancelled" ? "SYSTEM" : "INFO",
    msg: `${JOB_LABEL[j.type] ?? j.type}: ${j.error ?? j.message}`,
  }));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };
  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  const saveRender = async (render: Record<string, unknown>, message: string) => {
    try {
      await api("/api/v1/settings/workspace", { method: "PATCH", body: { render } });
      await settings.reload();
      showToast(message);
    } catch (err) {
      fail(err, "Não foi possível salvar.");
    }
  };

  const handleClearCache = async () => {
    try {
      const out = await api<{ aborted_uploads: number; freed_bytes: number }>("/api/v1/system/cleanup", { method: "POST" });
      await usage.reload();
      showToast(out.aborted_uploads ? `${out.aborted_uploads} envio(s) parado(s) cancelado(s), ${bytes(out.freed_bytes)} liberados.` : "Nada para limpar: nenhum envio parado há mais de 24 h.");
    } catch (err) {
      fail(err, "Não foi possível limpar.");
    }
  };

  const handleRefreshCluster = async () => {
    setIsRefreshing(true);
    await Promise.all([status.reload(), jobs.reload(), usage.reload()]);
    setIsRefreshing(false);
    showToast("Status atualizado.");
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
          ÁREA PRINCIPAL: SISTEMA NO DESIGN SYSTEM AUTÊNTICO DO CLIPO
         ========================================================================= */}
      <div className="flex-1 pl-[270px]">
        {/* HEADER: Busca, Notificações, Banner de Montanhas & Ações */}
        <header className="relative px-8 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar recursos do sistema, portas, workers, logs..."
                className="h-10 w-full rounded-xl border border-[#162942] bg-[#061120] pr-12 pl-10 text-[13px] text-[#cad5e6] placeholder:text-[#587194] focus:border-[#3b82f6] focus:outline-none transition shadow-inner"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-[#1d3557] bg-[#0c1f38] px-1.5 py-0.5 text-[11px] font-semibold text-[#5e779d]">
                ⌘ K
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleRefreshCluster}
                className="flex h-10 items-center gap-2 rounded-xl border border-[#162b45] bg-[#07162b] px-3.5 text-xs font-semibold text-[#8fa2be] hover:border-[#3b82f6] hover:text-white transition"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin text-[#00e5ff]" : ""}`} />
                <span>Atualizar Métricas</span>
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
                    Sistema & Performance
                  </h1>
                  <span className="flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#38bdf8] backdrop-blur-md">
                    <Cpu className="h-3.5 w-3.5" />
                    GPU Metal 16 Cores Ativa
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-[#7187a5]">
                  Cluster de renderização FFmpeg, workers de processamento em segundo plano e DAM SeaweedFS.
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
                onClick={() => void handleRefreshCluster()}
                className="flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-4 text-xs font-bold text-white shadow-[0_0_20px_rgba(0,102,255,0.4)] hover:brightness-110 active:scale-[0.98] transition"
              >
                <Zap className="h-4 w-4" />
                <span>Otimizar Cluster</span>
              </button>
            </div>
          </div>
        </header>

        {/* =========================================================================
            CORPO DA PÁGINA (ESTILO DASHBOARD CLIPO)
           ========================================================================= */}
        <main className="space-y-6 px-8 pt-2 pb-12">
          {/* 1. ROW DE KPIS DO SISTEMA (PADRÃO RESULTADOS & DASHBOARD) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: Eficiência GPU */}
            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Worker</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/10 text-[#00e5ff]">
                  <Cpu className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">{svc("worker")?.status === "online" ? "Online" : "Parado"}</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className={`${svc("worker")?.status === "online" ? "text-emerald-400" : "text-red-400"} font-bold`}>● FFmpeg (CPU)</span>
                <span className="text-[#5e779d]">{svc("worker")?.seen_at ? ago(svc("worker")!.seen_at!) : "sem sinal"}</span>
              </div>
            </div>

            {/* Card 2: Workers & Fila */}
            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Fila de jobs</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/10 text-[#38bdf8]">
                  <Server className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">{status.data?.queue.running ?? 0} rodando</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className={`${status.data?.queue.failed_24h ? "text-red-400" : "text-emerald-400"} font-bold`}>{status.data?.queue.failed_24h ?? 0} falha(s) em 24 h</span>
                <span className="text-[#5e779d]">{status.data?.queue.queued ?? 0} na fila</span>
              </div>
            </div>

            {/* Card 3: SeaweedFS S3 DAM */}
            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Armazenamento S3</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10 text-[#00e5ff]">
                  <HardDrive className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">{bytes(usage.data?.usage.storage_used_bytes)}</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-[#38bdf8]">de {bytes(usage.data?.usage.storage_limit_bytes)} do plano</span>
                <span className="text-emerald-400 font-bold">
                  {bytes(Math.max(0, (usage.data?.usage.storage_limit_bytes ?? 0) - (usage.data?.usage.storage_used_bytes ?? 0)))} livres
                </span>
              </div>
            </div>

            {/* Card 4: Velocidade de Renderização */}
            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Exportação dos cortes</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-purple-500/20 bg-purple-500/10 text-[#c084fc]">
                  <Flame className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">{exp?.max_height ? `${exp.max_height}p` : "Original"}</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-emerald-400 font-bold">{bitrateMode}</span>
                <span className="text-[#5e779d]">{exp?.fps ? `${exp.fps} fps` : "fps original"}</span>
              </div>
            </div>
          </div>

          {/* 2. GRID PRINCIPAL: PIPELINE DE VÍDEO & MONITOR DE CONTAINERS DOCKER */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* COLUNA ESQUERDA: PARÂMETROS DO MOTOR DE RENDERIZAÇÃO (7 COLUNAS) */}
            <div className="lg:col-span-7 space-y-5">
              {/* Box 1: Configuração do Pipeline de Vídeo 4K */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Tv className="h-4 w-4 text-[#00e5ff]" />
                    <h2 className="text-sm font-bold text-white">Exportação dos cortes</h2>
                  </div>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/20">
                    Otimizado para Shorts
                  </span>
                </div>

                <div className="mt-4 space-y-3.5 text-xs">
                  {/* Resolução */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-[#12243d] bg-[#030a17] p-3.5">
                    <div>
                      <p className="font-bold text-white">Resolução de Saída</p>
                      <p className="text-[11px] text-[#7187a5] mt-0.5">
                        Proporção 9:16 vertical renderizada pixel-a-pixel.
                      </p>
                    </div>
                    <Select
                      value={resolutionMaster}
                      disabled={!canEdit}
                      onChange={(e) => void saveRender({ export: { ...RESOLUTIONS[e.target.value], quality: QUALITY[bitrateMode] } }, "Resolução de exportação salva.")}
                      className="h-9 rounded-xl border border-[#1b3d6a] bg-[#07162b] px-3 text-xs font-semibold text-white focus:outline-none cursor-pointer"
                    >
                      {Object.keys(RESOLUTIONS).map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {/* Bitrate */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-[#12243d] bg-[#030a17] p-3.5">
                    <div>
                      <p className="font-bold text-white">Taxa de Bits & Codec</p>
                      <p className="text-[11px] text-[#7187a5] mt-0.5">
                        HEVC (H.265) via GPU hardware encoder.
                      </p>
                    </div>
                    <Select
                      value={bitrateMode}
                      disabled={!canEdit}
                      onChange={(e) => void saveRender({ export: { ...RESOLUTIONS[resolutionMaster], quality: QUALITY[e.target.value] } }, "Qualidade de exportação salva.")}
                      className="h-9 rounded-xl border border-[#1b3d6a] bg-[#07162b] px-3 text-xs font-semibold text-white focus:outline-none cursor-pointer"
                    >
                      {Object.keys(QUALITY).map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {/* HDR Rec.2020 */}
                  <div className="flex items-center justify-between rounded-xl border border-[#12243d] bg-[#030a17] p-3.5">
                    <div>
                      <p className="font-bold text-white">Espaço de Cores HDR (Rec.2020 10-bit)</p>
                      <p className="text-[11px] text-[#7187a5] mt-0.5">
                        Preserva contraste e saturação neon em telas OLED.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled
                      title={SOON}
                      className={`relative h-6 w-11 rounded-full transition cursor-pointer p-0.5 ${
                        hdrRec2020 ? "bg-[#0066ff] shadow-[0_0_10px_rgba(0,102,255,0.4)]" : "bg-[#182c47]"
                      }`}
                    >
                      <span
                        className={`block h-5 w-5 rounded-full bg-white shadow-md transition-transform ${
                          hdrRec2020 ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Fila Noturna Contínua */}
                  <div className="flex items-center justify-between rounded-xl border border-[#12243d] bg-[#030a17] p-3.5">
                    <div>
                      <p className="font-bold text-white">Fila da madrugada</p>
                      <p className="text-[11px] text-[#7187a5] mt-0.5">
                        Cortes pedidos de dia esperam até 1 h para renderizar (o processamento já continua com a aba fechada).
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!canEdit}
                      aria-pressed={nightQueueProcessing}
                      onClick={() => void saveRender({ night_queue: !nightQueueProcessing }, nightQueueProcessing ? "Fila da madrugada desligada." : "Fila da madrugada ligada.")}
                      className={`relative h-6 w-11 rounded-full transition cursor-pointer p-0.5 ${
                        nightQueueProcessing ? "bg-[#0066ff] shadow-[0_0_10px_rgba(0,102,255,0.4)]" : "bg-[#182c47]"
                      }`}
                    >
                      <span
                        className={`block h-5 w-5 rounded-full bg-white shadow-md transition-transform ${
                          nightQueueProcessing ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              {/* Box 2: Gerenciador de Armazenamento & Limpeza de Cache */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-[#38bdf8]" />
                    <h3 className="text-sm font-bold text-white">Gestão de Cache & Armazenamento</h3>
                  </div>
                  <span className="text-xs font-semibold text-[#7187a5]">
                    Bucket: <strong className="text-white">clipo-dam-storage</strong>
                  </span>
                </div>

                <div className="mt-4 space-y-4">
                  {/* Barra de Progresso */}
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="font-semibold text-white">SeaweedFS S3 Storage DAM</span>
                      <span className="font-bold text-[#38bdf8]">14,8 GB / 100 GB (14,8%)</span>
                    </div>
                    <div className="h-2.5 w-full rounded-full bg-[#030914] border border-[#132845] overflow-hidden p-0.5">
                      <div className="h-full rounded-full bg-gradient-to-r from-[#0066ff] via-[#00a6ff] to-[#00e5ff] shadow-[0_0_8px_#00a6ff] w-[14.8%]" />
                    </div>
                  </div>

                  {/* Ação de Limpeza de Cache */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[#12243d] bg-[#030a17] p-3.5 text-xs">
                    <div>
                      <p className="font-bold text-white">Cache de Pré-visualização & Frames Temporários</p>
                      <p className="text-[11px] text-[#7187a5] mt-0.5">
                        Cancela envios parados há mais de 24 h e apaga as partes que ficaram no armazenamento.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleClearCache}
                      className="flex items-center gap-1.5 rounded-xl border border-[#1e416e] bg-[#0c2240] px-4 py-2 font-bold text-[#38bdf8] hover:border-[#00a6ff] hover:bg-[#102c52] transition disabled:opacity-50 shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Limpar envios parados</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* COLUNA DIREITA: STATUS DOS CONTAINERS & SERVIÇOS DO CLUSTER (5 COLUNAS) */}
            <div className="lg:col-span-5 space-y-5">
              {/* Painel de Serviços Docker */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-[#10b981]" />
                    <h3 className="text-sm font-bold text-white">Serviços do Cluster Docker</h3>
                  </div>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#10b981]" />
                    5/5 Online
                  </span>
                </div>

                <div className="mt-3 divide-y divide-[#0c1c33]">
                  {SERVICES.map((srv, idx) => (
                    <div key={idx} className="flex items-center justify-between py-2.5 text-xs">
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-2">
                          <p className="font-bold text-white truncate">{srv.name}</p>
                          <span className="rounded bg-[#0c1f38] px-1.5 py-0.2 text-[10px] text-[#7187a5] font-mono">
                            :{srv.port}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#5e779d]">{srv.role}</p>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-[11px] font-bold text-emerald-400">
                          {srv.uptime}
                        </span>
                        <p className="text-[10px] text-[#7187a5]">{srv.load}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 rounded-xl border border-[#142944] bg-[#040c18] p-2.5 text-center text-xs">
                  <span className="text-[#7187a5]">Composição do Ambiente: </span>
                  <strong className="text-white">Docker Compose v2.29 (macOS ARM64)</strong>
                </div>
              </div>

              {/* Painel de Logs do Motor de Vídeo */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-[#00e5ff]" />
                    <h3 className="text-sm font-bold text-white">Live Engine Log</h3>
                  </div>
                  <span className="text-[10px] text-[#5e779d] font-mono">stdout • live</span>
                </div>

                <div className="mt-3 space-y-2 font-mono text-[11px]">
                  {LOG_ENTRIES.map((log, i) => (
                    <div key={i} className="rounded-lg border border-[#0d1e33] bg-[#020712] p-2">
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className="text-[#5e779d]">{log.time}</span>
                        <span
                          className={`font-bold ${
                            log.level === "SUCCESS"
                              ? "text-emerald-400"
                              : log.level === "INFO"
                              ? "text-[#38bdf8]"
                              : "text-purple-400"
                          }`}
                        >
                          [{log.level}]
                        </span>
                      </div>
                      <p className="mt-1 text-[#a2bad8] text-[10px] leading-relaxed break-all">
                        {log.msg}
                      </p>
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

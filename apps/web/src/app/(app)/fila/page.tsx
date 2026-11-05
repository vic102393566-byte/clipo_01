"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Clock,
  ExternalLink,
  Flame,
  LayoutDashboard,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  TrendingUp,
  Video as VideoIcon,
  X as CloseIcon,
  Zap,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { PublishDialog, type PublishSource } from "@/components/app/publish-dialog";
import { api, ApiError } from "@/lib/api";
import { bytes } from "@/lib/format";
import { countdown, mmss, POST_TYPE, type SettingsAll, whenLabel } from "@/lib/studio";
import type { Connection, PublicationRow, Video } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface QueueItem {
  id: string;
  title: string;
  caption: string;
  scheduledTime: string;
  countdown: string;
  duration: string;
  resolution: string;
  size: string;
  thumbnail: string;
  status: "scheduled" | "processing" | "paused" | "failed";
  platforms: Array<{
    name: "tiktok" | "instagram" | "youtube" | "linkedin" | "x";
    account: string;
    type: string;
  }>;
}

const STATUS: Partial<Record<PublicationRow["status"], QueueItem["status"]>> = {
  scheduled: "scheduled",
  paused: "paused",
  publishing: "processing",
  failed: "failed",
  partial: "failed",
};

function toQueueItem(p: PublicationRow): QueueItem {
  return {
    id: p.id,
    title: p.title,
    caption: p.targets[0]?.description || "Sem legenda.",
    scheduledTime: whenLabel(p.scheduled_at),
    countdown: p.status === "scheduled" ? countdown(p.scheduled_at) : p.status === "paused" ? "pausada" : "",
    duration: mmss(p.duration_s),
    resolution: p.width && p.height ? `${p.width}x${p.height}` : "—",
    size: bytes(p.size_bytes),
    thumbnail: p.thumbnail_url ?? "",
    status: STATUS[p.status] ?? "scheduled",
    platforms: p.targets.map((t) => ({
      name: t.platform,
      account: t.account ?? "conta não conectada",
      type: POST_TYPE[t.platform] ?? "Vídeo",
    })),
  };
}

const DAY = 86400000;

type FilterTab = "all" | "today" | "tomorrow" | "paused";

export default function QueuePage() {
  const [isVideosOpen, setIsVideosOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  // Janela da fila: falhas dos últimos 7 dias e tudo o que está agendado até 86 dias à frente.
  const [clock] = useState(() => {
    const now = Date.now();
    return {
      now,
      startOfDay: new Date(new Date(now).setHours(0, 0, 0, 0)).getTime(),
      range: `from=${new Date(now - 7 * DAY).toISOString()}&to=${new Date(now + 86 * DAY).toISOString()}`,
      upToNow: new Date(now + 60000).toISOString(),
    };
  });
  const range = clock.range;
  const queue = useApi<{ items: PublicationRow[] }>(
    `/api/v1/publications?${range}&status=scheduled&status=paused&status=publishing&status=failed&status=partial`,
    { refreshMs: 15000 },
  );
  const month = useApi<{ items: PublicationRow[] }>(
    `/api/v1/publications?${range.split("&")[0]}&to=${encodeURIComponent(clock.upToNow)}&status=published&status=partial&status=failed`,
  );
  const conns = useApi<{ items: Connection[] }>("/api/v1/connections");
  const settings = useApi<SettingsAll>("/api/v1/settings");
  const isAutomationActive = settings.data?.workspace.automation.enabled ?? true;
  const rows = useMemo(() => queue.data?.items ?? [], [queue.data]);
  const queueState = useMemo(() => rows.map(toQueueItem), [rows]);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [pickId, setPickId] = useState("");
  const [publishSource, setPublishSource] = useState<PublishSource | null>(null);
  const videos = useApi<{ items: Video[] }>(scheduleModalOpen ? "/api/v1/videos?status=ready&limit=100" : null);
  const readyVideos = videos.data?.items ?? [];
  const [filterPlatform, setFilterPlatform] = useState<string>("all");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  const handlePublishNow = async (id: string, title: string) => {
    setBusy(id);
    try {
      await api(`/api/v1/publications/${id}/publish-now`, { method: "POST" });
      await queue.reload();
      showToast(`Enviando "${title}" para as redes.`);
    } catch (err) {
      fail(err, "Não foi possível publicar agora.");
    } finally {
      setBusy(null);
    }
  };

  const handleTogglePause = async (id: string) => {
    const item = queueState.find((i) => i.id === id);
    if (!item) return;
    setBusy(id);
    try {
      await api(`/api/v1/publications/${id}/${item.status === "paused" ? "resume" : "pause"}`, { method: "POST" });
      await queue.reload();
      showToast(item.status === "paused" ? "Publicação de volta na fila." : "Publicação pausada.");
    } catch (err) {
      fail(err, "Não foi possível mudar a publicação.");
    } finally {
      setBusy(null);
    }
  };

  const toggleAutomation = async () => {
    try {
      await api("/api/v1/settings/workspace", {
        method: "PATCH",
        body: { automation: { enabled: !isAutomationActive } },
      });
      await settings.reload();
      showToast(isAutomationActive ? "Fila pausada: nada sai até você religar." : "Fila automática religada.");
    } catch (err) {
      fail(err, "Não foi possível mudar a automação.");
    }
  };

  // Resumo dos cartões
  const nowMs = clock.now;
  const startOfDay = clock.startOfDay;
  const nextUp = rows.find((r) => r.status === "scheduled" && r.scheduled_at && new Date(r.scheduled_at).getTime() >= nowMs - 60000);
  const scheduledOn = (offset: number) =>
    rows.filter((r) => {
      if (!r.scheduled_at || !["scheduled", "paused"].includes(r.status)) return false;
      const t = new Date(r.scheduled_at).getTime();
      return t >= startOfDay + offset * DAY && t < startOfDay + (offset + 1) * DAY;
    }).length;
  const done = month.data?.items ?? [];
  const okCount = done.filter((p) => p.status !== "failed").length;
  const successRate = done.length ? (okCount / done.length) * 100 : null;
  const connected = (conns.data?.items ?? []).filter((c) => c.connected);
  const needsReconnect = connected.filter((c) => c.status === "needs_reconnect").length;

  const filteredQueue = useMemo(() => {
    return queueState.filter((item) => {
      if (activeTab === "today" && !item.scheduledTime.startsWith("Hoje")) return false;
      if (activeTab === "tomorrow" && !item.scheduledTime.startsWith("Amanhã")) return false;
      if (activeTab === "paused" && item.status !== "paused") return false;

      if (filterPlatform !== "all") {
        if (!item.platforms.some((p) => p.name === filterPlatform)) return false;
      }

      return true;
    });
  }, [queueState, activeTab, filterPlatform]);

  return (
    <div className="min-h-screen w-full bg-[#030914] text-[#d6e2f0] antialiased select-none font-sans">
      {/* =========================================================================
          SIDEBAR FIXA À ESQUERDA (270px) - ATIVA EM FILA DE PUBLICAÇÃO
         ========================================================================= */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-[270px] flex-col justify-between border-r border-[#0f1f35] bg-[#040d1a]">
        <div>
          {/* Topo da Sidebar: Logo Clipo e Botão de Recolher */}
          <div className="flex h-16 items-center justify-between px-5">
            <Link href="/dashboard" className="flex items-center gap-3">
              <div className="relative flex h-9 w-9 items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-blue-500/20 blur-md" />
                <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-tr from-[#0052ff] via-[#00a3ff] to-[#00f0ff] shadow-md shadow-blue-500/30">
                  <span className="text-base font-extrabold text-white">C</span>
                </div>
              </div>
              <span className="text-xl font-bold tracking-tight text-white">clipo</span>
            </Link>

            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[#5a7499] hover:bg-[#09182d] hover:text-white transition"
              aria-label="Recolher menu"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
          </div>

          {/* Botão Início */}
          <div className="px-4 pt-1">
            <Link
              href="/dashboard"
              className="group flex h-10 w-full items-center gap-3 rounded-xl px-3 font-medium text-[#c9d5e8] transition hover:bg-[#08162b] hover:text-white"
            >
              <LayoutDashboard className="h-4 w-4 text-[#7187a5]" />
              <span className="text-[13.5px]">Início</span>
            </Link>
          </div>

          {/* Menus e Categorias da Navegação */}
          <nav className="mt-4 space-y-4 px-4 text-xs font-medium">
            {/* SEÇÃO CONTEÚDO */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Conteúdo</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>

              {/* Item Accordion: Vídeos */}
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => setIsVideosOpen((prev) => !prev)}
                  aria-expanded={isVideosOpen}
                  className="flex w-full items-center justify-between rounded-xl border border-[#173868] bg-[#0c2242]/80 px-3 py-2 text-sm font-semibold text-white transition cursor-pointer shadow-[0_0_15px_rgba(12,34,66,0.5)]"
                >
                  <div className="flex items-center gap-2.5">
                    <VideoIcon className="h-4 w-4 text-[#3b82f6]" />
                    <span>Vídeos</span>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 text-[#7187a5] transition-transform duration-200 ${
                      isVideosOpen ? "rotate-0" : "-rotate-90"
                    }`}
                  />
                </button>

                {/* Sub-árvore de Vídeos */}
                <div
                  className={`grid transition-all duration-200 ease-in-out ${
                    isVideosOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="relative ml-4 pl-4 pt-2 pb-1 before:absolute before:top-2.5 before:bottom-2.5 before:left-[3px] before:w-px before:bg-[#1d4273]">
                      <ul className="space-y-2.5 text-[13px]">
                        <li className="relative flex items-center text-[#8fa2be] hover:text-white transition">
                          <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6]/70 shadow-[0_0_6px_#3b82f6]" />
                          <Link href="/videos" className="py-0.5">
                            Meus vídeos
                          </Link>
                        </li>
                        {/* Fila de publicação (ITEM ATIVO COM GLOW) */}
                        <li className="relative flex items-center text-white font-semibold">
                          <span className="absolute -left-[18px] h-2.5 w-2.5 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_10px_#3b82f6]" />
                          <Link href="/fila" className="py-0.5 text-[#60a5fa]">
                            Fila de publicação
                          </Link>
                        </li>
                        <li className="relative flex items-center text-[#8fa2be] hover:text-white transition">
                          <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6]/70 shadow-[0_0_6px_#3b82f6]" />
                          <Link href="/biblioteca" className="py-0.5">
                            Biblioteca
                          </Link>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
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
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[#c9d5e8] hover:bg-[#08162b] hover:text-white transition"
              >
                <Calendar className="h-4 w-4 text-[#7187a5]" />
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
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[#c9d5e8] hover:bg-[#08162b] hover:text-white transition"
              >
                <TrendingUp className="h-4 w-4 text-[#7187a5]" />
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
              <div className="relative ml-4 pl-4 pt-1 pb-1 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-[#193356]">
                <ul className="space-y-2.5 text-[13px]">
                  <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                    <Link href="/ideias" className="cursor-pointer py-0.5">Ideias de conteúdo</Link>
                  </li>
                  <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                    <Link href="/roteiros" className="cursor-pointer py-0.5">Roteiros</Link>
                  </li>
                  <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                    <Link href="/modelos" className="cursor-pointer py-0.5">Modelos</Link>
                  </li>
                </ul>
              </div>
            </div>

            {/* Item Configurações */}
            <div className="pt-1">
              <Link
                href="/configuracoes"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[#c9d5e8] hover:bg-[#08162b] hover:text-white transition"
              >
                <Settings className="h-4 w-4 text-[#7187a5]" />
                <span>Configurações</span>
              </Link>
            </div>
          </nav>
        </div>

        {/* Rodapé da Sidebar: Perfil Vinicius Reinehr */}
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
          ÁREA PRINCIPAL (MAIN CONTENT)
         ========================================================================= */}
      <div className="flex-1 pl-[270px]">
        {/* HEADER: Busca Superior, Notificações, Título, Banner e Ações */}
        <header className="relative px-8 pt-5 pb-3">
          {/* Linha 1: Input de Busca e Notificações */}
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar na fila de postagens, canais, tags..."
                className="h-10 w-full rounded-xl border border-[#162942] bg-[#061120] pr-12 pl-10 text-[13px] text-[#cad5e6] placeholder:text-[#587194] focus:border-[#3b82f6] focus:outline-none transition shadow-inner"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-[#1d3557] bg-[#0c1f38] px-1.5 py-0.5 text-[11px] font-semibold text-[#5e779d]">
                ⌘ K
              </span>
            </div>

            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[#8fa2be] transition hover:bg-[#08162b] hover:text-white"
              aria-label="Notificações"
            >
              <Bell className="h-5 w-5" />
            </button>
          </div>

          {/* Linha 2: Banner de Título com Montanhas ao Fundo e Controles de Automação */}
          <div className="relative mt-4 flex items-center justify-between min-h-[90px] rounded-2xl overflow-hidden px-4">
            {/* Montanhas com fade out lateral suave */}
            <div
              className="absolute inset-y-0 right-32 w-[540px] pointer-events-none"
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

            {/* Título e Subtítulo */}
            <div className="relative z-10 py-2">
              <div className="flex items-center gap-3">
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">
                  Fila de publicação
                </h1>
                {/* Badge Automação Ativa */}
                <div
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold backdrop-blur-md border ${
                    isAutomationActive
                      ? "border-[#065f46] bg-[#064e3b]/40 text-[#10b981]"
                      : "border-[#78350f] bg-[#451a03]/40 text-[#f59e0b]"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isAutomationActive ? "bg-[#10b981] animate-pulse" : "bg-[#f59e0b]"
                    }`}
                  />
                  <span>{isAutomationActive ? "Fila Automática Ativa" : "Fila Pausada"}</span>
                </div>
              </div>
              <p className="mt-1 text-sm font-medium text-[#8fa2be]">
                Acompanhe os próximos disparos automáticos, status das filas e conectores sociais.
              </p>
            </div>

            {/* Ações no Banner */}
            <div className="relative z-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => void toggleAutomation()}
                className="flex h-11 items-center gap-2 rounded-xl border border-[#1b3456] bg-[#08182d] px-4 font-semibold text-[#c0d0e6] transition hover:border-[#2b5182] hover:bg-[#0c233f]"
              >
                {isAutomationActive ? (
                  <>
                    <Pause className="h-4 w-4 text-[#f59e0b]" />
                    <span className="text-xs">Pausar fila</span>
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 text-[#10b981]" />
                    <span className="text-xs">Retomar fila</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => setScheduleModalOpen(true)}
                className="flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0d5cf5] via-[#1668f8] to-[#1e74ff] px-4 font-semibold text-white shadow-[0_0_20px_rgba(13,92,245,0.45)] transition hover:brightness-110 active:scale-95"
              >
                <Plus className="h-4 w-4" />
                <span className="text-sm">Agendar publicação</span>
              </button>
            </div>
          </div>
        </header>

        {/* CORPO PRINCIPAL */}
        <main className="px-8 pb-10 space-y-6">
          {/* =====================================================================
              LINHA 1: 4 CARDS DE STATUS E KPIs DA FILA
             ===================================================================== */}
          <div className="grid grid-cols-4 gap-4">
            {/* Card 1: Próximo Disparo */}
            <div className="relative overflow-hidden rounded-2xl border border-[#163866] bg-gradient-to-br from-[#061830] via-[#05111f] to-[#040e1c] p-4.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
              <div className="flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/20 text-[#3b82f6] border border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.3)]">
                  <Zap className="h-5 w-5 text-[#3b82f6]" />
                </div>
                <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-bold text-[#60a5fa]">
                  {nextUp ? whenLabel(nextUp.scheduled_at) : "Nada agendado"}
                </span>
              </div>
              <div className="mt-3">
                <p className="text-xs font-semibold text-[#8fa2be]">Próximo disparo</p>
                <p className="mt-0.5 text-xl font-extrabold text-white">
                  {nextUp ? countdown(nextUp.scheduled_at) : "—"}
                </p>
                <p className="mt-1 truncate text-[11px] text-[#4ea5ff]">
                  {nextUp ? nextUp.title : isAutomationActive ? "Agende um corte para começar" : "Fila pausada"}
                </p>
              </div>
            </div>

            {/* Card 2: Na fila agora */}
            <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-4.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
              <div className="flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6]">
                  <Clock className="h-5 w-5 text-[#3b82f6]" />
                </div>
                <span className="text-xs font-bold text-[#10b981] flex items-center gap-1">
                  <span>{rows.filter((r) => r.status === "paused").length}</span>
                  <span className="font-normal text-[#546e8f]">pausada(s)</span>
                </span>
              </div>
              <div className="mt-3">
                <p className="text-xs font-semibold text-[#8fa2be]">Na fila hoje</p>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-2xl font-black text-white">{scheduledOn(0)}</span>
                  <span className="text-xs text-[#8fa2be]">publicações</span>
                </div>
                <p className="mt-1 text-[11px] text-[#5e779d]">{scheduledOn(1)} agendada(s) para amanhã</p>
              </div>
            </div>

            {/* Card 3: Taxa de Entrega / Saúde dos Disparos */}
            <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-4.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
              <div className="flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#065f46] bg-[#064e3b]/20 text-[#10b981]">
                  <CheckCircle2 className="h-5 w-5 text-[#10b981]" />
                </div>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-[#10b981]">
                  {done.length - okCount ? `${done.length - okCount} falha(s)` : "Sem falhas"}
                </span>
              </div>
              <div className="mt-3">
                <p className="text-xs font-semibold text-[#8fa2be]">Taxa de sucesso</p>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-2xl font-black text-white">
                    {successRate == null ? "—" : `${successRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}
                  </span>
                  <span className="text-xs text-[#8fa2be]">últimos 7 dias</span>
                </div>
                <p className="mt-1 text-[11px] text-[#5e779d]">{okCount} publicação(ões) sem falha</p>
              </div>
            </div>

            {/* Card 4: Conectores Sociais Ativos */}
            <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-4.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[#8fa2be]">Conectores de API</p>
                <span className="h-2 w-2 rounded-full bg-[#10b981] shadow-[0_0_6px_#10b981]" />
              </div>
              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-black text-xs font-bold text-white border border-[#23354c]">
                    t
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-xs font-bold text-white">
                    i
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#ff0000] text-xs font-bold text-white">
                    y
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0077b5] text-xs font-bold text-white">
                    in
                  </span>
                </div>
                <Link
                  href="/contas"
                  className="text-xs font-semibold text-[#3b82f6] hover:underline flex items-center gap-0.5"
                >
                  <span>Gerenciar</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <p className="text-[11px] text-[#5e779d] pt-1">
                {connected.length === 0
                  ? "Nenhuma rede conectada"
                  : needsReconnect
                    ? `${needsReconnect} rede(s) para reconectar`
                    : `${connected.length} rede(s) conectada(s) e em dia`}
              </p>
            </div>
          </div>

          {/* =====================================================================
              BARRA DE FILTROS & SELETOR DE REDES SOCIAIS
             ===================================================================== */}
          <div className="flex items-center justify-between border-b border-[#102035] pb-3">
            {/* Tabs de Filtro */}
            <div className="flex items-center gap-6">
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className={`relative pb-3 text-sm font-semibold transition ${
                  activeTab === "all" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <span>Todos na fila</span>
                <span className="ml-2 rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {queueState.length}
                </span>
                {activeTab === "all" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("today")}
                className={`relative pb-3 text-sm font-semibold transition ${
                  activeTab === "today" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <span>Hoje</span>
                <span className="ml-2 rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {scheduledOn(0)}
                </span>
                {activeTab === "today" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("tomorrow")}
                className={`relative pb-3 text-sm font-semibold transition ${
                  activeTab === "tomorrow" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <span>Amanhã</span>
                <span className="ml-2 rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {scheduledOn(1)}
                </span>
                {activeTab === "tomorrow" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("paused")}
                className={`relative pb-3 text-sm font-semibold transition ${
                  activeTab === "paused" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <span>Pausados</span>
                {activeTab === "paused" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>
            </div>

            {/* Chips de Plataforma */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#5e779d] mr-1">Filtrar por canal:</span>
              <button
                type="button"
                onClick={() => setFilterPlatform("all")}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  filterPlatform === "all"
                    ? "bg-[#0d62f7] text-white shadow-sm"
                    : "border border-[#152a45] bg-[#07172b] text-[#8fa2be] hover:text-white"
                }`}
              >
                Todos
              </button>
              <button
                type="button"
                onClick={() => setFilterPlatform("tiktok")}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  filterPlatform === "tiktok"
                    ? "bg-black border border-white/40 text-white"
                    : "border border-[#152a45] bg-[#07172b] text-[#8fa2be] hover:text-white"
                }`}
              >
                TikTok
              </button>
              <button
                type="button"
                onClick={() => setFilterPlatform("instagram")}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  filterPlatform === "instagram"
                    ? "bg-pink-600 text-white"
                    : "border border-[#152a45] bg-[#07172b] text-[#8fa2be] hover:text-white"
                }`}
              >
                Instagram
              </button>
              <button
                type="button"
                onClick={() => setFilterPlatform("youtube")}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  filterPlatform === "youtube"
                    ? "bg-red-600 text-white"
                    : "border border-[#152a45] bg-[#07172b] text-[#8fa2be] hover:text-white"
                }`}
              >
                YouTube
              </button>
              <button
                type="button"
                onClick={() => setFilterPlatform("linkedin")}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  filterPlatform === "linkedin"
                    ? "bg-sky-600 text-white"
                    : "border border-[#152a45] bg-[#07172b] text-[#8fa2be] hover:text-white"
                }`}
              >
                LinkedIn
              </button>
            </div>
          </div>

          {/* =====================================================================
              LISTAGEM DA FILA DE PUBLICAÇÃO (TIMELINE DE DISPAROS)
             ===================================================================== */}
          <div className="space-y-4">
            {filteredQueue.map((item, idx) => {
              const isFirst = idx === 0 && item.status === "scheduled";

              return (
                <div
                  key={item.id}
                  className={`group relative rounded-2xl border transition p-5 shadow-[0_8px_30px_rgba(0,0,0,0.4)] ${
                    isFirst
                      ? "border-[#1d4ed8]/60 bg-gradient-to-r from-[#07172c] via-[#051120] to-[#051120] shadow-[0_0_30px_rgba(29,78,216,0.15)]"
                      : "border-[#11233a] bg-[#05111f] hover:border-[#1a385f]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-5">
                    {/* LADO ESQUERDO: Miniatura + Duração + Info do Horário */}
                    <div className="flex items-start gap-4 min-w-0">
                      {/* Thumbnail com aspecto 16:9 widescreen */}
                      <div className="relative aspect-[16/9] w-48 shrink-0 overflow-hidden rounded-xl border border-[#162e4d] bg-[#020712] shadow-md">
                        {item.thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada
                          <img
                            src={item.thumbnail}
                            alt=""
                            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        ) : (
                          <VideoIcon className="absolute inset-0 m-auto h-8 w-8 text-[#1d3557]" aria-hidden />
                        )}
                        <span className="absolute bottom-2 right-2 rounded bg-black/85 px-1.5 py-0.5 text-[11px] font-bold text-white tracking-wide backdrop-blur-md">
                          {item.duration}
                        </span>
                        {isFirst && (
                          <span className="absolute top-2 left-2 rounded-md bg-[#2563eb] px-2 py-0.5 text-[10px] font-extrabold text-white tracking-wider shadow-[0_0_8px_#2563eb]">
                            PRÓXIMO
                          </span>
                        )}
                      </div>

                      {/* Informações Centrais do Item */}
                      <div className="min-w-0 flex-1">
                        {/* Linha do Horário Programado & Contagem Regressiva */}
                        <div className="flex items-center gap-3">
                          <span className="flex items-center gap-1.5 text-xs font-bold text-[#60a5fa]">
                            <Clock className="h-3.5 w-3.5 text-[#3b82f6]" />
                            <span>{item.scheduledTime}</span>
                          </span>
                          <span className="h-1 w-1 rounded-full bg-[#374e6d]" />
                          <span className="text-xs font-semibold text-[#10b981]">
                            {item.countdown}
                          </span>
                          <span className="h-1 w-1 rounded-full bg-[#374e6d]" />
                          <span className="text-xs text-[#6e87a8]">
                            {item.resolution} • {item.size}
                          </span>
                        </div>

                        {/* Título do Vídeo */}
                        <h3 className="mt-1.5 text-base font-bold text-white leading-snug group-hover:text-[#60a5fa] transition">
                          {item.title}
                        </h3>

                        {/* Copy / Legenda de Preview */}
                        <p className="mt-1.5 line-clamp-2 text-xs text-[#7e96b8] leading-relaxed">
                          {item.caption}
                        </p>

                        {/* Canais Conectados para este Disparo */}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-semibold text-[#546e8f]">Destinos:</span>
                          {item.platforms.map((plat) => (
                            <div
                              key={plat.name}
                              className="flex items-center gap-1.5 rounded-lg border border-[#142944] bg-[#071629] px-2.5 py-1 text-[11px] text-[#c9d5e8]"
                            >
                              {plat.name === "tiktok" && (
                                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-black text-[9px] font-bold text-white">
                                  t
                                </span>
                              )}
                              {plat.name === "instagram" && (
                                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[#e1306c] text-[9px] font-bold text-white">
                                  i
                                </span>
                              )}
                              {plat.name === "youtube" && (
                                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[#ff0000] text-[9px] font-bold text-white">
                                  y
                                </span>
                              )}
                              {plat.name === "x" && (
                                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-black text-[9px] font-bold text-white">
                                  𝕏
                                </span>
                              )}
                              {plat.name === "linkedin" && (
                                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[#0077b5] text-[9px] font-bold text-white">
                                  in
                                </span>
                              )}
                              <span className="font-semibold">{plat.type}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* LADO DIREITO: Status e Botões de Ação Imediata */}
                    <div className="flex flex-col items-end gap-3 shrink-0">
                      {/* Badge de Status */}
                      {item.status === "scheduled" && (
                        <span className="flex items-center gap-1.5 rounded-full border border-[#1e3a5f] bg-[#0d223a] px-3 py-1 text-xs font-semibold text-[#8fa2be]">
                          <Clock className="h-3.5 w-3.5 text-[#3b82f6]" />
                          <span>Na fila automática</span>
                        </span>
                      )}

                      {item.status === "paused" && (
                        <span className="flex items-center gap-1.5 rounded-full border border-[#78350f] bg-[#451a03]/40 px-3 py-1 text-xs font-semibold text-[#f59e0b]">
                          <Pause className="h-3.5 w-3.5 text-[#f59e0b]" />
                          <span>Pausado</span>
                        </span>
                      )}

                      {/* Botões de Ação */}
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => void handleTogglePause(item.id)}
                          disabled={busy === item.id || item.status === "processing" || item.status === "failed"}
                          className="flex h-9 items-center gap-1.5 rounded-xl border border-[#152a45] bg-[#07172b] px-3 text-xs font-semibold text-[#8fa2be] hover:border-[#2b5182] hover:text-white transition"
                        >
                          {item.status === "paused" ? (
                            <>
                              <Play className="h-3.5 w-3.5 text-[#10b981]" />
                              <span>Retomar</span>
                            </>
                          ) : (
                            <>
                              <Pause className="h-3.5 w-3.5 text-[#f59e0b]" />
                              <span>Pausar</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => void handlePublishNow(item.id, item.title)}
                          disabled={busy === item.id || item.status === "processing"}
                          className="flex h-9 items-center gap-1.5 rounded-xl bg-[#0d5cf5] px-3.5 text-xs font-semibold text-white shadow-[0_0_12px_rgba(13,92,245,0.4)] hover:brightness-110 active:scale-95 transition"
                        >
                          <Send className="h-3.5 w-3.5" />
                          <span>Publicar agora</span>
                        </button>

                        <button
                          type="button"
                          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#152a45] bg-[#07172b] text-[#546e8f] hover:text-white transition"
                          aria-label="Mais opções"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Dica de Automação & Best Practices no Rodapé */}
          <div className="rounded-2xl border border-[#153459] bg-gradient-to-r from-[#071c35] to-[#05111f] p-5 shadow-lg flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0d5cf5]/20 text-[#3b82f6] border border-[#0d5cf5]/30">
                <Sparkles className="h-6 w-6 text-[#3b82f6]" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-white">Como a fila funciona</h4>
                <p className="text-xs text-[#8fa2be] mt-0.5">
                  Cada publicação sai no minuto marcado, pela API oficial de cada rede. Pausada, ela espera até você retomar; com a fila pausada, nada sai.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab("all")}
              className="inline-flex items-center gap-2 rounded-xl border border-[#1f4270] bg-[#0c2444] px-4 py-2 text-xs font-semibold text-[#60a5fa] hover:border-[#3b82f6] hover:text-white transition shrink-0 cursor-pointer"
            >
              <span>Ver fila completa</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </main>
      </div>

      {/* TOAST FLUTUANTE */}
      {toastMessage && (
        <div className="fixed bottom-6 right-8 z-50 flex items-center gap-2.5 rounded-xl border border-[#1d4ed8] bg-[#091b33] px-4 py-3 text-xs font-semibold text-white shadow-2xl animate-fade-in">
          <Check className="h-4 w-4 text-[#10b981]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* MODAL DE AGENDAR PUBLICAÇÃO */}
      {scheduleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[#19355b] bg-[#05111f] p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-[#0f223a]">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/20 text-[#3b82f6]">
                  <Clock className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Agendar nova publicação</h3>
                  <p className="text-xs text-[#6e87a8]">Escolha o vídeo, horário e canais de disparo</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setScheduleModalOpen(false)}
                className="rounded-lg p-1.5 text-[#546e8f] hover:bg-[#0c1f38] hover:text-white"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <label className="text-xs font-semibold text-[#8fa2be] block">
                Selecione o vídeo:
                <Select
                  value={pickId}
                  onChange={(e) => setPickId(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-xl border border-[#152a45] bg-[#030914] px-3 text-xs text-white focus:border-[#3b82f6] focus:outline-none"
                >
                  <option value="">{readyVideos.length ? "Escolha um vídeo pronto" : "Nenhum vídeo pronto ainda"}</option>
                  {readyVideos.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="text-[11px] text-[#5e779d]">
                No próximo passo você escolhe as redes, o texto (com ajuda da IA) e o horário.
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setScheduleModalOpen(false)}
                className="rounded-xl border border-[#162c47] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#09182d] hover:text-white transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={!pickId}
                onClick={() => {
                  const v = readyVideos.find((x) => x.id === pickId);
                  if (!v) return;
                  setScheduleModalOpen(false);
                  setPublishSource({ kind: "video", id: v.id, title: v.title, duration_s: v.duration_s ?? 0 });
                }}
                className="rounded-xl bg-[#0d5cf5] px-5 py-2 text-xs font-semibold text-white shadow-[0_0_15px_rgba(13,92,245,0.4)] hover:brightness-110 transition disabled:opacity-50"
              >
                Continuar
              </button>
            </div>
          </div>
        </div>
      )}

      <PublishDialog
        source={publishSource}
        open={publishSource !== null}
        onClose={() => {
          setPublishSource(null);
          void queue.reload();
        }}
      />
    </div>
  );
}


"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Calendar as CalendarIcon,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Eye,
  Filter,
  Flame,
  Grid3X3,
  LayoutDashboard,
  ListFilter,
  MoreHorizontal,
  Plus,
  Radio,
  Search,
  Send,
  Settings,
  Sparkles,
  TrendingUp,
  Video as VideoIcon,
  X as CloseIcon,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { PublishDialog, type PublishSource } from "@/components/app/publish-dialog";
import { api, ApiError } from "@/lib/api";
import { mmss } from "@/lib/studio";
import type { PublicationRow, Video } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface ScheduledPost {
  id: string;
  day: number; // dia do mês (1 a 30)
  time: string;
  title: string;
  thumbnail: string;
  duration: string;
  status: "published" | "scheduled" | "draft";
  platforms: Array<"tiktok" | "instagram" | "youtube" | "linkedin" | "x">;
}

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function toPost(p: PublicationRow): ScheduledPost & { dateKey: string; dateLabel: string; raw: PublicationRow } {
  const when = new Date(p.published_at ?? p.scheduled_at ?? p.created_at);
  const published = p.status === "published" || p.status === "partial";
  return {
    id: p.id,
    day: when.getDate(),
    time: when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    title: p.title,
    thumbnail: p.thumbnail_url ?? "",
    duration: mmss(p.duration_s),
    status: published ? "published" : p.status === "draft" || p.status === "paused" ? "draft" : "scheduled",
    platforms: p.targets.map((t) => t.platform),
    dateKey: keyOf(when),
    dateLabel: `${when.getDate()} de ${MONTHS[when.getMonth()].toLowerCase()} às ${when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`,
    raw: p,
  };
}

const WEEKDAYS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const WEEKDAYS_SHORT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

export default function CalendarioPage() {
  const [isVideosOpen, setIsVideosOpen] = useState(false);
  // Mês mostrado (primeiro dia) e "hoje" fixados na montagem.
  const [today] = useState(() => keyOf(new Date()));
  const [monthStart, setMonthStart] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const selectedMonth = `${MONTHS[monthStart.getMonth()]} de ${monthStart.getFullYear()}`;
  const shiftMonth = (delta: number) =>
    setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const [viewMode, setViewMode] = useState<"month" | "week">("month");
  const [filterPlatform, setFilterPlatform] = useState<string>("all");
  const [selectedPost, setSelectedPost] = useState<ReturnType<typeof toPost> | null>(null);
  const [newScheduleModalOpen, setNewScheduleModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Grade do mês: semanas começando na segunda, com os dias vizinhos para fechar as linhas.
  const calendarDays = useMemo(() => {
    const first = monthStart;
    const lead = (first.getDay() + 6) % 7;
    const total = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = Math.ceil((lead + total) / 7) * 7;
    return Array.from({ length: cells }, (_, i) => {
      const d = new Date(first.getFullYear(), first.getMonth(), i - lead + 1);
      return {
        dayNumber: d.getDate(),
        isCurrentMonth: d.getMonth() === first.getMonth(),
        isToday: keyOf(d) === today,
        dateKey: keyOf(d),
      };
    });
  }, [monthStart, today]);

  const gridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - ((monthStart.getDay() + 6) % 7));
  const gridEnd = new Date(gridStart.getTime() + calendarDays.length * 86400000);
  const pubs = useApi<{ items: PublicationRow[] }>(
    `/api/v1/publications?from=${encodeURIComponent(gridStart.toISOString())}&to=${encodeURIComponent(gridEnd.toISOString())}&status=draft&status=scheduled&status=paused&status=publishing&status=published&status=partial`,
  );
  const posts = useMemo(() => (pubs.data?.items ?? []).map(toPost), [pubs.data]);
  const inMonth = posts.filter((p) => p.dateKey.startsWith(keyOf(monthStart).slice(0, 7)));
  const totals = {
    published: inMonth.filter((p) => p.status === "published").length,
    scheduled: inMonth.filter((p) => p.status === "scheduled").length,
    draft: inMonth.filter((p) => p.status === "draft").length,
  };
  const [pickId, setPickId] = useState("");
  const [publishSource, setPublishSource] = useState<PublishSource | null>(null);
  const videos = useApi<{ items: Video[] }>(newScheduleModalOpen ? "/api/v1/videos?status=ready&limit=100" : null);
  const readyVideos = videos.data?.items ?? [];

  const unschedule = async (id: string) => {
    try {
      await api(`/api/v1/publications/${id}/unschedule`, { method: "POST" });
      await pubs.reload();
      setSelectedPost(null);
      showToast("Agendamento desfeito: a publicação voltou para rascunho.");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Não foi possível desfazer o agendamento.");
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#030914] text-[#d6e2f0] antialiased select-none font-sans">
      {/* =========================================================================
          SIDEBAR FIXA À ESQUERDA (270px) - ATIVA EM CALENDÁRIO
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
                  className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold text-[#c9d5e8] hover:bg-[#08162b] hover:text-white transition cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <VideoIcon className="h-4 w-4 text-[#7187a5]" />
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
                        <li className="relative flex items-center text-[#8fa2be] hover:text-white transition">
                          <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6]/70 shadow-[0_0_6px_#3b82f6]" />
                          <Link href="/fila" className="py-0.5">
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

            {/* SEÇÃO PLANEJAMENTO - CALENDÁRIO ATIVO */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Planejamento</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>

              {/* Botão Calendário Ativo com borda e glow */}
              <Link
                href="/calendario"
                className="flex items-center gap-2.5 rounded-xl border border-[#173868] bg-[#0c2242]/80 px-3 py-2 text-sm font-semibold text-white transition shadow-[0_0_15px_rgba(12,34,66,0.5)]"
              >
                <CalendarIcon className="h-4 w-4 text-[#3b82f6]" />
                <span>Calendário</span>
                <span className="ml-auto h-2 w-2 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
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
              <div className="relative ml-4 pl-4 pt-1 pb-1 before:absolute before:top-2.5 before:bottom-2.5 before:left-[3px] before:w-px before:bg-[#193356]">
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
        {/* HEADER: Busca, Notificações, Título, Banner e Ações */}
        <header className="relative px-8 pt-5 pb-3">
          {/* Linha 1: Input de Busca e Notificações */}
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar no calendário editorial por títulos, datas, canais..."
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

          {/* Linha 2: Banner de Título com Montanhas e Controles de Mês */}
          <div className="relative mt-4 flex items-center justify-between min-h-[90px] rounded-2xl overflow-hidden px-4">
            {/* Montanhas azuis com fade out lateral suave */}
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
                  Calendário Editorial
                </h1>
                <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#60a5fa] backdrop-blur-md">
                  {totals.scheduled} agendada(s) no mês
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-[#8fa2be]">
                Planeje e visualize a grade mensal de publicações em todos os canais sociais conectados.
              </p>
            </div>

            {/* Controles de Navegação de Mês & Botão Agendar */}
            <div className="relative z-10 flex items-center gap-3">
              {/* Seletor Mês / Ano */}
              <div className="flex items-center gap-1 rounded-xl border border-[#162c47] bg-[#071629] p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => shiftMonth(-1)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-[#8fa2be] hover:bg-[#0f2542] hover:text-white transition"
                  aria-label="Mês anterior"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="px-3 text-xs font-bold text-white tracking-wide">
                  {selectedMonth}
                </span>
                <button
                  type="button"
                  onClick={() => shiftMonth(1)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-[#8fa2be] hover:bg-[#0f2542] hover:text-white transition"
                  aria-label="Próximo mês"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              {/* Botão Hoje */}
              <button
                type="button"
                onClick={() => {
                  const d = new Date();
                  setMonthStart(new Date(d.getFullYear(), d.getMonth(), 1));
                }}
                className="h-10 rounded-xl border border-[#162c47] bg-[#071629] px-3.5 text-xs font-semibold text-[#60a5fa] hover:border-[#2563eb] hover:text-white transition"
              >
                Hoje
              </button>

              {/* Botão Primário: Agendar */}
              <button
                type="button"
                onClick={() => setNewScheduleModalOpen(true)}
                className="flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0d5cf5] via-[#1668f8] to-[#1e74ff] px-4 font-semibold text-white shadow-[0_0_20px_rgba(13,92,245,0.45)] transition hover:brightness-110 active:scale-95 cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span className="text-sm">Novo Agendamento</span>
              </button>
            </div>
          </div>
        </header>

        {/* CORPO PRINCIPAL */}
        <main className="px-8 pb-10 space-y-5">
          {/* BARRA DE FILTROS & INDICADORES DE REDES SOCIAIS */}
          <div className="flex items-center justify-between border-b border-[#102035] pb-3">
            {/* Chips de Status */}
            <div className="flex items-center gap-4 text-xs font-medium">
              <span className="flex items-center gap-1.5 text-white">
                <span className="h-2.5 w-2.5 rounded-full bg-[#10b981] shadow-[0_0_6px_#10b981]" />
                <span className="font-semibold">{totals.published} Publicados</span>
              </span>
              <span className="h-1 w-1 rounded-full bg-[#374e6d]" />
              <span className="flex items-center gap-1.5 text-white">
                <span className="h-2.5 w-2.5 rounded-full bg-[#3b82f6] shadow-[0_0_6px_#3b82f6]" />
                <span className="font-semibold">{totals.scheduled} Na fila</span>
              </span>
              <span className="h-1 w-1 rounded-full bg-[#374e6d]" />
              <span className="flex items-center gap-1.5 text-white">
                <span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b] shadow-[0_0_6px_#f59e0b]" />
                <span className="font-semibold">{totals.draft} Rascunho(s)</span>
              </span>
            </div>

            {/* Filtros por Plataforma */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#5e779d] mr-1">Filtrar calendário:</span>
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
              GRADE MENSAL DO CALENDÁRIO (7 COLUNAS X 5 SEMANAS)
             ===================================================================== */}
          <div className="rounded-2xl border border-[#11233a] bg-[#05111f] overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
            {/* Cabeçalho dos Dias da Semana */}
            <div className="grid grid-cols-7 border-b border-[#0d1e33] bg-[#040e1c] text-center text-xs font-bold text-[#6e87a8] py-3">
              {WEEKDAYS.map((wd, i) => (
                <div key={wd} className="flex items-center justify-center gap-1">
                  <span>{wd}</span>
                  <span className="hidden sm:inline text-[#354f73] font-normal">
                    ({WEEKDAYS_SHORT[i]})
                  </span>
                </div>
              ))}
            </div>

            {/* Células dos Dias */}
            <div className="grid grid-cols-7 divide-x divide-y divide-[#0d1e33] min-h-[620px]">
              {calendarDays.map((cell, idx) => {
                const postsOnThisDay = posts.filter((p) => {
                  if (p.dateKey !== cell.dateKey) return false;
                  if (filterPlatform !== "all" && !(p.platforms as string[]).includes(filterPlatform)) {
                    return false;
                  }
                  return true;
                });

                return (
                  <div
                    key={cell.dateKey}
                    className={`min-h-[124px] p-2 flex flex-col justify-between transition group relative ${
                      cell.isCurrentMonth
                        ? "bg-[#05111f] hover:bg-[#07172c]/50"
                        : "bg-[#030a14]/60 text-[#3b4d66]"
                    }`}
                  >
                    {/* Topo da Célula: Número do Dia + Indicador de Hoje */}
                    <div className="flex items-center justify-between">
                      {cell.isToday ? (
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-[#2563eb] to-[#38bdf8] text-xs font-extrabold text-white shadow-[0_0_10px_#2563eb]">
                          {cell.dayNumber}
                        </div>
                      ) : (
                        <span
                          className={`text-xs font-bold ${
                            cell.isCurrentMonth ? "text-[#8fa2be] group-hover:text-white" : "text-[#3b4d66]"
                          }`}
                        >
                          {cell.dayNumber}
                        </span>
                      )}

                      {/* Botão + rápido ao passar o mouse */}
                      {cell.isCurrentMonth && (
                        <button
                          type="button"
                          onClick={() => setNewScheduleModalOpen(true)}
                          className="opacity-0 group-hover:opacity-100 flex h-5 w-5 items-center justify-center rounded bg-[#0b213d] text-[#60a5fa] hover:bg-[#1d4ed8] hover:text-white transition cursor-pointer"
                          title="Agendar neste dia"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    {/* Lista de Postagens no Dia */}
                    <div className="mt-1 space-y-1.5 flex-1 overflow-y-auto max-h-[85px] no-scrollbar">
                      {postsOnThisDay.map((post) => (
                        <div
                          key={post.id}
                          onClick={() => setSelectedPost(post)}
                          className={`flex items-center justify-between rounded-lg p-1.5 border transition cursor-pointer text-left ${
                            post.status === "published"
                              ? "border-[#065f46]/50 bg-[#064e3b]/20 hover:border-[#10b981]"
                              : post.status === "scheduled"
                              ? "border-[#1d4ed8]/50 bg-[#0d2a52]/40 hover:border-[#38bdf8]"
                              : "border-[#78350f]/50 bg-[#451a03]/30 hover:border-[#f59e0b]"
                          }`}
                        >
                          <div className="min-w-0 flex items-center gap-1.5">
                            {/* Bolinha com cor do status */}
                            <span
                              className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                post.status === "published"
                                  ? "bg-[#10b981]"
                                  : post.status === "scheduled"
                                  ? "bg-[#38bdf8] shadow-[0_0_4px_#38bdf8]"
                                  : "bg-[#f59e0b]"
                              }`}
                            />
                            <span className="font-mono text-[10px] font-bold text-white shrink-0">
                              {post.time}
                            </span>
                            <span className="truncate text-[10.5px] font-semibold text-[#c9d5e8]">
                              {post.title}
                            </span>
                          </div>

                          {/* Ícone da primeira rede social */}
                          <div className="flex items-center gap-0.5 ml-1 shrink-0">
                            {post.platforms.includes("tiktok") && (
                              <span className="h-3 w-3 rounded-xs bg-black text-[8px] font-bold text-white flex items-center justify-center">
                                t
                              </span>
                            )}
                            {post.platforms.includes("instagram") && (
                              <span className="h-3 w-3 rounded-xs bg-[#e1306c] text-[8px] font-bold text-white flex items-center justify-center">
                                i
                              </span>
                            )}
                            {post.platforms.includes("youtube") && (
                              <span className="h-3 w-3 rounded-xs bg-[#ff0000] text-[8px] font-bold text-white flex items-center justify-center">
                                y
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      {/* MODAL DE DETALHES DO AGENDAMENTO SELECIONADO */}
      {selectedPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-[#19355b] bg-[#05111f] p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-[#0f223a]">
              <div className="flex items-center gap-2">
                <CalendarIcon className="h-4 w-4 text-[#3b82f6]" />
                <h3 className="text-sm font-bold text-white">Detalhes da Publicação</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPost(null)}
                className="rounded-lg p-1 text-[#546e8f] hover:bg-[#0c1f38] hover:text-white cursor-pointer"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4">
              {/* Thumbnail */}
              <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-[#162e4d] bg-black">
                {selectedPost.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada
                  <img src={selectedPost.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : null}
                <span className="absolute bottom-2 right-2 rounded bg-black/85 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {selectedPost.duration}
                </span>
              </div>

              {/* Título & Horário */}
              <h4 className="mt-3 text-base font-bold text-white leading-snug">
                {selectedPost.title}
              </h4>
              <p className="mt-1 text-xs text-[#60a5fa] font-semibold flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                <span>
                  {selectedPost.dateLabel}
                </span>
              </p>

              {/* Status */}
              <div className="mt-3 flex items-center justify-between py-2 border-y border-[#0d1e33]">
                <span className="text-xs text-[#6e87a8]">Status:</span>
                {selectedPost.status === "published" && (
                  <span className="rounded-full bg-[#064e3b]/40 border border-[#065f46] px-2.5 py-0.5 text-xs font-bold text-[#10b981]">
                    Publicado com Sucesso
                  </span>
                )}
                {selectedPost.status === "scheduled" && (
                  <span className="rounded-full bg-[#0d223a] border border-[#1e3a5f] px-2.5 py-0.5 text-xs font-bold text-[#60a5fa]">
                    Agendado na Fila
                  </span>
                )}
                {selectedPost.status === "draft" && (
                  <span className="rounded-full bg-[#451a03]/40 border border-[#78350f] px-2.5 py-0.5 text-xs font-bold text-[#f59e0b]">
                    Rascunho
                  </span>
                )}
              </div>

              {/* Redes Sociais */}
              <div className="mt-3">
                <span className="text-xs text-[#6e87a8] block mb-1.5">Canais de publicação:</span>
                <div className="flex items-center gap-2">
                  {selectedPost.platforms.map((p) => (
                    <span
                      key={p}
                      className="rounded-lg border border-[#142944] bg-[#071629] px-2.5 py-1 text-xs font-semibold text-white capitalize"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>

              {/* Botões */}
              <div className="mt-6 flex items-center justify-between gap-3">
                {selectedPost.raw.status === "scheduled" ? (
                  <button
                    type="button"
                    onClick={() => void unschedule(selectedPost.id)}
                    className="rounded-xl border border-red-500/30 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/10 transition cursor-pointer"
                  >
                    Cancelar Agendamento
                  </button>
                ) : (
                  <span />
                )}
                <Link
                  href={`/publicacoes/${selectedPost.id}`}
                  className="rounded-xl bg-[#0d5cf5] px-4 py-2 text-xs font-semibold text-white shadow-md hover:brightness-110 transition cursor-pointer"
                >
                  {selectedPost.status === "published" ? "Ver publicação" : "Editar Horário"}
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE NOVO AGENDAMENTO */}
      {newScheduleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[#19355b] bg-[#05111f] p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-[#0f223a]">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/20 text-[#3b82f6]">
                  <CalendarIcon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Novo Agendamento</h3>
                  <p className="text-xs text-[#6e87a8]">Selecione o corte e a data no calendário</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNewScheduleModalOpen(false)}
                className="rounded-lg p-1.5 text-[#546e8f] hover:bg-[#0c1f38] hover:text-white cursor-pointer"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <label className="text-xs font-semibold text-[#8fa2be] block">
                Vídeo para agendar:
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
              <p className="text-[11px] text-[#5e779d]">No próximo passo você escolhe as redes, o texto e o horário.</p>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setNewScheduleModalOpen(false)}
                className="rounded-xl border border-[#162c47] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#09182d] hover:text-white transition cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={!pickId}
                onClick={() => {
                  const v = readyVideos.find((x) => x.id === pickId);
                  if (!v) return;
                  setNewScheduleModalOpen(false);
                  setPublishSource({ kind: "video", id: v.id, title: v.title, duration_s: v.duration_s ?? 0 });
                }}
                className="rounded-xl bg-[#0d5cf5] px-5 py-2 text-xs font-semibold text-white shadow-[0_0_15px_rgba(13,92,245,0.4)] hover:brightness-110 transition cursor-pointer disabled:opacity-50"
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
          void pubs.reload();
        }}
      />
    </div>
  );
}


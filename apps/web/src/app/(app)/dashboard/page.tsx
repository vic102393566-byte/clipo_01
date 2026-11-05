"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Bell,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Flame,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  Radio,
  Search,
  Settings,
  Sparkles,
  TrendingUp,
  Video,
} from "lucide-react";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import type { User } from "@/lib/api";
import { compact, type Kpi, whenLabel } from "@/lib/studio";
import type { Connection, PublicationRow } from "@/lib/types";
import { useApi } from "@/lib/use-api";

type Dash = {
  platform_series: { days: string[]; series: Record<string, number[]>; totals: Record<string, { views: number; delta_pct: number | null }> };
  stats: { videos: number; clips: number; scheduled: number; published_30d: number; views_7d: Kpi; followers_7d: Kpi };
  views_daily: { day: string; views: number }[];
  simulated: boolean;
  upcoming: (PublicationRow & { thumbnail_url: string })[];
  channels: (Connection & { followers: number | null; delta_7d: number | null })[];
};

const NETS = [
  { id: "tiktok", color: "#ff2d75", area: "url(#area-pink)", glow: "url(#glow-pink)" },
  { id: "instagram", color: "#a855f7", area: "url(#area-purple)", glow: "url(#glow-purple)" },
  { id: "youtube", color: "#f97316", area: "url(#area-orange)", glow: "url(#glow-orange)" },
  { id: "linkedin", color: "#06b6d4", area: "url(#area-cyan)", glow: "url(#glow-cyan)" },
] as const;
const MONTH_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const WEEK_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function linePath(values: number[], max: number, w = 680, h = 200): string {
  if (!values.length) return "";
  const step = w / Math.max(1, values.length - 1);
  return values.map((v, i) => `${i ? "L" : "M"} ${Math.round(i * step)} ${Math.round(h - (v / max) * (h - 12))}`).join(" ");
}

function arrow(delta: number | null | undefined): string {
  if (delta == null) return "—";
  return `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function NetDots({ platforms }: { platforms: string[] }) {
  return (
    <div className="mt-1 flex items-center gap-1.5">
      {platforms.includes("tiktok") && (
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-black text-[9px] font-bold text-white">t</span>
      )}
      {platforms.includes("instagram") && (
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[#e1306c] text-[9px] font-bold text-white">i</span>
      )}
      {platforms.includes("youtube") && (
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[#ff0000] text-[9px] font-bold text-white">y</span>
      )}
    </div>
  );
}

export default function DashboardPage() {
  // Controle de expansão do submenu de Vídeos
  const [isVideosOpen, setIsVideosOpen] = useState(false);
  const { data } = useApi<Dash>("/api/v1/dashboard", { refreshMs: 60000 });
  const me = useApi<{ user: User }>("/api/me");
  const [now] = useState(() => new Date());
  const greeting = now.getHours() < 12 ? "Bom dia" : now.getHours() < 18 ? "Boa tarde" : "Boa noite";
  const firstName = me.data?.user.name.split(" ")[0] ?? "";
  const ps = data?.platform_series;
  const chartMax = Math.max(10, ...Object.values(ps?.series ?? {}).flat()) * 1.1;
  const yLabels = [5, 4, 3, 2, 1, 0].map((i) => (i === 0 ? "0" : compact((chartMax * i) / 5)));
  const xLabels = (ps?.days ?? []).filter((_, i, all) => i % 4 === 0 || i === all.length - 1).map((d) => {
    const [, m, day] = d.split("-");
    return `${day} ${MONTH_SHORT[Number(m) - 1]}`;
  });
  const week = Array.from({ length: 7 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i - 2));
  const upcoming = data?.upcoming.slice(0, 3) ?? [];
  const daily = data?.views_daily ?? [];
  const dailyMax = Math.max(1, ...daily.map((d) => d.views));
  const channel = (id: string) => data?.channels.find((c) => c.platform === id);

  // Relógio do cabeçalho
  const [time, setTime] = useState({
    date: "Terça-feira",
    fullDate: "23 de setembro de 2026",
    clock: "15:42",
  });

  useEffect(() => {
    function update() {
      const now = new Date();
      const dias = [
        "Domingo",
        "Segunda-feira",
        "Terça-feira",
        "Quarta-feira",
        "Quinta-feira",
        "Sexta-feira",
        "Sábado",
      ];
      const meses = [
        "janeiro",
        "fevereiro",
        "março",
        "abril",
        "maio",
        "junho",
        "julho",
        "agosto",
        "setembro",
        "outubro",
        "novembro",
        "dezembro",
      ];
      setTime({
        date: dias[now.getDay()],
        fullDate: `${now.getDate()} de ${meses[now.getMonth()]} de ${now.getFullYear()}`,
        clock: now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      });
    }
    update();
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen w-full bg-[#030914] text-[#d6e2f0] antialiased select-none font-sans">
      {/* =========================================================================
          SIDEBAR FIXA À ESQUERDA (270px)
         ========================================================================= */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-[270px] flex-col justify-between border-r border-[#0f1f35] bg-[#040d1a]">
        {/* Topo da Sidebar: Logo Clipo e Botão de Recolher */}
        <div>
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
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>

          {/* Botão Destaque: Início (Pill Ativa com Glow Azul) */}
          <div className="px-4 pt-1">
            <Link
              href="/dashboard"
              className="group relative flex h-11 w-full items-center gap-3 rounded-xl bg-gradient-to-r from-[#0d5cf5] via-[#1668f8] to-[#1e74ff] px-4 font-semibold text-white shadow-[0_0_20px_rgba(13,92,245,0.45)] transition hover:brightness-110"
            >
              <LayoutDashboard className="h-5 w-5" />
              <span className="text-sm">Início</span>
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
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm font-semibold text-white hover:bg-[#08162b] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <Video className="h-4 w-4 text-[#3b82f6]" />
                    <span>Vídeos</span>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 text-[#7187a5] transition-transform duration-200 ${
                      isVideosOpen ? "rotate-0" : "-rotate-90"
                    }`}
                  />
                </button>

                {/* Sub-árvore de Vídeos com transição de colapso */}
                <div
                  className={`grid transition-all duration-200 ease-in-out ${
                    isVideosOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="relative ml-4 pl-4 pt-1.5 pb-1 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-[#193356]">
                      <ul className="space-y-2.5 text-[13px]">
                        <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                          <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                          <Link href="/videos" className="py-0.5">Meus vídeos</Link>
                        </li>
                        <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                          <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                          <Link href="/fila" className="py-0.5">Fila de publicação</Link>
                        </li>
                        <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                          <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                          <Link href="/biblioteca" className="py-0.5">Biblioteca</Link>
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
        {/* HEADER: Busca, Notificações, Saudação e Montanhas */}
        <header className="relative px-8 pt-5 pb-3">
          {/* Linha 1: Input de Busca e Notificações */}
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar vídeos, ideias, hashtags..."
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

          {/* Linha 2: Saudação, Montanha com Glow e Relógio */}
          <div className="relative mt-4 flex items-center justify-between min-h-[90px] rounded-2xl overflow-hidden px-4">
            {/* Montanhas Azuis Iluminadas Exatas no Background com Fade Out para a Esquerda */}
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

            {/* Saudação */}
            <div className="relative z-10 py-2">
              <h1 className="flex items-center gap-2 text-[26px] font-extrabold tracking-tight text-white">
                <span>
                  {greeting}
                  {firstName ? `, ${firstName}` : ""}!
                </span>
                <span className="text-2xl">👋</span>
              </h1>
              <p className="mt-1 text-sm font-medium text-[#8fa2be]">
                Aqui está o resumo da sua produção de conteúdo.
              </p>
            </div>

            {/* Relógio & Data */}
            <div className="relative z-10 flex flex-col items-end text-right">
              <span className="text-[13px] font-medium text-[#8fa2be]">{time.date}</span>
              <span className="text-xs text-[#5e779d]">{time.fullDate}</span>
              <span className="mt-0.5 text-[28px] font-extrabold tracking-tight text-white leading-none">
                {time.clock}
              </span>
            </div>
          </div>
        </header>

        {/* CORPO DO DASHBOARD */}
        <main className="space-y-5 px-8 pb-10">
          {/* =====================================================================
              LINHA 1: Visualizações Diárias (Multi-Line Chart com Degradê Preenchido) + Lista de Redes
             ===================================================================== */}
          <div className="grid grid-cols-12 gap-5">
            {/* Gráfico Visualizações diárias (8 colunas) */}
            <div className="col-span-8 rounded-2xl border border-[#11233a] bg-[#05111f] p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3.5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6] shadow-sm">
                    <Sparkles className="h-5 w-5 text-[#3b82f6]" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">Visualizações diárias</h2>
                    <p className="text-xs text-[#6e87a8]">Desempenho das suas publicações por plataforma</p>
                  </div>
                </div>

                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg border border-[#1c3659] bg-[#08182b] px-3.5 py-1.5 text-xs font-semibold text-[#c0d0e6] transition hover:border-[#2d5182] hover:bg-[#0d233e]"
                >
                  <span>{data?.simulated ? "Últimos 30 dias · simulado" : "Últimos 30 dias"}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-[#6e87a8]" />
                </button>
              </div>

              {/* Gráfico Vetorial SVG Multi-Line com Degradê de Preenchimento Real */}
              <div className="relative mt-6 h-64 w-full">
                {/* Linhas de Grade e Eixo Y */}
                <div className="absolute inset-0 flex flex-col justify-between text-[11px] font-medium text-[#4d6687]">
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-right">{yLabels[0]}</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-right">{yLabels[1]}</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-right">{yLabels[2]}</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-right">{yLabels[3]}</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-right">{yLabels[4]}</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-right">{yLabels[5]}</span>
                    <div className="h-px flex-1 border-b border-[#142944]" />
                  </div>
                </div>

                {/* SVG Curves com Gradientes Preenchidos (Área sob as curvas com alto contraste e saturação) */}
                <svg
                  viewBox="0 0 680 200"
                  preserveAspectRatio="none"
                  className="absolute inset-y-0 right-0 left-10 h-full w-[calc(100%-2.5rem)] overflow-visible"
                >
                  <defs>
                    {/* Gradientes Lineares de Área com opacidade marcante e degrade suave */}
                    <linearGradient id="area-pink" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ff2d75" stopOpacity="0.55" />
                      <stop offset="45%" stopColor="#ec4899" stopOpacity="0.25" />
                      <stop offset="90%" stopColor="#ec4899" stopOpacity="0.05" />
                      <stop offset="100%" stopColor="#ec4899" stopOpacity="0.0" />
                    </linearGradient>

                    <linearGradient id="area-purple" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a855f7" stopOpacity="0.45" />
                      <stop offset="50%" stopColor="#9333ea" stopOpacity="0.20" />
                      <stop offset="90%" stopColor="#9333ea" stopOpacity="0.04" />
                      <stop offset="100%" stopColor="#9333ea" stopOpacity="0.0" />
                    </linearGradient>

                    <linearGradient id="area-orange" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f97316" stopOpacity="0.40" />
                      <stop offset="50%" stopColor="#ea580c" stopOpacity="0.18" />
                      <stop offset="90%" stopColor="#ea580c" stopOpacity="0.03" />
                      <stop offset="100%" stopColor="#ea580c" stopOpacity="0.0" />
                    </linearGradient>

                    <linearGradient id="area-cyan" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.35" />
                      <stop offset="50%" stopColor="#0891b2" stopOpacity="0.15" />
                      <stop offset="90%" stopColor="#0891b2" stopOpacity="0.02" />
                      <stop offset="100%" stopColor="#0891b2" stopOpacity="0.0" />
                    </linearGradient>

                    {/* Filtros de Glow Neon */}
                    <filter id="glow-pink" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#ff2d75" floodOpacity="0.9" />
                    </filter>
                    <filter id="glow-purple" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#a855f7" floodOpacity="0.9" />
                    </filter>
                    <filter id="glow-orange" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#f97316" floodOpacity="0.9" />
                    </filter>
                    <filter id="glow-cyan" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#06b6d4" floodOpacity="0.9" />
                    </filter>
                  </defs>

                  {NETS.map((net) => {
                    const values = ps?.series[net.id];
                    if (!values?.some(Boolean)) return null;
                    const d = linePath(values, chartMax);
                    const lastY = Math.round(200 - (values[values.length - 1] / chartMax) * 188);
                    return (
                      <g key={net.id}>
                        <path d={`${d} L 680 200 L 0 200 Z`} fill={net.area} />
                        <path d={d} fill="none" stroke={net.color} strokeWidth="3" filter={net.glow} />
                        <circle cx="680" cy={lastY} r="4.5" fill="#ffffff" stroke={net.color} strokeWidth="2.5" />
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Rótulos do Eixo X com Datas Reais */}
              <div className="mt-3 flex justify-between pl-10 text-[11px] font-semibold text-[#546e8f]">
                {xLabels.map((label, i) => (
                  <span key={i}>{label}</span>
                ))}
              </div>
            </div>

            {/* Painel Lateral: Métricas por Plataforma (4 colunas) */}
            <div className="col-span-4 flex flex-col justify-between rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
              {/* Item 1: TikTok */}
              <div className="flex items-center justify-between py-2 border-b border-[#0d1e33]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#000000] border border-[#1d2d42] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 3 15.68 6.34 6.34 0 0 0 9.34 22a6.34 6.34 0 0 0 6.34-6.32V9.08a8.28 8.28 0 0 0 4.91 1.6V7.23a4.77 4.77 0 0 1-1-.54z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">TikTok</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-[17px] font-extrabold text-white">{compact(ps?.totals.tiktok?.views ?? 0)}</p>
                    <p className={`text-[11px] font-bold flex items-center justify-end gap-0.5 ${(ps?.totals.tiktok?.delta_pct ?? 0) < 0 ? "text-[#f87171]" : "text-[#10b981]"}`}>
                      <span>{arrow(ps?.totals.tiktok?.delta_pct)}</span>
                    </p>
                  </div>

                  {/* Sparkline TikTok */}
                  <svg className="h-6 w-16" viewBox="0 0 64 24" fill="none">
                    <path
                      d={linePath((ps?.series.tiktok ?? []).slice(-14), Math.max(1, ...(ps?.series.tiktok ?? [1]).slice(-14)), 64, 22) || "M2 20 L62 20"}
                      stroke="#ff2d75"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>

              {/* Item 2: Instagram */}
              <div className="flex items-center justify-between py-2 border-b border-[#0d1e33]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Instagram</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-[17px] font-extrabold text-white">{compact(ps?.totals.instagram?.views ?? 0)}</p>
                    <p className={`text-[11px] font-bold flex items-center justify-end gap-0.5 ${(ps?.totals.instagram?.delta_pct ?? 0) < 0 ? "text-[#f87171]" : "text-[#10b981]"}`}>
                      <span>{arrow(ps?.totals.instagram?.delta_pct)}</span>
                    </p>
                  </div>

                  {/* Sparkline Instagram */}
                  <svg className="h-6 w-16" viewBox="0 0 64 24" fill="none">
                    <path
                      d={linePath((ps?.series.instagram ?? []).slice(-14), Math.max(1, ...(ps?.series.instagram ?? [1]).slice(-14)), 64, 22) || "M2 20 L62 20"}
                      stroke="#a855f7"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>

              {/* Item 3: YouTube */}
              <div className="flex items-center justify-between py-2 border-b border-[#0d1e33]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#ff0000] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">YouTube</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-[17px] font-extrabold text-white">{compact(ps?.totals.youtube?.views ?? 0)}</p>
                    <p className={`text-[11px] font-bold flex items-center justify-end gap-0.5 ${(ps?.totals.youtube?.delta_pct ?? 0) < 0 ? "text-[#f87171]" : "text-[#10b981]"}`}>
                      <span>{arrow(ps?.totals.youtube?.delta_pct)}</span>
                    </p>
                  </div>

                  {/* Sparkline YouTube */}
                  <svg className="h-6 w-16" viewBox="0 0 64 24" fill="none">
                    <path
                      d={linePath((ps?.series.youtube ?? []).slice(-14), Math.max(1, ...(ps?.series.youtube ?? [1]).slice(-14)), 64, 22) || "M2 20 L62 20"}
                      stroke="#f97316"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>

              {/* Item 4: LinkedIn */}
              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0077b5] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">LinkedIn</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-[17px] font-extrabold text-white">{compact(ps?.totals.linkedin?.views ?? 0)}</p>
                    <p className={`text-[11px] font-bold flex items-center justify-end gap-0.5 ${(ps?.totals.linkedin?.delta_pct ?? 0) < 0 ? "text-[#f87171]" : "text-[#10b981]"}`}>
                      <span>{arrow(ps?.totals.linkedin?.delta_pct)}</span>
                    </p>
                  </div>

                  {/* Sparkline LinkedIn */}
                  <svg className="h-6 w-16" viewBox="0 0 64 24" fill="none">
                    <path
                      d={linePath((ps?.series.linkedin ?? []).slice(-14), Math.max(1, ...(ps?.series.linkedin ?? [1]).slice(-14)), 64, 22) || "M2 20 L62 20"}
                      stroke="#06b6d4"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          {/* =====================================================================
              LINHA 2: Calendário Editorial (8 cols) + Alcance da Semana & Na Fila (4 cols)
             ===================================================================== */}
          <div className="grid grid-cols-12 gap-5">
            {/* Calendário Editorial (8 colunas) */}
            <div className="col-span-8 rounded-2xl border border-[#11233a] bg-[#05111f] p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
              <div className="flex items-center justify-between pb-4 border-b border-[#0d1e33]">
                <div className="flex items-center gap-3.5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6]">
                    <Calendar className="h-5 w-5 text-[#3b82f6]" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">Calendário Editorial</h2>
                    <p className="text-xs text-[#6e87a8]">Visão geral das suas próximas postagens</p>
                  </div>
                </div>

                <Link
                  href="/calendario"
                  className="flex items-center gap-1.5 rounded-lg border border-[#1c3659] bg-[#08182b] px-3.5 py-1.5 text-xs font-semibold text-[#3b82f6] hover:border-[#2d5182] hover:text-white transition"
                >
                  <span>Abrir calendário</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>

              {/* Régua de Dias da Semana com hoje marcado */}
              <div className="mt-4 flex items-center justify-between px-2">
                {week.map((d, i) =>
                  i === 2 ? (
                    <div key={i} className="flex flex-col items-center">
                      <div className="flex h-12 w-14 flex-col items-center justify-center rounded-xl bg-gradient-to-b from-[#2563eb] to-[#1d4ed8] text-white shadow-[0_0_15px_rgba(37,99,235,0.5)]">
                        <span className="text-[10px] font-bold uppercase tracking-wider">Hoje</span>
                        <span className="text-base font-extrabold leading-tight">{d.getDate()}</span>
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="flex flex-col items-center">
                      <span className="text-[11px] font-semibold text-[#546e8f]">{WEEK_SHORT[d.getDay()]}</span>
                      <span className="mt-1 text-sm font-bold text-[#8fa2be]">{d.getDate()}</span>
                    </div>
                  ),
                )}
              </div>

              {/* Próximos agendamentos */}
              <div className="mt-5 space-y-3">
                {data && upcoming.length === 0 && (
                  <p className="rounded-xl border border-dashed border-[#15273f] p-4 text-center text-xs text-[#6e87a8]">
                    Nada agendado. Escolha um corte e agende nas redes.
                  </p>
                )}
                {upcoming.map((pub) => (
                  <Link
                    key={pub.id}
                    href={`/publicacoes/${pub.id}`}
                    className="flex items-center justify-between rounded-xl border border-[#0d2138] bg-[#071526]/60 p-2.5 transition hover:border-[#1a385f]"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="h-2 w-2 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                      <span className="text-xs font-bold text-[#c9d5e8] shrink-0">{whenLabel(pub.scheduled_at)}</span>
                      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-[#1b324f] bg-[#020712]">
                        {/* eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada */}
                        <img src={pub.thumbnail_url} alt="" className="absolute inset-0 h-full w-full object-cover" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-bold text-white">{pub.title}</p>
                        <NetDots platforms={pub.targets.map((t) => t.platform)} />
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full border border-[#065f46] bg-[#064e3b]/40 px-3 py-1 text-[11px] font-bold text-[#10b981]">
                      Agendado
                    </span>
                  </Link>
                ))}
              </div>

              {/* Botão Ver todas as postagens */}
              <div className="mt-4 text-center">
                <Link
                  href="/fila"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#152a45] bg-[#07172b] px-5 py-2 text-xs font-semibold text-[#3b82f6] hover:border-[#2563eb] hover:bg-[#0c2444] transition"
                >
                  <span>Ver todas as postagens na fila</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>

            {/* Painel Duplo à Direita: Alcance da Semana + Na Fila Automática (4 colunas) */}
            <div className="col-span-4 flex flex-col justify-between gap-5">
              {/* Card 1: Alcance da semana */}
              <div className="flex-1 rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1d4ed8]/30 bg-[#1e40af]/20 text-[#3b82f6]">
                      <TrendingUp className="h-5 w-5 text-[#3b82f6]" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-[#8fa2be]">Alcance da semana</p>
                      <div className="flex items-baseline gap-2 mt-0.5">
                        <span className="text-2xl font-black tracking-tight text-white">
                          {compact(data?.stats.views_7d.value ?? 0)}
                        </span>
                        <span className={`text-xs font-bold ${(data?.stats.views_7d.delta_pct ?? 0) < 0 ? "text-[#f87171]" : "text-[#10b981]"}`}>
                          {arrow(data?.stats.views_7d.delta_pct)}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#546e8f]">que a semana anterior</p>
                    </div>
                  </div>

                  {/* Barras de alcance por dia */}
                  <div className="flex items-end gap-1.5 h-16 pt-2" aria-hidden>
                    {(daily.length ? daily : Array.from({ length: 7 }, () => ({ views: 0 }))).map((d, i) => (
                      <div
                        key={i}
                        className={`w-2.5 rounded-full ${i === 6 ? "bg-[#60a5fa] shadow-[0_0_12px_#60a5fa]" : "bg-[#2563eb]"}`}
                        style={{ height: `${Math.max(8, (d.views / dailyMax) * 100)}%` }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Card 2: Na fila automática */}
              <Link
                href="/fila"
                className="flex-1 rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between transition hover:border-[#1e4375] hover:bg-[#071629]"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6]">
                      <Clock className="h-5 w-5 text-[#3b82f6]" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-[#8fa2be]">Na fila automática</p>
                      <div className="flex items-baseline gap-2 mt-0.5">
                        <span className="text-2xl font-black tracking-tight text-white">{data?.stats.scheduled ?? 0}</span>
                        <span className="text-xs font-medium text-[#c9d5e8]">conteúdos</span>
                      </div>
                      <p className="text-[11px] font-bold text-[#10b981] flex items-center gap-1">
                        <span>{data?.stats.published_30d ?? 0}</span>
                        <span className="font-normal text-[#546e8f]">publicados em 30 dias</span>
                      </p>
                    </div>
                  </div>

                  {/* Onda em Degradê Azul Brilhante */}
                  <div className="relative h-14 w-28 flex items-center">
                    <svg className="h-full w-full" viewBox="0 0 120 40" fill="none">
                      <path
                        d="M 5 32 C 30 32, 50 28, 70 20 C 90 12, 105 8, 115 6"
                        stroke="#3b82f6"
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        className="drop-shadow-[0_0_8px_rgba(59,130,246,0.9)]"
                      />
                    </svg>
                  </div>
                </div>
              </Link>
            </div>
          </div>

          {/* =====================================================================
              LINHA 3: Canais Conectados (TikTok, Instagram, YouTube, LinkedIn)
             ===================================================================== */}
          <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
            <div className="flex items-center justify-between pb-3 border-b border-[#0d1e33]">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6]">
                  <Radio className="h-4 w-4 text-[#3b82f6]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Canais Conectados</h3>
                  <p className="text-xs text-[#6e87a8]">Gerencie suas contas e acompanhe o desempenho</p>
                </div>
              </div>

              <Link
                href="/contas"
                className="flex items-center gap-1 rounded-lg border border-[#1c3659] bg-[#08182b] px-3 py-1.5 text-xs font-semibold text-[#3b82f6] hover:border-[#2d5182] hover:text-white transition"
              >
                <span>Conectar canal</span>
                <Plus className="h-3.5 w-3.5" />
              </Link>
            </div>

            {/* Grid dos 4 Canais */}
            <div className="mt-4 grid grid-cols-4 gap-4">
              {/* Canal TikTok */}
              <div className="flex items-center justify-between rounded-xl border border-[#0d2138] bg-[#061426] p-3 transition hover:border-[#1a385f]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-black border border-[#1b2b3f] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 3 15.68 6.34 6.34 0 0 0 9.34 22a6.34 6.34 0 0 0 6.34-6.32V9.08a8.28 8.28 0 0 0 4.91 1.6V7.23a4.77 4.77 0 0 1-1-.54z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">TikTok</p>
                    <p className="text-[11px] text-[#546e8f]">{channel("tiktok")?.account?.handle ?? (channel("tiktok") ? "não conectado" : "em breve")}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-[#10b981]">
                      <span className={`h-1.5 w-1.5 rounded-full ${channel("tiktok")?.status === "active" ? "bg-[#10b981]" : "bg-[#546e8f]"}`} />
                      <span>{channel("tiktok")?.status === "active" ? "Conectado" : channel("tiktok")?.status === "needs_reconnect" ? "Reconectar" : "Desconectado"}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-sm font-extrabold text-white">{compact(channel("tiktok")?.followers ?? channel("tiktok")?.account?.followers ?? null)}</p>
                    <p className="text-[10px] text-[#546e8f]">Seguidores</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-[#546e8f]" />
                </div>
              </div>

              {/* Canal Instagram */}
              <div className="flex items-center justify-between rounded-xl border border-[#0d2138] bg-[#061426] p-3 transition hover:border-[#1a385f]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Instagram</p>
                    <p className="text-[11px] text-[#546e8f]">{channel("instagram")?.account?.handle ?? (channel("instagram") ? "não conectado" : "em breve")}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-[#10b981]">
                      <span className={`h-1.5 w-1.5 rounded-full ${channel("instagram")?.status === "active" ? "bg-[#10b981]" : "bg-[#546e8f]"}`} />
                      <span>{channel("instagram")?.status === "active" ? "Conectado" : channel("instagram")?.status === "needs_reconnect" ? "Reconectar" : "Desconectado"}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-sm font-extrabold text-white">{compact(channel("instagram")?.followers ?? channel("instagram")?.account?.followers ?? null)}</p>
                    <p className="text-[10px] text-[#546e8f]">Seguidores</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-[#546e8f]" />
                </div>
              </div>

              {/* Canal YouTube */}
              <div className="flex items-center justify-between rounded-xl border border-[#0d2138] bg-[#061426] p-3 transition hover:border-[#1a385f]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#ff0000] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">YouTube</p>
                    <p className="text-[11px] text-[#546e8f]">{channel("youtube")?.account?.handle ?? (channel("youtube") ? "não conectado" : "em breve")}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-[#10b981]">
                      <span className={`h-1.5 w-1.5 rounded-full ${channel("youtube")?.status === "active" ? "bg-[#10b981]" : "bg-[#546e8f]"}`} />
                      <span>{channel("youtube")?.status === "active" ? "Conectado" : channel("youtube")?.status === "needs_reconnect" ? "Reconectar" : "Desconectado"}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-sm font-extrabold text-white">{compact(channel("youtube")?.followers ?? channel("youtube")?.account?.followers ?? null)}</p>
                    <p className="text-[10px] text-[#546e8f]">Inscritos</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-[#546e8f]" />
                </div>
              </div>

              {/* Canal LinkedIn */}
              <div className="flex items-center justify-between rounded-xl border border-[#0d2138] bg-[#061426] p-3 transition hover:border-[#1a385f]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0077b5] text-white">
                    <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">LinkedIn</p>
                    <p className="text-[11px] text-[#546e8f]">{channel("linkedin")?.account?.handle ?? (channel("linkedin") ? "não conectado" : "em breve")}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-[#10b981]">
                      <span className={`h-1.5 w-1.5 rounded-full ${channel("linkedin")?.status === "active" ? "bg-[#10b981]" : "bg-[#546e8f]"}`} />
                      <span>{channel("linkedin")?.status === "active" ? "Conectado" : channel("linkedin")?.status === "needs_reconnect" ? "Reconectar" : "Desconectado"}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-sm font-extrabold text-white">{compact(channel("linkedin")?.followers ?? channel("linkedin")?.account?.followers ?? null)}</p>
                    <p className="text-[10px] text-[#546e8f]">Seguidores</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-[#546e8f]" />
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

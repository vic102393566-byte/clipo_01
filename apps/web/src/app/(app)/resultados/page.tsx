"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  Award,
  BarChart3,
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Download,
  Eye,
  Filter,
  Flame,
  Globe,
  HardDrive,
  Heart,
  HelpCircle,
  Layers,
  LayoutDashboard,
  LineChart,
  MessageCircle,
  MoreHorizontal,
  PieChart,
  Play,
  Plus,
  Radio,
  Search,
  Settings,
  Share2,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Video as VideoIcon,
  Zap,
} from "lucide-react";
import { ExportMenu } from "@/components/app/export-menu";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { ago } from "@/lib/format";
import { compact, type Overview } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface TopVideo {
  id: string;
  title: string;
  thumbnail: string;
  views: string;
  retention: string;
  shares: string;
  likes: string;
  aiScore: number;
  publishedAt: string;
  platforms: Array<"tiktok" | "instagram" | "youtube" | "linkedin">;
}

const NET_STYLE: Record<string, { label: string; dot: string; bar: string }> = {
  tiktok: { label: "TikTok", dot: "bg-pink-500", bar: "from-pink-500 to-rose-400" },
  instagram: { label: "Instagram Reels", dot: "bg-purple-500", bar: "from-purple-500 to-pink-500" },
  youtube: { label: "YouTube Shorts", dot: "bg-orange-500", bar: "from-orange-500 to-amber-400" },
  linkedin: { label: "LinkedIn Vídeo", dot: "bg-cyan-500", bar: "from-cyan-500 to-blue-400" },
};

function curvePath(points: number[]): string {
  const step = 680 / (points.length - 1);
  return points.map((v, i) => `${i ? "L" : "M"} ${Math.round(i * step)} ${Math.round(180 - (v / 100) * 180)}`).join(" ");
}

function Delta({ value, unit = "%" }: { value: number | null; unit?: string }) {
  if (value == null) return <span className="text-[#546e8f] font-bold">—</span>;
  const up = value >= 0;
  return (
    <span className={`${up ? "text-[#10b981]" : "text-[#f87171]"} font-bold flex items-center gap-0.5`}>
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      <span>
        {up ? "+" : ""}
        {value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}
        {unit}
      </span>
    </span>
  );
}

type PeriodType = "7d" | "30d" | "90d" | "year";

export default function ResultadosPage() {
  const [isVideosOpen, setIsVideosOpen] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState<PeriodType>("30d");
  const [selectedPlatform, setSelectedPlatform] = useState<string>("all");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const { data, error, loading, reload } = useApi<Overview>(
    `/api/v1/analytics/overview?period=${selectedPeriod}${selectedPlatform === "all" ? "" : `&platform=${selectedPlatform}`}`,
  );
  const k = data?.kpis;
  const curve = data?.retention_curve;
  const lead = data?.platforms.slice(0, 2) ?? [];
  const TOP_VIDEOS: TopVideo[] = (data?.top ?? []).map((t) => ({
    id: t.publication_id,
    title: t.title,
    thumbnail: t.thumbnail_url,
    views: compact(t.views),
    retention: t.retention_pct == null ? "—" : `${t.retention_pct.toLocaleString("pt-BR")}%`,
    shares: compact(t.shares),
    likes: compact(t.likes),
    aiScore: t.score,
    publishedAt: t.published_at ? ago(t.published_at) : "",
    platforms: t.platforms.filter((n): n is TopVideo["platforms"][number] => n !== "x"),
  }));

  const createDemo = async () => {
    try {
      await api("/api/v1/dev/demo-data", { method: "POST" });
      await reload();
      showToast("Dados de demonstração criados.");
    } catch (err) {
      showToast(err instanceof ApiError && err.status === 404 ? "Disponível só no ambiente local." : "Não foi possível criar os dados.");
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#030914] text-[#d6e2f0] antialiased select-none font-sans">
      {/* =========================================================================
          SIDEBAR FIXA À ESQUERDA (270px) - ATIVA EM RESULTADOS
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

            {/* SEÇÃO ANÁLISES - RESULTADOS ATIVO */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Análises</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>

              {/* Botão Resultados Ativo com borda e glow */}
              <Link
                href="/resultados"
                className="flex items-center gap-2.5 rounded-xl border border-[#173868] bg-[#0c2242]/80 px-3 py-2 text-sm font-semibold text-white transition shadow-[0_0_15px_rgba(12,34,66,0.5)]"
              >
                <TrendingUp className="h-4 w-4 text-[#3b82f6]" />
                <span>Resultados</span>
                <span className="ml-auto h-2 w-2 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
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
        {/* HEADER: Busca, Notificações, Título, Banner e Exportação */}
        <header className="relative px-8 pt-5 pb-3">
          {/* Linha 1: Input de Busca e Notificações */}
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar métricas, relatórios de cortes, conversão..."
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

          {/* Linha 2: Banner de Título com Montanhas e Filtro Temporal */}
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
                  Resultados & Métricas
                </h1>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#10b981] backdrop-blur-md">
                  {k?.views.delta_pct == null
                    ? "Sem comparação"
                    : `${k.views.delta_pct > 0 ? "+" : ""}${k.views.delta_pct.toLocaleString("pt-BR")}% views`}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-[#8fa2be]">
                Desempenho consolidado de engajamento, retenção, visualizações e viralidade multiplataforma.
              </p>
            </div>

            {/* Controles de Período & Botão Exportar */}
            <div className="relative z-10 flex items-center gap-3">
              {/* Seletor de Período */}
              <div className="flex items-center rounded-xl border border-[#162c47] bg-[#071629] p-1 shadow-sm">
                {(
                  [
                    ["7d", "7 dias"],
                    ["30d", "30 dias"],
                    ["90d", "90 dias"],
                    ["year", "Ano"],
                  ] as const
                ).map(([pKey, pLabel]) => (
                  <button
                    key={pKey}
                    type="button"
                    onClick={() => setSelectedPeriod(pKey)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                      selectedPeriod === pKey
                        ? "bg-[#0d62f7] text-white shadow-sm"
                        : "text-[#7f97b6] hover:text-white"
                    }`}
                  >
                    {pLabel}
                  </button>
                ))}
              </div>

              {data?.simulated && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-400" title="Sem métricas reais das redes neste ambiente: números gerados pelo simulador local.">
                  Dados simulados
                </span>
              )}
              {/* Botão Exportar Relatório */}
              <ExportMenu
                disabled={!data?.has_data}
                query={`period=${selectedPeriod}${selectedPlatform === "all" ? "" : `&platform=${selectedPlatform}`}`}
              />
            </div>
          </div>
        </header>

        {/* CORPO PRINCIPAL */}
        <main className="px-8 pb-10 space-y-6">
          {/* =====================================================================
              LINHA 1: 4 CARDS DE KPIs PRINCIPAIS
             ===================================================================== */}
          <div className="grid grid-cols-4 gap-4">
            {/* KPI 1: Visualizações Totais */}
            <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold text-[#8fa2be]">Visualizações Totais</p>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black tracking-tight text-white">{compact(k?.views.value)}</span>
                  </div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/20 text-[#3b82f6] border border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.3)]">
                  <Eye className="h-5 w-5 text-[#3b82f6]" />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-[#0d1e33] pt-2.5 text-xs">
                <Delta value={k?.views.delta_pct ?? null} unit="%" />
                <span className="text-[#546e8f]">vs período anterior</span>
              </div>
            </div>

            {/* KPI 2: Retenção Média */}
            <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold text-[#8fa2be]">Retenção Média</p>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black tracking-tight text-white">
                      {k?.retention.value == null ? "—" : `${k.retention.value.toLocaleString("pt-BR")}%`}
                    </span>
                  </div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-600/20 text-[#c084fc] border border-purple-500/30 shadow-[0_0_12px_rgba(192,132,252,0.3)]">
                  <Flame className="h-5 w-5 text-[#c084fc]" />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-[#0d1e33] pt-2.5 text-xs">
                <Delta value={k?.retention.delta_pct ?? null} unit=" p.p." />
                <span className="text-[#546e8f]">vs período anterior</span>
              </div>
            </div>

            {/* KPI 3: Tempo Assistido */}
            <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold text-[#8fa2be]">Engajamento</p>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black tracking-tight text-white">{compact(k?.engagement.value)}</span>
                  </div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-600/20 text-[#fb923c] border border-orange-500/30 shadow-[0_0_12px_rgba(251,146,60,0.3)]">
                  <Clock className="h-5 w-5 text-[#fb923c]" />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-[#0d1e33] pt-2.5 text-xs">
                <Delta value={k?.engagement.delta_pct ?? null} unit="%" />
                <span className="text-[#546e8f]">curtidas, comentários e envios</span>
              </div>
            </div>

            {/* KPI 4: Novos Seguidores */}
            <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold text-[#8fa2be]">Novos Seguidores</p>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black tracking-tight text-white">
                      {k?.followers.value ? `+${compact(k.followers.value)}` : compact(k?.followers.value)}
                    </span>
                  </div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-600/20 text-[#38bdf8] border border-cyan-500/30 shadow-[0_0_12px_rgba(56,189,248,0.3)]">
                  <Users className="h-5 w-5 text-[#38bdf8]" />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-[#0d1e33] pt-2.5 text-xs">
                <Delta value={k?.followers.delta_pct ?? null} unit="%" />
                <span className="text-[#546e8f]">vs período anterior</span>
              </div>
            </div>
          </div>

          {/* =====================================================================
              LINHA 2: GRÁFICO DE CURVA DE RETENÇÃO (8 cols) + PERFORMANCE POR CANAL (4 cols)
             ===================================================================== */}
          <div className="grid grid-cols-12 gap-5">
            {/* Gráfico 1: Curva de Retenção de Audiência por Segundo */}
            <div className="col-span-8 rounded-2xl border border-[#11233a] bg-[#05111f] p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3.5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6]">
                    <LineChart className="h-5 w-5 text-[#3b82f6]" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">Curva de Retenção de Audiência</h2>
                    <p className="text-xs text-[#6e87a8]">
                      Quanto da audiência segue assistindo ao longo do vídeo (média ponderada pelas views)
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 text-xs text-[#10b981] font-semibold">
                    <span className="h-2 w-2 rounded-full bg-[#10b981]" />
                    <span>Gancho (10% do vídeo): {curve ? `${curve[1].toLocaleString("pt-BR")}%` : "—"}</span>
                  </span>
                </div>
              </div>

              {/* Gráfico SVG de Retenção com Degradê Luminoso */}
              <div className="relative mt-6 h-60 w-full">
                {/* Linhas de Grade e Eixo Y */}
                <div className="absolute inset-0 flex flex-col justify-between text-[11px] font-medium text-[#4d6687]">
                  <div className="flex items-center gap-3">
                    <span className="w-8 text-right">100%</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-8 text-right">75%</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-8 text-right">50%</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-8 text-right">25%</span>
                    <div className="h-px flex-1 border-b border-dashed border-[#11243b]" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-8 text-right">0%</span>
                    <div className="h-px flex-1 border-b border-[#142944]" />
                  </div>
                </div>

                {/* SVG Curve com Área Preenchida e Glow */}
                <svg
                  viewBox="0 0 680 180"
                  preserveAspectRatio="none"
                  className="absolute inset-y-0 right-0 left-11 h-full w-[calc(100%-2.75rem)] overflow-visible"
                >
                  <defs>
                    <linearGradient id="retention-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.5" />
                      <stop offset="40%" stopColor="#2563eb" stopOpacity="0.2" />
                      <stop offset="100%" stopColor="#2563eb" stopOpacity="0.0" />
                    </linearGradient>

                    <linearGradient id="benchmark-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="#94a3b8" stopOpacity="0.0" />
                    </linearGradient>

                    <filter id="neon-glow" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#38bdf8" floodOpacity="0.9" />
                    </filter>
                  </defs>

                  {curve && (
                    <>
                      <path d={`${curvePath(curve)} L 680 180 L 0 180 Z`} fill="url(#retention-grad)" />
                      <path d={curvePath(curve)} fill="none" stroke="#38bdf8" strokeWidth="3.5" filter="url(#neon-glow)" />
                      {[0, 3, 6, 9].map((i) => (
                        <circle
                          key={i}
                          cx={Math.round((i * 680) / 9)}
                          cy={Math.round(180 - (curve[i] / 100) * 180)}
                          r="4.5"
                          fill="#ffffff"
                          stroke="#38bdf8"
                          strokeWidth="2.5"
                        />
                      ))}
                    </>
                  )}
                </svg>
              </div>

              {/* Rótulos do Eixo X em Segundos */}
              <div className="mt-3 flex justify-between pl-11 text-[11px] font-semibold text-[#546e8f]">
                <span>Início (gancho)</span>
                <span>25%</span>
                <span>Metade</span>
                <span>75%</span>
                <span>Final / CTA</span>
              </div>
            </div>

            {/* Gráfico 2: Divisão de Alcance por Plataforma */}
            <div className="col-span-4 rounded-2xl border border-[#11233a] bg-[#05111f] p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6]">
                    <PieChart className="h-5 w-5 text-[#3b82f6]" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">Distribuição de Visualizações</h3>
                    <p className="text-xs text-[#6e87a8]">Participação por rede social</p>
                  </div>
                </div>

                {/* Barras de Percentual por Canal */}
                <div className="mt-6 space-y-4">
                  {(data?.platforms ?? []).length === 0 && (
                    <p className="text-xs text-[#6e87a8]">Sem visualizações no período.</p>
                  )}
                  {(data?.platforms ?? []).map((row) => {
                    const st = NET_STYLE[row.platform] ?? NET_STYLE.linkedin;
                    return (
                      <div key={row.platform}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-white flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                            <span>{st.label}</span>
                          </span>
                          <span className="font-bold text-white">
                            {row.pct.toLocaleString("pt-BR")}% • {compact(row.views)}
                          </span>
                        </div>
                        <div className="mt-1.5 h-2 w-full rounded-full bg-[#0d2138] overflow-hidden">
                          <div className={`h-full rounded-full bg-gradient-to-r ${st.bar}`} style={{ width: `${row.pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Dica da IA sobre canais */}
              <div className="mt-5 rounded-xl border border-[#163866] bg-[#071933] p-3 text-xs text-[#8fa2be]">
                <div className="flex items-center gap-1.5 text-white font-bold mb-1">
                  <Sparkles className="h-3.5 w-3.5 text-[#3b82f6]" />
                  <span>Resumo do período</span>
                </div>
                {lead.length
                  ? (
                    <>
                      {lead.map((r) => NET_STYLE[r.platform]?.label ?? r.platform).join(" e ")}{" "}
                      {lead.length > 1 ? "representam" : "representa"}{" "}
                      <strong className="text-white">
                        {lead.reduce((n, r) => n + r.pct, 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                      </strong>{" "}
                      das visualizações do período.
                    </>
                  )
                  : "Publique nas redes para ver de onde vem o seu alcance."}
              </div>
            </div>
          </div>

          {/* =====================================================================
              LINHA 3: TABELA DE CONTEÚDO CAMPEÃO (TOP PERFORMING VIDEOS)
             ===================================================================== */}
          <div className="rounded-2xl border border-[#11233a] bg-[#05111f] p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
            <div className="flex items-center justify-between pb-4 border-b border-[#0d1e33]">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e3c66] bg-[#0c203b] text-[#3b82f6]">
                  <Award className="h-5 w-5 text-[#3b82f6]" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Vídeos de Maior Retenção & Viralidade</h3>
                  <p className="text-xs text-[#6e87a8]">Classificação por pontuação de impacto e retenção</p>
                </div>
              </div>

              <Link
                href="/videos"
                className="text-xs font-semibold text-[#3b82f6] hover:underline flex items-center gap-1"
              >
                <span>Ver todos os vídeos</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {/* Listagem em Tabela Estilizada */}
            {loading && !data ? (
              <div className="mt-4 h-40 animate-pulse rounded-xl bg-[#071629]" aria-busy="true" />
            ) : error && !data ? (
              <p role="alert" className="mt-4 text-sm text-[#f87171]">Não foi possível carregar os resultados: {error.message}</p>
            ) : data && !data.has_data ? (
              <div className="mt-4 rounded-xl border border-dashed border-[#15273f] p-6 text-center text-sm text-[#8fa2be]">
                <p className="font-semibold text-white">Ainda não há métricas</p>
                <p className="mt-1 text-xs">As métricas chegam a cada 6 horas depois que um vídeo é publicado nas redes.</p>
                <button type="button" onClick={() => void createDemo()} className="mt-4 rounded-xl border border-[#1b3456] px-4 py-2 text-xs font-semibold text-[#c0d0e6] hover:bg-[#0c233f] cursor-pointer">
                  Gerar dados de demonstração (local)
                </button>
              </div>
            ) : null}
            <div className="mt-4 divide-y divide-[#0d1e33]">
              {TOP_VIDEOS.map((video, idx) => (
                <div
                  key={video.id}
                  className="py-3.5 flex items-center justify-between gap-4 transition hover:bg-[#071629]/40 rounded-xl px-2"
                >
                  {/* Lado Esquerdo: Posição, Thumbnail e Título */}
                  <div className="flex items-center gap-4 min-w-0">
                    <span className="font-mono text-sm font-extrabold text-[#4d6687] w-5 text-center">
                      #{idx + 1}
                    </span>
                    <div className="relative aspect-[16/9] w-24 shrink-0 overflow-hidden rounded-lg border border-[#142a47]">
                      {/* eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada */}
                      <img src={video.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="truncate text-sm font-bold text-white hover:text-[#60a5fa] transition">
                        {video.title}
                      </h4>
                      <p className="text-xs text-[#546e8f] mt-0.5">{video.publishedAt}</p>
                    </div>
                  </div>

                  {/* Lado Direito: Métricas de Sucesso */}
                  <div className="flex items-center gap-8 shrink-0">
                    {/* Visualizações */}
                    <div className="text-right">
                      <p className="text-xs text-[#6e87a8]">Visualizações</p>
                      <p className="text-sm font-extrabold text-white mt-0.5">{video.views}</p>
                    </div>

                    {/* Retenção */}
                    <div className="text-right">
                      <p className="text-xs text-[#6e87a8]">Retenção</p>
                      <p className="text-sm font-extrabold text-[#10b981] mt-0.5">{video.retention}</p>
                    </div>

                    {/* Compartilhamentos */}
                    <div className="text-right">
                      <p className="text-xs text-[#6e87a8]">Compartilhados</p>
                      <p className="text-sm font-extrabold text-[#38bdf8] mt-0.5">{video.shares}</p>
                    </div>

                    {/* AI Score Badge */}
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] text-[#5e779d] font-bold" title="Desempenho comparado aos outros vídeos do workspace">DESEMPENHO</span>
                        <span className="rounded-lg bg-gradient-to-r from-blue-600 to-cyan-500 px-2 py-0.5 text-xs font-extrabold text-white shadow-[0_0_8px_rgba(37,99,235,0.4)]">
                          {video.aiScore} / 100
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
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
    </div>
  );
}


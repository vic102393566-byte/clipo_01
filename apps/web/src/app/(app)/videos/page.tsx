"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Clock,
  FileText,
  Filter,
  Grid,
  LayoutDashboard,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Radio,
  Search,
  Settings,
  Sparkles,
  TrendingUp,
  Upload,
  Video as VideoIcon,
  X as CloseIcon,
} from "lucide-react";

import { useUpload } from "@/components/app/upload";
import { api } from "@/lib/api";
import { bytes, day } from "@/lib/format";
import { mmss } from "@/lib/studio";
import type { Video } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

interface VideoItem {
  id: string;
  title: string;
  duration: string;
  date: string;
  size: string;
  thumbnail: string;
  status: "published" | "queued" | "draft" | "archived";
  platforms: Array<"tiktok" | "instagram" | "youtube" | "linkedin" | "x">;
}

type ApiVideo = Video & { publish?: { state: "published" | "queued" | "draft"; platforms: VideoItem["platforms"] } };

function toVideo(v: ApiVideo, archived = false): VideoItem {
  return {
    id: v.id,
    title: v.status === "ready" || archived ? v.title : `${v.title} (${v.status === "failed" || v.status === "rejected" ? "falhou" : "processando"})`,
    duration: mmss(v.duration_s),
    date: day(v.created_at),
    size: bytes(v.size_bytes),
    thumbnail: v.thumbnail_url ?? "",
    status: archived ? "archived" : (v.publish?.state ?? "draft"),
    platforms: v.publish?.platforms ?? [],
  };
}

type TabType = "all" | "published" | "queued" | "draft" | "archived";

export default function VideosPage() {
  const [isVideosOpen, setIsVideosOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const openUpload = useUpload();
  const active = useApi<{ items: ApiVideo[] }>("/api/v1/videos?limit=100", { refreshMs: 15000 });
  const trash = useApi<{ items: ApiVideo[] }>("/api/v1/videos?trash=true&limit=100");
  const allVideos = useMemo(
    () => [...(active.data?.items ?? []).map((v) => toVideo(v)), ...(trash.data?.items ?? []).map((v) => toVideo(v, true))],
    [active.data, trash.data],
  );
  const loaded = active.data !== undefined;
  const count = (st: VideoItem["status"] | "all") =>
    st === "all" ? allVideos.filter((v) => v.status !== "archived").length : allVideos.filter((v) => v.status === st).length;

  const restore = async (id: string) => {
    try {
      await api(`/api/v1/videos/${id}/restore`, { method: "POST" });
      await Promise.all([active.reload(), trash.reload()]);
    } catch {
      /* o vídeo pode ter sido apagado de vez */
    }
  };

  // Filtro dinâmico
  const filteredVideos = useMemo(() => {
    return allVideos.filter((v) => {
      if (activeTab === "all" && v.status === "archived") return false;
      // Filtro por tab
      if (activeTab === "published" && v.status !== "published") return false;
      if (activeTab === "queued" && v.status !== "queued") return false;
      if (activeTab === "draft" && v.status !== "draft") return false;
      if (activeTab === "archived" && v.status !== "archived") return false;

      // Filtro por texto
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          v.title.toLowerCase().includes(q) ||
          v.date.toLowerCase().includes(q) ||
          v.size.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [allVideos, activeTab, searchQuery]);

  const toggleSelect = (id: string) => {
    setSelectedVideos((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  return (
    <div className="min-h-screen w-full bg-[#030914] text-[#d6e2f0] antialiased select-none font-sans">
      {/* =========================================================================
          SIDEBAR FIXA À ESQUERDA (270px) - ATIVA EM MEUS VÍDEOS
         ========================================================================= */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-[270px] flex-col justify-between border-r border-[#0f1f35] bg-[#040d1a]">
        <div>
          {/* Topo da Sidebar: Logo Clipo e Botão de Recolher (ChevronsLeft) */}
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

          {/* Botão Início (Estilo normal quando em /videos) */}
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

              {/* Item Accordion: Vídeos (Pill ativo ou destacado) */}
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
                    className={`h-4 w-4 text-[#7187a5] transition-transform duration-200 ${isVideosOpen ? "rotate-0" : "-rotate-90"
                      }`}
                  />
                </button>

                {/* Sub-árvore de Vídeos */}
                <div
                  className={`grid transition-all duration-200 ease-in-out ${isVideosOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"
                    }`}
                >
                  <div className="overflow-hidden">
                    <div className="relative ml-4 pl-4 pt-2 pb-1 before:absolute before:top-2.5 before:bottom-2.5 before:left-[3px] before:w-px before:bg-[#1d4273]">
                      <ul className="space-y-2.5 text-[13px]">
                        {/* Meus vídeos (Item ativo com glow) */}
                        <li className="relative flex items-center text-white font-semibold">
                          <span className="absolute -left-[18px] h-2.5 w-2.5 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_10px_#3b82f6]" />
                          <Link href="/videos" className="py-0.5 text-[#60a5fa]">
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
        {/* HEADER: Busca Superior, Notificações, Título "Meus vídeos", Banner e Ações */}
        <header className="relative px-8 pt-5 pb-3">
          {/* Linha 1: Input de Busca e Notificações */}
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar vídeos, títulos, hashtags..."
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

          {/* Linha 2: Banner de Título com Montanhas ao Fundo e Botões de Ação à Direita */}
          <div className="relative mt-4 flex items-center justify-between min-h-[90px] rounded-2xl overflow-hidden px-4">
            {/* Montanhas Azuis Iluminadas no Background com Fade Out para a Esquerda */}
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
              <h1 className="text-[26px] font-extrabold tracking-tight text-white">
                Meus vídeos
              </h1>
              <p className="mt-1 text-sm font-medium text-[#8fa2be]">
                Gerencie, edite e organize todo o seu conteúdo.
              </p>
            </div>

            {/* Ações à Direita: Alternador Grade/Lista e Botão Enviar Vídeo */}
            <div className="relative z-10 flex items-center gap-3">
              {/* Botões Grid / List */}
              <div className="flex items-center rounded-xl border border-[#162c47] bg-[#08162a] p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${viewMode === "grid"
                    ? "bg-[#0d62f7] text-white shadow-[0_0_12px_rgba(13,98,247,0.5)]"
                    : "text-[#5e779d] hover:text-white"
                    }`}
                  aria-label="Visualização em Grade"
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${viewMode === "list"
                    ? "bg-[#0d62f7] text-white shadow-[0_0_12px_rgba(13,98,247,0.5)]"
                    : "text-[#5e779d] hover:text-white"
                    }`}
                  aria-label="Visualização em Lista"
                >
                  <List className="h-4 w-4" />
                </button>
              </div>

              {/* Botão Primário: Enviar vídeo */}
              <button
                type="button"
                onClick={openUpload}
                className="flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0d5cf5] via-[#1668f8] to-[#1e74ff] px-4 font-semibold text-white shadow-[0_0_20px_rgba(13,92,245,0.45)] transition hover:brightness-110 active:scale-95"
              >
                <Upload className="h-4 w-4" />
                <span className="text-sm">Enviar vídeo</span>
              </button>
            </div>
          </div>
        </header>

        {/* CORPO PRINCIPAL */}
        <main className="px-8 pb-10 space-y-5">
          {/* BARRA DE FILTROS (TABS) & BUSCA DE VÍDEOS */}
          <div className="flex items-center justify-between border-b border-[#102035] pb-2">
            {/* Tabs */}
            <div className="flex items-center gap-6">
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className={`relative pb-3 text-sm font-semibold transition ${activeTab === "all"
                  ? "text-white"
                  : "text-[#7791b4] hover:text-[#c4d4eb]"
                  }`}
              >
                <span>Todos</span>
                <span className="ml-1.5 text-xs text-[#60a5fa]">{count("all")}</span>
                {activeTab === "all" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("published")}
                className={`relative pb-3 text-sm font-semibold transition ${activeTab === "published"
                  ? "text-white"
                  : "text-[#7791b4] hover:text-[#c4d4eb]"
                  }`}
              >
                <span>Publicados</span>
                <span className="ml-1.5 text-xs text-[#60a5fa]">{count("published")}</span>
                {activeTab === "published" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("queued")}
                className={`relative pb-3 text-sm font-semibold transition ${activeTab === "queued"
                  ? "text-white"
                  : "text-[#7791b4] hover:text-[#c4d4eb]"
                  }`}
              >
                <span>Na fila</span>
                <span className="ml-1.5 text-xs text-[#60a5fa]">{count("queued")}</span>
                {activeTab === "queued" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("draft")}
                className={`relative pb-3 text-sm font-semibold transition ${activeTab === "draft"
                  ? "text-white"
                  : "text-[#7791b4] hover:text-[#c4d4eb]"
                  }`}
              >
                <span>Rascunhos</span>
                <span className="ml-1.5 text-xs text-[#60a5fa]">{count("draft")}</span>
                {activeTab === "draft" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("archived")}
                className={`relative pb-3 text-sm font-semibold transition ${activeTab === "archived"
                  ? "text-white"
                  : "text-[#7791b4] hover:text-[#c4d4eb]"
                  }`}
              >
                <span>Arquivados</span>
                <span className="ml-1.5 text-xs text-[#60a5fa]">{count("archived")}</span>
                {activeTab === "archived" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>
            </div>

            {/* Input Buscar vídeos... */}
            <div className="relative w-64 pb-2">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar vídeos..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8.5 w-full rounded-xl border border-[#142944] bg-[#061222] pr-4 pl-9 text-xs text-[#cad5e6] placeholder:text-[#587194] focus:border-[#3b82f6] focus:outline-none transition"
              />
            </div>
          </div>

          {/* =====================================================================
              GRID DE VÍDEOS (4 COLUNAS) OU LISTA
             ===================================================================== */}
          {!loaded ? (
            <div className="grid grid-cols-4 gap-4" aria-busy="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-72 animate-pulse rounded-2xl border border-[#11233a] bg-[#05111f]" />
              ))}
            </div>
          ) : filteredVideos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <VideoIcon className="h-12 w-12 text-[#3b82f6]/40" />
              <p className="mt-3 text-base font-semibold text-white">
                {allVideos.length ? "Nenhum vídeo encontrado" : "Você ainda não enviou vídeos"}
              </p>
              <p className="text-xs text-[#6e87a8] mt-1">
                {allVideos.length ? "Tente ajustar seus filtros de busca." : "Clique em Enviar vídeo para começar."}
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-4 gap-4">
              {filteredVideos.map((video) => {
                const isSelected = selectedVideos.includes(video.id);

                return (
                  <div
                    key={video.id}
                    className="group relative flex flex-col justify-between rounded-2xl border border-[#11233a] bg-[#05111f] p-3 shadow-[0_6px_25px_rgba(0,0,0,0.4)] transition hover:border-[#1e4375] hover:shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
                  >
                    {/* THUMBNAIL COM DURAÇÃO, CHECKBOX E MENU */}
                    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-[#142a47] bg-[#020712]">
                      {video.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada
                        <img src={video.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                      ) : null}

                      {/* Checkbox no topo esquerdo */}
                      <button
                        type="button"
                        onClick={() => toggleSelect(video.id)}
                        className={`absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded-md border transition backdrop-blur-md ${isSelected
                          ? "border-[#3b82f6] bg-[#3b82f6] text-white shadow-[0_0_8px_#3b82f6]"
                          : "border-[#ffffff]/30 bg-black/40 text-transparent hover:border-white"
                          }`}
                        aria-label="Selecionar vídeo"
                      >
                        <Check className="h-3.5 w-3.5 stroke-[3]" />
                      </button>

                      {/* Botão Mais Opções no topo direito */}
                      {video.status === "archived" ? (
                        <button type="button" onClick={() => void restore(video.id)} className="absolute top-2 right-2 flex h-6 items-center rounded-md bg-black/60 px-2 text-[11px] font-semibold text-white backdrop-blur-md hover:bg-black/90">
                          Restaurar
                        </button>
                      ) : (
                        <Link href={`/videos/${video.id}`} className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-md transition hover:bg-black/90" aria-label={`Abrir ${video.title} no editor`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Link>
                      )}

                      {/* Badge de Duração no canto inferior direito */}
                      <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-bold text-white tracking-wide backdrop-blur-md">
                        {video.duration}
                      </span>
                    </div>

                    {/* CONTEÚDO DO CARD */}
                    <div className="mt-3 flex-1 flex flex-col justify-between">
                      <div>
                        {/* Título do vídeo */}
                        <h3 className="line-clamp-2 text-[13.5px] font-bold text-white leading-snug group-hover:text-[#60a5fa] transition">
                          {video.status === "archived" ? video.title : <Link href={`/videos/${video.id}`}>{video.title}</Link>}
                        </h3>

                        {/* Metadados: Data e Tamanho */}
                        <p className="mt-1.5 text-xs text-[#6e87a8]">
                          <span>{video.date}</span>
                          <span className="mx-1.5 text-[#374e6d]">•</span>
                          <span>{video.size}</span>
                        </p>
                      </div>

                      {/* RODAPÉ DO CARD: REDES SOCIAIS & STATUS BADGE */}
                      <div className="mt-3.5 flex items-center justify-between border-t border-[#0d1e33] pt-2.5">
                        {/* Ícones das Redes Sociais */}
                        <div className="flex items-center gap-1.5">
                          {video.platforms.includes("tiktok") && (
                            <span
                              className="flex h-5 w-5 items-center justify-center rounded bg-black text-[10px] font-bold text-white border border-[#1e2e42]"
                              title="TikTok"
                            >
                              t
                            </span>
                          )}
                          {video.platforms.includes("instagram") && (
                            <span
                              className="flex h-5 w-5 items-center justify-center rounded bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-[10px] font-bold text-white"
                              title="Instagram"
                            >
                              i
                            </span>
                          )}
                          {video.platforms.includes("youtube") && (
                            <span
                              className="flex h-5 w-5 items-center justify-center rounded bg-[#ff0000] text-[10px] font-bold text-white"
                              title="YouTube"
                            >
                              y
                            </span>
                          )}
                          {video.platforms.includes("x") && (
                            <span
                              className="flex h-5 w-5 items-center justify-center rounded bg-black text-[10px] font-bold text-white border border-[#1e2e42]"
                              title="X"
                            >
                              𝕏
                            </span>
                          )}
                          {video.platforms.includes("linkedin") && (
                            <span
                              className="flex h-5 w-5 items-center justify-center rounded bg-[#0077b5] text-[10px] font-bold text-white"
                              title="LinkedIn"
                            >
                              in
                            </span>
                          )}
                        </div>

                        {/* Status Badge */}
                        {video.status === "published" && (
                          <span className="flex items-center gap-1 rounded-full border border-[#065f46] bg-[#064e3b]/35 px-2.5 py-0.5 text-[11px] font-bold text-[#10b981]">
                            <Check className="h-3 w-3 stroke-[2.5]" />
                            <span>Publicado</span>
                          </span>
                        )}

                        {video.status === "queued" && (
                          <span className="flex items-center gap-1 rounded-full border border-[#1e3a5f] bg-[#0d223a] px-2.5 py-0.5 text-[11px] font-semibold text-[#8fa2be]">
                            <Clock className="h-3 w-3 text-[#547399]" />
                            <span>Na fila</span>
                          </span>
                        )}

                        {video.status === "draft" && (
                          <span className="flex items-center gap-1 rounded-full border border-[#78350f] bg-[#451a03]/40 px-2.5 py-0.5 text-[11px] font-semibold text-[#f59e0b]">
                            <FileText className="h-3 w-3 text-[#f59e0b]" />
                            <span>Rascunho</span>
                          </span>
                        )}

                        {video.status === "archived" && (
                          <span className="flex items-center gap-1 rounded-full border border-[#374151] bg-[#1f2937]/50 px-2.5 py-0.5 text-[11px] font-semibold text-[#9ca3af]">
                            <span>Arquivado</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* MODO LISTA */
            <div className="space-y-2">
              {filteredVideos.map((video) => (
                <div
                  key={video.id}
                  className="flex items-center justify-between rounded-xl border border-[#11233a] bg-[#05111f] p-3 transition hover:border-[#1e4375]"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg border border-[#142a47]">
                      {video.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada
                        <img src={video.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover" />
                      ) : null}
                      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] font-bold text-white">
                        {video.duration}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-white">
                        {video.status === "archived" ? video.title : <Link href={`/videos/${video.id}`}>{video.title}</Link>}
                      </p>
                      <p className="mt-1 text-xs text-[#6e87a8]">
                        {video.date} • {video.size}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-1.5">
                      {video.platforms.map((p) => (
                        <span
                          key={p}
                          className="flex h-5 w-5 items-center justify-center rounded bg-[#09182d] text-[10px] font-bold text-white"
                        >
                          {p[0].toUpperCase()}
                        </span>
                      ))}
                    </div>

                    {video.status === "published" && (
                      <span className="rounded-full border border-[#065f46] bg-[#064e3b]/35 px-2.5 py-0.5 text-[11px] font-bold text-[#10b981]">
                        Publicado
                      </span>
                    )}
                    {video.status === "queued" && (
                      <span className="rounded-full border border-[#1e3a5f] bg-[#0d223a] px-2.5 py-0.5 text-[11px] font-semibold text-[#8fa2be]">
                        Na fila
                      </span>
                    )}
                    {video.status === "draft" && (
                      <span className="rounded-full border border-[#78350f] bg-[#451a03]/40 px-2.5 py-0.5 text-[11px] font-semibold text-[#f59e0b]">
                        Rascunho
                      </span>
                    )}

                    {video.status === "archived" ? (
                      <button type="button" onClick={() => void restore(video.id)} className="p-1 text-xs font-semibold text-[#546e8f] hover:text-white">Restaurar</button>
                    ) : (
                      <Link href={`/videos/${video.id}`} className="p-1 text-[#546e8f] hover:text-white" aria-label={`Abrir ${video.title} no editor`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {/* =========================================================================
          MODAL DE UPLOAD DE VÍDEO
         ========================================================================= */}
    </div>
  );
}

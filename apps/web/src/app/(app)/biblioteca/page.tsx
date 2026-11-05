"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Download,
  ExternalLink,
  Film,
  Filter,
  Flame,
  FolderOpen,
  HardDrive,
  Layers,
  LayoutDashboard,
  Mic,
  MoreHorizontal,
  Music,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Tag,
  TrendingUp,
  Upload,
  Video as VideoIcon,
  Volume2,
  VolumeX,
  X as CloseIcon,
  Zap,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { bytes } from "@/lib/format";
import { contentTypeOf, putFile } from "@/lib/put-file";
import { type ApiAsset, type AssetList, mmss } from "@/lib/studio";
import type { Usage } from "@/lib/types";
import { useApi } from "@/lib/use-api";

type AssetType = "video" | "audio" | "sfx" | "overlay" | "preset";

interface Asset {
  id: string;
  name: string;
  type: AssetType;
  category: string;
  duration: string;
  size: string;
  resolution?: string;
  bpm?: number;
  tags: string[];
  thumbnail?: string;
  isTrending?: boolean;
  usageCount: number;
  fileUrl: string | null;
  failed: boolean;
}

function toAsset(a: ApiAsset): Asset {
  const resolution =
    a.width && a.height ? `${a.width}x${a.height}${a.fps ? ` ${a.fps}fps` : ""}` : undefined;
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    category: a.category,
    duration: a.status === "ready" ? mmss(a.duration_s) : a.status === "failed" ? "Erro" : "...",
    size: bytes(a.size_bytes),
    resolution: a.status === "ready" ? resolution : a.status === "failed" ? "Falhou" : "Processando",
    bpm: a.bpm ?? undefined,
    tags: a.tags,
    thumbnail: a.thumb_url ?? undefined,
    isTrending: a.trending,
    usageCount: a.usage_count,
    fileUrl: a.file_url,
    failed: a.status === "failed",
  };
}

const TYPE_BY_MIME = (type: string): ApiAsset["type"] =>
  type.startsWith("audio/") ? "audio" : type.startsWith("image/") ? "overlay" : type.startsWith("video/") ? "video" : "preset";

type UploadRow = { name: string; progress: number; error?: string };

type TabFilter = "all" | "video" | "audio" | "sfx" | "overlay";

export default function BibliotecaPage() {
  const [isVideosOpen, setIsVideosOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const [popular, setPopular] = useState(false);
  const [uploadType, setUploadType] = useState<ApiAsset["type"] | "auto">("auto");
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data, error, loading, reload } = useApi<AssetList>(`/api/v1/assets?sort=${popular ? "popular" : "recent"}`, {
    refreshMs: 8000,
  });
  const assets = useMemo(() => (data?.items ?? []).map(toAsset), [data]);
  const counts = data?.counts;
  const usage = useApi<{ usage: Usage }>("/api/v1/usage");
  const usedPct = usage.data ? Math.min(100, Math.round((usage.data.usage.storage_used_bytes / Math.max(1, usage.data.usage.storage_limit_bytes)) * 100)) : 0;
  const playing = assets.find((a) => a.id === playingAudioId);

  const togglePlayAudio = (id: string) => {
    if (playingAudioId === id) {
      setPlayingAudioId(null);
    } else {
      setPlayingAudioId(id);
    }
  };

  // "Usar": conta o uso (alimenta "mais usados" e "em alta") e abre o arquivo para baixar.
  const removeAsset = async (asset: Asset) => {
    if (!window.confirm(`Apagar "${asset.name}" da biblioteca?`)) return;
    try {
      await api(`/api/v1/assets/${asset.id}`, { method: "DELETE" });
      void reload();
      showToast("Ativo apagado.");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Não foi possível apagar.");
    }
  };

  const markUsed = async (asset: Asset) => {
    if (asset.failed) {
      void removeAsset(asset);
      return;
    }
    try {
      await api(`/api/v1/assets/${asset.id}/use`, { method: "POST" });
      if (asset.fileUrl) window.open(asset.fileUrl, "_blank", "noopener");
      showToast(`"${asset.name}" marcado como usado.`);
      void reload();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Não foi possível usar o ativo.");
    }
  };

  const sendFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    setUploads(list.map((f) => ({ name: f.name, progress: 0 })));
    let ok = 0;
    for (const [i, file] of list.entries()) {
      const update = (patch: Partial<UploadRow>) =>
        setUploads((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
      try {
        const contentType = contentTypeOf(file);
        const type = uploadType === "auto" ? TYPE_BY_MIME(contentType) : uploadType;
        const started = await api<{ asset: ApiAsset; upload_url: string }>("/api/v1/assets/uploads", {
          method: "POST",
          body: { filename: file.name, size_bytes: file.size, content_type: contentType, type },
        });
        await putFile(started.upload_url, file, contentType, (f) => update({ progress: f }));
        await api(`/api/v1/assets/${started.asset.id}/complete`, { method: "POST" });
        update({ progress: 1 });
        ok += 1;
      } catch (err) {
        update({ error: err instanceof ApiError || err instanceof Error ? err.message : "Falhou." });
      }
    }
    void reload();
    if (ok === list.length) {
      setUploadModalOpen(false);
      setUploads([]);
      showToast(`${ok} ativo(s) enviado(s). O processamento termina em instantes.`);
    }
  };

  const filteredAssets = useMemo(() => {
    return assets.filter((item) => {
      if (activeTab !== "all" && item.type !== activeTab) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q) ||
          item.tags.some((t) => t.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [assets, activeTab, searchQuery]);

  return (
    <div className="min-h-screen w-full bg-[#030914] text-[#d6e2f0] antialiased select-none font-sans">
      {/* =========================================================================
          SIDEBAR FIXA À ESQUERDA (270px) - ATIVA EM BIBLIOTECA
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
                        <li className="relative flex items-center text-[#8fa2be] hover:text-white transition">
                          <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6]/70 shadow-[0_0_6px_#3b82f6]" />
                          <Link href="/fila" className="py-0.5">
                            Fila de publicação
                          </Link>
                        </li>
                        {/* Biblioteca (ITEM ATIVO COM GLOW) */}
                        <li className="relative flex items-center text-white font-semibold">
                          <span className="absolute -left-[18px] h-2.5 w-2.5 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_10px_#3b82f6]" />
                          <Link href="/biblioteca" className="py-0.5 text-[#60a5fa]">
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
        {/* HEADER: Busca Superior, Notificações, Título, Banner e Armazenamento */}
        <header className="relative px-8 pt-5 pb-3">
          {/* Linha 1: Input de Busca e Notificações */}
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar B-rolls, trilhas, efeitos sonoros, memes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
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

          {/* Linha 2: Banner da Biblioteca com Montanhas e Medidor de Armazenamento */}
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
                  Biblioteca de Ativos
                </h1>
                <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#60a5fa] backdrop-blur-md">
                  {counts?.all ?? 0} itens
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-[#8fa2be]">
                Acervo de B-rolls, efeitos sonoros (SFX), trilhas virais e overlays para cortes dinâmicos.
              </p>
            </div>

            {/* Ações e Armazenamento à Direita */}
            <div className="relative z-10 flex items-center gap-4">
              {/* Widget de Armazenamento do Plano */}
              <div className="hidden lg:flex flex-col items-end rounded-xl border border-[#162c47] bg-[#061426]/90 p-2.5 backdrop-blur-md">
                <div className="flex items-center gap-2 text-xs">
                  <HardDrive className="h-3.5 w-3.5 text-[#3b82f6]" />
                  <span className="font-semibold text-white">{bytes(usage.data?.usage.storage_used_bytes)}</span>
                  <span className="text-[#6e87a8]">/ {bytes(usage.data?.usage.storage_limit_bytes)}</span>
                </div>
                {/* Barra de Progresso com Glow */}
                <div className="mt-1.5 h-1.5 w-32 rounded-full bg-[#0d2138] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#2563eb] to-[#38bdf8] shadow-[0_0_6px_#38bdf8]"
                    style={{ width: `${usedPct}%` }}
                  />
                </div>
              </div>

              {/* Botão Primário: Adicionar ativo */}
              <button
                type="button"
                onClick={() => setUploadModalOpen(true)}
                className="flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0d5cf5] via-[#1668f8] to-[#1e74ff] px-4 font-semibold text-white shadow-[0_0_20px_rgba(13,92,245,0.45)] transition hover:brightness-110 active:scale-95 cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span className="text-sm">Adicionar ativo</span>
              </button>
            </div>
          </div>
        </header>

        {/* CORPO PRINCIPAL */}
        <main className="px-8 pb-10 space-y-6">
          {/* =====================================================================
              BARRA DE CATEGORIAS DA BIBLIOTECA (TABS COM ÍCONES E CONTADORES)
             ===================================================================== */}
          <div className="flex items-center justify-between border-b border-[#102035] pb-2">
            <div className="flex items-center gap-7">
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className={`relative pb-3 text-sm font-semibold transition flex items-center gap-2 ${
                  activeTab === "all" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <FolderOpen className="h-4 w-4" />
                <span>Todos</span>
                <span className="rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {counts?.all ?? 0}
                </span>
                {activeTab === "all" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("video")}
                className={`relative pb-3 text-sm font-semibold transition flex items-center gap-2 ${
                  activeTab === "video" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <Film className="h-4 w-4" />
                <span>B-Rolls & Clipes</span>
                <span className="rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {counts?.video ?? 0}
                </span>
                {activeTab === "video" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("sfx")}
                className={`relative pb-3 text-sm font-semibold transition flex items-center gap-2 ${
                  activeTab === "sfx" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <Volume2 className="h-4 w-4" />
                <span>Efeitos Sonoros (SFX)</span>
                <span className="rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {counts?.sfx ?? 0}
                </span>
                {activeTab === "sfx" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("audio")}
                className={`relative pb-3 text-sm font-semibold transition flex items-center gap-2 ${
                  activeTab === "audio" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <Music className="h-4 w-4" />
                <span>Trilhas Musicais</span>
                <span className="rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {counts?.audio ?? 0}
                </span>
                {activeTab === "audio" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("overlay")}
                className={`relative pb-3 text-sm font-semibold transition flex items-center gap-2 ${
                  activeTab === "overlay" ? "text-white" : "text-[#7791b4] hover:text-[#c4d4eb]"
                }`}
              >
                <Layers className="h-4 w-4" />
                <span>Overlays & Memes</span>
                <span className="rounded-full bg-[#0c2444] px-2 py-0.5 text-xs text-[#60a5fa] font-bold">
                  {counts?.overlay ?? 0}
                </span>
                {activeTab === "overlay" && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                )}
              </button>
            </div>

            {/* Filtros Auxiliares */}
            <div className="flex items-center gap-2 pb-2">
              <button
                type="button"
                aria-pressed={popular}
                onClick={() => setPopular((v) => !v)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                  popular ? "border-[#2563eb] bg-[#0c2444] text-white" : "border-[#162c47] bg-[#071629] text-[#8fa2be] hover:text-white"
                }`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5 text-[#3b82f6]" />
                <span>{popular ? "Mais usados" : "Mais recentes"}</span>
              </button>
            </div>
          </div>

          {/* =====================================================================
              GRID DIFERENCIADO DE ATIVOS (CARDS DE B-ROLL + AUDIO WAVEFORMS + OVERLAYS)
             ===================================================================== */}
          {loading && !data ? (
            <div className="grid grid-cols-12 gap-5" aria-busy="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="col-span-3 h-56 animate-pulse rounded-2xl border border-[#11233a] bg-[#05111f]" />
              ))}
            </div>
          ) : error && !data ? (
            <div role="alert" className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-base font-semibold text-white">Não foi possível carregar a biblioteca</p>
              <p className="text-xs text-[#6e87a8] mt-1">{error.message}</p>
              <button type="button" onClick={() => void reload()} className="mt-4 rounded-xl border border-[#162c47] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:text-white cursor-pointer">
                Tentar de novo
              </button>
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <FolderOpen className="h-12 w-12 text-[#3b82f6]/40" />
              <p className="mt-3 text-base font-semibold text-white">
                {assets.length ? "Nenhum ativo encontrado" : "Sua biblioteca está vazia"}
              </p>
              <p className="text-xs text-[#6e87a8] mt-1">
                {assets.length ? "Tente pesquisar com outros termos." : "Importe B-rolls, trilhas, efeitos sonoros e overlays."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-12 gap-5">
              {filteredAssets.map((asset) => {
                // =============================================================
                // RENDERIZADOR 1: ATIVOS DE ÁUDIO & EFEITOS SONOROS (SFX)
                // Possui Waveform SVG Interativo, Player e Controle de BPM
                // =============================================================
                if (asset.type === "audio" || asset.type === "sfx") {
                  const isPlaying = playingAudioId === asset.id;

                  return (
                    <div
                      key={asset.id}
                      className={`col-span-6 rounded-2xl border transition p-4 flex flex-col justify-between shadow-[0_6px_25px_rgba(0,0,0,0.4)] ${
                        isPlaying
                          ? "border-[#2563eb] bg-gradient-to-r from-[#071933] to-[#05111f] shadow-[0_0_20px_rgba(37,99,235,0.2)]"
                          : "border-[#11233a] bg-[#05111f] hover:border-[#1a385f]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Botão Play / Pause com Glow */}
                          <button
                            type="button"
                            onClick={() => togglePlayAudio(asset.id)}
                            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition ${
                              isPlaying
                                ? "bg-[#2563eb] text-white shadow-[0_0_15px_#2563eb]"
                                : "bg-[#0b213d] text-[#60a5fa] hover:bg-[#13325c] hover:text-white"
                            }`}
                            aria-label={isPlaying ? "Pausar" : "Ouvir"}
                          >
                            {isPlaying ? (
                              <Pause className="h-5 w-5" />
                            ) : (
                              <Play className="h-5 w-5 ml-0.5" />
                            )}
                          </button>

                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-[#0c2240] px-2 py-0.5 text-[10px] font-bold text-[#60a5fa]">
                                {asset.category}
                              </span>
                              {asset.isTrending && (
                                <span className="flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-[#f59e0b]">
                                  <Flame className="h-3 w-3" />
                                  <span>Viral</span>
                                </span>
                              )}
                              {asset.bpm && (
                                <span className="text-[10px] text-[#546e8f] font-mono">
                                  {asset.bpm} BPM
                                </span>
                              )}
                            </div>
                            <h4 className="mt-1 truncate text-sm font-bold text-white">
                              {asset.name}
                            </h4>
                          </div>
                        </div>

                        {/* Metadados: Duração e Ações */}
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-[#6e87a8]">
                            {asset.duration}
                          </span>
                          <button
                            type="button"
                            onClick={() => void markUsed(asset)}
                            className="flex h-8 items-center gap-1 rounded-lg border border-[#162c47] bg-[#071629] px-2.5 text-xs font-semibold text-[#60a5fa] hover:border-[#2563eb] hover:text-white transition cursor-pointer"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            <span>{asset.failed ? "Remover" : "Usar"}</span>
                          </button>
                        </div>
                      </div>

                      {/* Waveform SVG Dinâmica */}
                      <div className="mt-3.5 flex items-center gap-1 h-9 px-2 rounded-lg bg-[#030914] border border-[#0d1e33]">
                        {Array.from({ length: 42 }).map((_, barIdx) => {
                          // Gera barras de onda estilizadas com animação de playback se ativo
                          const heightSeed = ((barIdx * 7 + 13) % 28) + 8;
                          const activeColor =
                            isPlaying && barIdx < 22
                              ? "bg-[#38bdf8] shadow-[0_0_6px_#38bdf8]"
                              : isPlaying
                              ? "bg-[#1d4ed8]"
                              : "bg-[#1d3557]";

                          return (
                            <div
                              key={barIdx}
                              className={`w-1 rounded-full transition-all duration-150 ${activeColor}`}
                              style={{ height: `${heightSeed}px` }}
                            />
                          );
                        })}
                      </div>

                      {/* Tags e Usos */}
                      <div className="mt-3 flex items-center justify-between text-[11px] text-[#546e8f]">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {asset.tags.map((t) => (
                            <span key={t} className="rounded bg-[#081729] px-1.5 py-0.5 text-[#7791b4]">
                              #{t}
                            </span>
                          ))}
                        </div>
                        <span>Usado em {asset.usageCount} cortes</span>
                      </div>
                    </div>
                  );
                }

                // =============================================================
                // RENDERIZADOR 2: ATIVOS VISUAIS (B-ROLLS, VÍDEOS, OVERLAYS)
                // Thumbnail cinematográfica com aspecto 16:9 widescreen, hover player e tags
                // =============================================================
                return (
                  <div
                    key={asset.id}
                    className="group col-span-3 rounded-2xl border border-[#11233a] bg-[#05111f] p-3 shadow-[0_6px_25px_rgba(0,0,0,0.4)] transition hover:border-[#1e4375] hover:shadow-[0_8px_30px_rgba(0,0,0,0.6)] flex flex-col justify-between"
                  >
                    <div>
                      {/* Thumbnail com Preview e Tags */}
                      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-[#142a47] bg-[#020712]">
                        {asset.thumbnail && (
                          // eslint-disable-next-line @next/next/no-img-element -- miniatura por URL assinada
                          <img
                            src={asset.thumbnail}
                            alt=""
                            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        )}

                        {/* Tag de Tipo / Resolução */}
                        <div className="absolute top-2 left-2 flex items-center gap-1.5">
                          <span className="rounded-md bg-black/80 px-2 py-0.5 text-[10px] font-bold text-[#60a5fa] backdrop-blur-md border border-white/10">
                            {asset.resolution || asset.category}
                          </span>
                        </div>

                        {/* Botão de Play Hover Central */}
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/40 backdrop-blur-xs">
                          <button
                            type="button"
                            onClick={() => asset.fileUrl && window.open(asset.fileUrl, "_blank", "noopener")}
                            aria-label={`Ver prévia de ${asset.name}`}
                            className="flex h-11 w-11 items-center justify-center rounded-full bg-[#0d5cf5] text-white shadow-[0_0_15px_#0d5cf5] transition hover:scale-110 cursor-pointer"
                          >
                            <Play className="h-5 w-5 ml-0.5" />
                          </button>
                        </div>

                        {/* Duração no canto inferior direito */}
                        <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-bold text-white tracking-wide backdrop-blur-md">
                          {asset.duration}
                        </span>
                      </div>

                      {/* Nome do Ativo */}
                      <h4 className="mt-3 line-clamp-2 text-sm font-bold text-white group-hover:text-[#60a5fa] transition leading-snug">
                        {asset.name}
                      </h4>

                      {/* Metadados: Categoria e Tamanho */}
                      <p className="mt-1 text-xs text-[#6e87a8]">
                        <span>{asset.category}</span>
                        <span className="mx-1.5 text-[#374e6d]">•</span>
                        <span>{asset.size}</span>
                      </p>
                    </div>

                    {/* Rodapé do Card: Tags e Botão Usar */}
                    <div className="mt-3 flex items-center justify-between border-t border-[#0d1e33] pt-2.5">
                      <span className="text-[11px] text-[#546e8f]">
                        {asset.usageCount} usos
                      </span>

                      <button
                        type="button"
                        onClick={() => void markUsed(asset)}
                        className="flex items-center gap-1 rounded-lg border border-[#162c47] bg-[#071629] px-2.5 py-1 text-xs font-semibold text-[#60a5fa] hover:border-[#2563eb] hover:bg-[#0c2444] hover:text-white transition cursor-pointer"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>{asset.failed ? "Remover" : "Usar"}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      {playing?.fileUrl && (
        <audio key={playing.id} src={playing.fileUrl} autoPlay onEnded={() => setPlayingAudioId(null)} className="hidden" />
      )}

      {/* TOAST FLUTUANTE */}
      {toastMessage && (
        <div className="fixed bottom-6 right-8 z-50 flex items-center gap-2.5 rounded-xl border border-[#1d4ed8] bg-[#091b33] px-4 py-3 text-xs font-semibold text-white shadow-2xl animate-fade-in">
          <Check className="h-4 w-4 text-[#10b981]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* MODAL DE ADICIONAR ATIVO */}
      {uploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[#19355b] bg-[#05111f] p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-[#0f223a]">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/20 text-[#3b82f6]">
                  <Upload className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Importar para a Biblioteca</h3>
                  <p className="text-xs text-[#6e87a8]">B-Rolls, Áudios (MP3/WAV), Overlays ou SFX</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUploadModalOpen(false)}
                className="rounded-lg p-1.5 text-[#546e8f] hover:bg-[#0c1f38] hover:text-white cursor-pointer"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>

            <label className="mt-5 block text-xs font-semibold text-[#8fa2be]">
              Tipo dos arquivos
              <Select
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value as ApiAsset["type"] | "auto")}
                className="mt-1.5 h-10 w-full rounded-xl border border-[#162942] bg-[#061120] px-3 text-[13px] text-[#cad5e6] focus:border-[#3b82f6] focus:outline-none"
              >
                <option value="auto">Detectar pelo formato</option>
                <option value="video">B-roll (vídeo)</option>
                <option value="audio">Trilha sonora</option>
                <option value="sfx">Efeito sonoro</option>
                <option value="overlay">Overlay (vídeo ou PNG)</option>
                <option value="preset">Preset (.cube ou .json)</option>
              </Select>
            </label>

            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void sendFiles(e.dataTransfer.files);
              }}
              className="mt-4 flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-[#1d3c66] bg-[#030914] p-8 text-center hover:border-[#3b82f6] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-[#3b82f6]"
            >
              <Upload className="h-10 w-10 text-[#3b82f6]" />
              <span className="mt-3 text-sm font-semibold text-white">Arraste seus ativos aqui ou clique para escolher</span>
              <span className="mt-1 text-xs text-[#546e8f]">
                Vídeos MP4/MOV, áudios WAV/MP3 ou imagens PNG, até 500 MB cada
              </span>
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              accept="video/*,audio/*,image/png,image/webp,image/gif,.cube,.json"
              onChange={(e) => {
                void sendFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {uploads.length > 0 && (
              <ul className="mt-4 space-y-2" aria-live="polite">
                {uploads.map((u) => (
                  <li key={u.name} className="text-xs">
                    <div className="flex justify-between gap-3 text-[#c4d4eb]">
                      <span className="truncate">{u.name}</span>
                      <span className={u.error ? "text-[#f87171]" : "text-[#60a5fa]"}>
                        {u.error ?? `${Math.round(u.progress * 100)}%`}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#0c1f38]">
                      <div className={`h-full ${u.error ? "bg-[#f87171]" : "bg-[#3b82f6]"}`} style={{ width: `${Math.round(u.progress * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setUploadModalOpen(false);
                  setUploads([]);
                }}
                className="rounded-xl border border-[#162c47] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#09182d] hover:text-white transition cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

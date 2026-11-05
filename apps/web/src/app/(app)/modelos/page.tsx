"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Copy,
  Edit2,
  Eye,
  Filter,
  Flame,
  Globe,
  HardDrive,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Lightbulb,
  MoreHorizontal,
  Palette,
  Play,
  Plus,
  Radio,
  Search,
  Settings,
  Sliders,
  Sparkles,
  Type,
  Video as VideoIcon,
  Volume2,
  Wand2,
  Zap,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { type Caption, type Template } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface ModelTemplate {
  id: string;
  name: string;
  category: "legendas" | "ritmo" | "cores" | "audio";
  categoryLabel: string;
  description: string;
  aspectRatio: "9:16 Vertical" | "16:9 Horizontal" | "Ambos";
  fontFamily: string;
  highlightColor: string;
  animationStyle: string;
  pacingCutSpeed: string;
  soundFxPreset: string;
  isDefault: boolean;
  usageCount: number;
  previewBgGradient: string;
  sampleCaptionText: string;
  accentHex: string;
}

const GRADIENT: Record<Template["category"], string> = {
  legendas: "from-[#03152e] via-[#052247] to-[#010915]",
  ritmo: "from-[#0b1d2f] via-[#0f2a44] to-[#030914]",
  cores: "from-[#1e1b4b] via-[#312e81] to-[#0f0c29]",
  audio: "from-[#062a2a] via-[#0b3b3b] to-[#021212]",
};
const ASPECT: Record<Template["aspect"], ModelTemplate["aspectRatio"]> = {
  "9:16": "9:16 Vertical",
  "16:9": "16:9 Horizontal",
  both: "Ambos",
};

function toModel(t: Template): ModelTemplate {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    categoryLabel: t.category_label,
    description: t.description,
    aspectRatio: ASPECT[t.aspect],
    fontFamily: t.font_label,
    highlightColor: t.caption.highlight ?? t.caption.color,
    animationStyle: t.animation,
    pacingCutSpeed: `${t.pacing_label} (${t.cut_seconds.toLocaleString("pt-BR")}s)`,
    soundFxPreset: t.sfx,
    isDefault: t.is_default,
    usageCount: t.usage_count,
    previewBgGradient: GRADIENT[t.category],
    sampleCaptionText: t.caption.uppercase ? t.sample_text.toUpperCase() : t.sample_text,
    accentHex: t.accent,
  };
}

type Draft = {
  id: string;
  name: string;
  accent: string;
  preset: Caption["preset"];
  position: Caption["position"];
  uppercase: boolean;
  pacing: Template["pacing"];
};

export default function ModelosPage() {
  const { data, error, loading, reload } = useApi<{ items: Template[] }>("/api/v1/templates");
  const raw = useMemo(() => data?.items ?? [], [data]);
  const models = useMemo(() => raw.map(toModel), [raw]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>("todos");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeModelForEdit, setActiveModelForEdit] = useState<ModelTemplate | null>(null);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      const matchSearch =
        m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.categoryLabel.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchSearch) return false;
      if (selectedCategory === "todos") return true;
      return m.category === selectedCategory;
    });
  }, [models, searchQuery, selectedCategory]);

  const fail = (err: unknown) => showToast(err instanceof ApiError ? err.message : "Não foi possível salvar.");

  const setDefaultModel = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await api(`/api/v1/templates/${id}/default`, { method: "POST" });
      await reload();
      showToast("Modelo definido como padrão: vale para as próximas legendas gravadas.");
    } catch (err) {
      fail(err);
    }
  };

  const openEditor = (id: string, list: Template[] = raw) => {
    const t = list.find((x) => x.id === id);
    if (!t) return;
    setActiveModelForEdit(toModel(t));
    setDraft({
      id: t.id,
      name: t.name,
      accent: t.accent,
      preset: t.caption.preset,
      position: t.caption.position,
      uppercase: t.caption.uppercase,
      pacing: t.pacing,
    });
  };

  const createModel = async () => {
    try {
      const { template } = await api<{ template: Template }>("/api/v1/templates", {
        method: "POST",
        body: { name: "Novo modelo", category: "legendas" },
      });
      await reload();
      openEditor(template.id, [template]);
    } catch (err) {
      fail(err);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const current = raw.find((t) => t.id === draft.id);
      await api(`/api/v1/templates/${draft.id}`, {
        method: "PATCH",
        body: {
          name: draft.name.trim() || "Sem nome",
          accent: draft.accent,
          pacing: draft.pacing,
          caption: {
            ...(current?.caption ?? {}),
            preset: draft.preset,
            position: draft.position,
            uppercase: draft.uppercase,
            highlight: draft.preset === "destaque" ? draft.accent : null,
          },
        },
      });
      await reload();
      setActiveModelForEdit(null);
      setDraft(null);
      showToast("Modelo salvo.");
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  const duplicateModel = async (id: string) => {
    try {
      await api(`/api/v1/templates/${id}/duplicate`, { method: "POST" });
      await reload();
      showToast("Cópia criada.");
    } catch (err) {
      fail(err);
    }
  };

  const deleteModel = async (id: string) => {
    if (!window.confirm("Apagar este modelo?")) return;
    try {
      await api(`/api/v1/templates/${id}`, { method: "DELETE" });
      await reload();
      setActiveModelForEdit(null);
      setDraft(null);
      showToast("Modelo apagado.");
    } catch (err) {
      fail(err);
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

            {/* SEÇÃO ESTÚDIO IA (ATIVO EM MODELOS) */}
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
                  <li className="relative flex items-center text-white font-semibold">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#00b4d8] bg-[#00e5ff] shadow-[0_0_10px_#00e5ff]" />
                    <Link href="/modelos" className="w-full py-0.5 text-[#38bdf8]">
                      Modelos
                    </Link>
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

        {/* Perfil */}
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
        {/* HEADER: Busca, Título com Montanhas */}
        <header className="relative px-8 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar modelos, legendas, estilos de corte ou LUTs..."
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
              <Palette className="h-5 w-5 text-[#38bdf8]" />
            </button>
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

            <div className="relative z-10 py-2">
              <div className="flex items-center gap-3">
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">
                  Modelos & Presets de Edição
                </h1>
                <span className="flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#38bdf8] backdrop-blur-md">
                  <Sparkles className="h-3 w-3" />
                  Renderizador Automático 4K
                </span>
              </div>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Configure estilos de legenda dinâmica, regras de corte com IA, transições e paletas de cor.
              </p>
            </div>

            <div className="relative z-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => void createModel()}
                className="flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-4 text-xs font-bold text-white shadow-[0_0_20px_rgba(0,102,255,0.4)] hover:brightness-110 active:scale-[0.98] transition"
              >
                <Plus className="h-4 w-4" />
                <span>Criar Novo Modelo</span>
              </button>
            </div>
          </div>
        </header>

        {/* =========================================================================
            CORPO DA PÁGINA (FILTROS + GRID DE MODELOS)
           ========================================================================= */}
        <main className="space-y-6 px-8 pt-2 pb-12">
          {/* BARRA DE FILTROS POR CATEGORIA */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#0f1f35] pb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedCategory("todos")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  selectedCategory === "todos"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <span>Todos os Modelos</span>
                <span className="rounded-full bg-[#122845] px-1.5 py-0.2 text-[10px] text-[#93b4d8]">
                  {models.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedCategory("legendas")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  selectedCategory === "legendas"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Type className="h-3.5 w-3.5 text-[#00e5ff]" />
                <span>Legendas Dinâmicas</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedCategory("ritmo")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  selectedCategory === "ritmo"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Zap className="h-3.5 w-3.5 text-emerald-400" />
                <span>Ritmo & Cortes IA</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedCategory("cores")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  selectedCategory === "cores"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Palette className="h-3.5 w-3.5 text-purple-400" />
                <span>Paletas & LUTs</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedCategory("audio")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  selectedCategory === "audio"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Volume2 className="h-3.5 w-3.5 text-amber-400" />
                <span>Presets Sonoros</span>
              </button>
            </div>

            <div className="text-xs text-[#7187a5]">
              Modelo padrão: <strong className="text-white">{raw.find((t) => t.is_default)?.name ?? "nenhum"}</strong>
            </div>
          </div>

          {/* GRID DE MODELOS (3 COLUNAS) */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {loading && !data
              ? Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-80 animate-pulse rounded-2xl border border-[#12243b] bg-[#05101f]" />
                ))
              : null}
            {error && !data ? (
              <p role="alert" className="col-span-full text-sm text-[#f87171]">
                Não foi possível carregar os modelos: {error.message}
              </p>
            ) : null}
            {filteredModels.map((item) => (
              <div
                key={item.id}
                className={`group relative flex flex-col justify-between overflow-hidden rounded-2xl border bg-[#061224]/85 shadow-[0_4px_25px_rgba(0,10,25,0.4)] backdrop-blur-sm transition-all duration-200 hover:shadow-[0_0_25px_rgba(0,102,255,0.15)] ${
                  item.isDefault
                    ? "border-[#2563eb] shadow-[0_0_20px_rgba(37,99,235,0.2)]"
                    : "border-[#12243d] hover:border-[#1d4373]"
                }`}
              >
                {/* Visual Preview Header do Modelo com Efeito Live */}
                <div
                  className={`relative flex h-36 w-full items-center justify-center p-4 bg-gradient-to-br ${item.previewBgGradient} border-b border-[#12243b]`}
                >
                  {/* Badge Ativo Padrão */}
                  {item.isDefault && (
                    <span className="absolute top-3 left-3 flex items-center gap-1 rounded-md bg-[#0066ff] px-2 py-0.5 text-[10px] font-bold text-white shadow-[0_0_10px_#0066ff]">
                      <Check className="h-3 w-3" />
                      Padrão Ativo
                    </span>
                  )}

                  {/* Proporção badge */}
                  <span className="absolute top-3 right-3 rounded-md border border-white/10 bg-black/40 px-2 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-md">
                    {item.aspectRatio}
                  </span>

                  {/* Amostra da Legenda Renderizada com Glow */}
                  <div className="text-center px-4">
                    <p
                      style={{
                        textShadow: `0 0 16px ${item.accentHex}88`,
                        borderColor: item.accentHex,
                      }}
                      className="font-extrabold text-sm sm:text-base tracking-wide text-white drop-shadow-md"
                    >
                      {item.sampleCaptionText}
                    </p>
                    <div
                      style={{ backgroundColor: item.accentHex }}
                      className="mx-auto mt-2 h-0.5 w-16 rounded-full shadow-[0_0_8px_currentColor]"
                    />
                  </div>
                </div>

                {/* Conteúdo do Card */}
                <div className="flex-1 p-5">
                  <div className="flex items-center justify-between">
                    <span className="rounded-md border border-[#16355d] bg-[#091f3a] px-2 py-0.5 text-[10px] font-semibold text-[#8eb0dc]">
                      {item.categoryLabel}
                    </span>
                    <span className="text-[11px] text-[#5e779d]">
                      Usado em <strong>{item.usageCount}</strong> vídeos
                    </span>
                  </div>

                  <h3 className="mt-2.5 text-base font-bold text-white group-hover:text-[#38bdf8] transition">
                    {item.name}
                  </h3>

                  <p className="mt-1.5 text-xs text-[#8299ba] leading-relaxed line-clamp-2">
                    {item.description}
                  </p>

                  {/* Ficha Técnica do Preset */}
                  <div className="mt-4 space-y-1.5 border-t border-[#0e213b] pt-3 text-[11px]">
                    <div className="flex items-center justify-between text-[#7187a5]">
                      <span>Tipografia:</span>
                      <span className="font-semibold text-white">{item.fontFamily}</span>
                    </div>
                    <div className="flex items-center justify-between text-[#7187a5]">
                      <span>Animação:</span>
                      <span className="font-semibold text-[#38bdf8]">{item.animationStyle}</span>
                    </div>
                    <div className="flex items-center justify-between text-[#7187a5]">
                      <span>Velocidade de Corte:</span>
                      <span className="font-semibold text-white">{item.pacingCutSpeed}</span>
                    </div>
                  </div>
                </div>

                {/* Rodapé com Ações */}
                <div className="flex items-center justify-between border-t border-[#0e213b] bg-[#040d1c] p-3 px-5">
                  <button
                    type="button"
                    onClick={() => openEditor(item.id)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-[#7187a5] hover:text-white transition"
                  >
                    <Sliders className="h-3.5 w-3.5" />
                    <span>Personalizar</span>
                  </button>

                  {item.isDefault ? (
                    <span className="text-xs font-bold text-[#10b981] flex items-center gap-1">
                      <Check className="h-3.5 w-3.5" />
                      Em uso
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => void setDefaultModel(item.id, e)}
                      className="rounded-lg border border-[#1b3d6a] bg-[#0c2240] px-3 py-1 text-xs font-bold text-[#38bdf8] hover:border-[#00a6ff] hover:bg-[#102d55] transition"
                    >
                      Usar Padrão
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>

      {/* =========================================================================
          MODAL DE PERSONALIZAÇÃO DE MODELO
         ========================================================================= */}
      {activeModelForEdit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => setActiveModelForEdit(null)}
        >
          <div
            className="relative w-full max-w-xl rounded-2xl border border-[#1d4373] bg-[#05101f] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setActiveModelForEdit(null)}
              className="absolute top-5 right-5 text-sm text-[#7187a5] hover:text-white"
            >
              ✕
            </button>

            <div className="flex items-center gap-2 mb-2">
              <span className="rounded-lg border border-[#1e436f] bg-[#0b213d] px-2.5 py-0.5 text-xs font-semibold text-[#38bdf8]">
                {activeModelForEdit.categoryLabel}
              </span>
              <span className="text-xs text-[#7187a5]">• Editor de Parâmetros IA</span>
            </div>

            <h2 className="text-xl font-bold text-white">
              Personalizar: {draft?.name || activeModelForEdit.name}
            </h2>

            {/* Live Preview Box */}
            <div
              className={`mt-4 flex h-32 w-full items-center justify-center rounded-xl bg-gradient-to-br ${activeModelForEdit.previewBgGradient} border border-[#173052] p-4 text-center`}
            >
              <div>
                <p
                  style={{ textShadow: `0 0 16px ${draft?.accent ?? activeModelForEdit.accentHex}aa`, color: draft?.preset === "destaque" ? draft.accent : undefined }}
                  className="text-lg font-black text-white"
                >
                  {draft?.uppercase === false ? activeModelForEdit.sampleCaptionText.toLowerCase() : activeModelForEdit.sampleCaptionText.toUpperCase()}
                </p>
                <span className="text-[10px] text-white/60">Prévia aproximada</span>
              </div>
            </div>

            {/* Opções de Ajuste */}
            {draft && (
              <div className="mt-4 space-y-3 text-xs">
                <label className="block font-bold text-white">
                  Nome
                  <input
                    value={draft.name}
                    maxLength={80}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className="mt-1 w-full rounded-xl border border-[#172e4d] bg-[#030914] p-2.5 font-normal text-[#cad5e6] focus:border-[#3b82f6] focus:outline-none"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block font-bold text-white">
                    Estilo da legenda
                    <Select
                      value={draft.preset}
                      onChange={(e) => setDraft({ ...draft, preset: e.target.value as Caption["preset"] })}
                      className="mt-1 w-full rounded-xl border border-[#172e4d] bg-[#030914] p-2.5 font-normal text-[#cad5e6] focus:border-[#3b82f6] focus:outline-none"
                    >
                      <option value="destaque">Destaque (palavra acende)</option>
                      <option value="classico">Clássico com contorno</option>
                      <option value="minimal">Minimal com caixa</option>
                    </Select>
                  </label>
                  <label className="block font-bold text-white">
                    Posição
                    <Select
                      value={draft.position}
                      onChange={(e) => setDraft({ ...draft, position: e.target.value as Caption["position"] })}
                      className="mt-1 w-full rounded-xl border border-[#172e4d] bg-[#030914] p-2.5 font-normal text-[#cad5e6] focus:border-[#3b82f6] focus:outline-none"
                    >
                      <option value="top">Em cima</option>
                      <option value="middle">No meio</option>
                      <option value="bottom">Embaixo</option>
                    </Select>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block font-bold text-white">
                    Cor de destaque
                    <input
                      type="color"
                      value={draft.accent}
                      onChange={(e) => setDraft({ ...draft, accent: e.target.value.toUpperCase() })}
                      className="mt-1 h-10 w-full cursor-pointer rounded-xl border border-[#172e4d] bg-[#030914] p-1"
                    />
                  </label>
                  <label className="block font-bold text-white">
                    Ritmo de corte
                    <Select
                      value={draft.pacing}
                      onChange={(e) => setDraft({ ...draft, pacing: e.target.value as Template["pacing"] })}
                      className="mt-1 w-full rounded-xl border border-[#172e4d] bg-[#030914] p-2.5 font-normal text-[#cad5e6] focus:border-[#3b82f6] focus:outline-none"
                    >
                      <option value="ultra">Ultra rápido (1,5 s)</option>
                      <option value="rapido">Rápido (2,5 s)</option>
                      <option value="medio">Médio (4 s)</option>
                      <option value="lento">Lento (6 s)</option>
                    </Select>
                  </label>
                </div>
                <label className="flex items-center justify-between rounded-xl border border-[#172e4d] bg-[#030914] p-2.5 text-[#8fa2be] cursor-pointer">
                  <span>Texto em caixa alta</span>
                  <input
                    type="checkbox"
                    checked={draft.uppercase}
                    onChange={(e) => setDraft({ ...draft, uppercase: e.target.checked })}
                    className="h-4 w-4 accent-[#3b82f6]"
                  />
                </label>
                <p className="text-[11px] text-[#6e87a8]">
                  O estilo de legenda é aplicado quando você grava a legenda num corte. A fonte do vídeo final é a DejaVu Sans.
                </p>
              </div>
            )}

            {/* Ações */}
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-[#102238] pt-4">
              {draft && (
                <>
                  <button
                    type="button"
                    onClick={() => void deleteModel(draft.id)}
                    className="mr-auto rounded-xl px-3 py-2 text-xs font-semibold text-[#f87171] hover:bg-[#2a0f14] transition"
                  >
                    Apagar
                  </button>
                  <button
                    type="button"
                    onClick={() => void duplicateModel(draft.id)}
                    className="rounded-xl border border-[#162a45] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#0c1b30] hover:text-white transition"
                  >
                    Duplicar
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setActiveModelForEdit(null)}
                className="rounded-xl border border-[#162a45] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#0c1b30] hover:text-white transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveDraft()}
                className="rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-5 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,102,255,0.4)] hover:brightness-110 transition"
              >
                Salvar Alterações
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


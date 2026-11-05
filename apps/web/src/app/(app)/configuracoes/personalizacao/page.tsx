"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Contrast,
  Copy,
  Eye,
  Film,
  Globe,
  HardDrive,
  Laptop,
  Layers,
  LayoutDashboard,
  Maximize2,
  Monitor,
  Moon,
  Move,
  Paintbrush,
  Palette,
  Play,
  RotateCcw,
  Save,
  Settings,
  Sliders,
  Sparkles,
  Sun,
  Type,
  Video as VideoIcon,
  Volume2,
  Wand2,
  Zap,
} from "lucide-react";
import { applyTheme } from "@/lib/theme";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import type { SettingsAll, Template } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface ThemeOption {
  id: string;
  name: string;
  desc: string;
  primary: string;
  accent: string;
  border: string;
  bg: string;
  isPopular?: boolean;
}

const THEME_PRESETS: ThemeOption[] = [
  {
    id: "dark-neon",
    name: "Dark Neon Cobalto",
    desc: "Visual assinatura Clipo: fundo noturno profundo com glow ciano e cobalto.",
    primary: "#0066ff",
    accent: "#00e5ff",
    border: "#16355d",
    bg: "#030914",
    isPopular: true,
  },
  {
    id: "cyber-purple",
    name: "Cyberpunk Amethyst",
    desc: "Contraste vibrante com roxo elétrico e acentos magenta para criadores de games.",
    primary: "#8b5cf6",
    accent: "#ec4899",
    border: "#3b1d60",
    bg: "#080414",
  },
  {
    id: "emerald-matrix",
    name: "Emerald High-Tech",
    desc: "Estilo terminal de inteligência artificial com verde esmeralda e turquesa.",
    primary: "#10b981",
    accent: "#06b6d4",
    border: "#114032",
    bg: "#020f0a",
  },
  {
    id: "monolith-oled",
    name: "Obsidian OLED Minimal",
    desc: "Preto absoluto com bordas de titânio fosco para estúdios com telas HDR.",
    primary: "#64748b",
    accent: "#f8fafc",
    border: "#27272a",
    bg: "#000000",
  },
];

interface SubtitlePreset {
  id: string;
  name: string;
  font: string;
  highlightColor: string;
  stroke: string;
  desc: string;
}

const SUBTITLE_FALLBACK: SubtitlePreset[] = [
  {
    id: "hormozi",
    name: "Hormozi Viral",
    font: "font-black tracking-wide uppercase",
    highlightColor: "#ffe600",
    stroke: "drop-shadow-[0_2px_4px_rgba(0,0,0,1)]",
    desc: "Palavras curtas em caixa alta com amarelo ouro fluorescente.",
  },
  {
    id: "beast",
    name: "MrBeast Dynamic",
    font: "font-extrabold tracking-normal uppercase",
    highlightColor: "#00e5ff",
    stroke: "drop-shadow-[0_3px_6px_rgba(0,0,0,0.9)]",
    desc: "Animação de escala suave e realce ciano elétrico.",
  },
  {
    id: "minimal",
    name: "Clean Swiss Cinema",
    font: "font-semibold tracking-normal lowercase",
    highlightColor: "#ffffff",
    stroke: "drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]",
    desc: "Elegante e discreto para vlogs de negócios e tech reviews.",
  },
  {
    id: "cyber",
    name: "Neon Glow 2026",
    font: "font-bold tracking-widest uppercase",
    highlightColor: "#a855f7",
    stroke: "drop-shadow-[0_0_10px_rgba(168,85,247,0.8)]",
    desc: "Glow neon com transição de cor em gradiente pulsante.",
  },
];

export default function PersonalizacaoSettingsPage() {
  const settings = useApi<SettingsAll>("/api/v1/settings");
  const templates = useApi<{ items: Template[] }>("/api/v1/templates");
  const me = settings.data?.me;
  const mark = settings.data?.workspace.render.watermark;
  const canEditWorkspace = settings.data?.can_edit_workspace ?? false;
  const defaultTemplate = templates.data?.items.find((t) => t.is_default);
  const SUBTITLE_PRESETS: SubtitlePreset[] = templates.data?.items.length
    ? templates.data.items.map((t) => ({
        id: t.id,
        name: t.name,
        font: t.caption.uppercase ? "font-black uppercase tracking-tight" : "font-bold",
        highlightColor: t.caption.highlight ?? t.caption.color,
        stroke: "drop-shadow-[0_2px_2px_rgba(0,0,0,0.9)]",
        desc: t.description,
      }))
    : SUBTITLE_FALLBACK;
  type Draft = Partial<{
    theme: string;
    subtitle: string;
    wmEnabled: boolean;
    wmOpacity: number;
    wmPosition: string;
    waveform: boolean;
    snap: boolean;
    glow: string;
  }>;
  const [draft, setDraft] = useState<Draft>({});
  const put = (patch: Draft) => setDraft((d) => ({ ...d, ...patch }));
  const GLOW_IN: Record<string, "low" | "medium" | "high"> = { sutil: "low", medio: "medium", alto: "high" };
  const GLOW_OUT: Record<string, string> = { low: "sutil", medium: "medio", high: "alto" };
  const selectedTheme = draft.theme ?? (THEME_PRESETS.some((t) => t.id === me?.theme_preset) ? me!.theme_preset : "dark-neon");
  // Prévia na hora: o tema e o brilho mudam a tela enquanto a pessoa escolhe (salvar mantém).
  const setSelectedTheme = (v: string) => {
    put({ theme: v });
    applyTheme(v, GLOW_IN[draft.glow ?? GLOW_OUT[me?.glow ?? "medium"]]);
  };
  const selectedSubtitle = draft.subtitle ?? defaultTemplate?.id ?? SUBTITLE_PRESETS[0]?.id ?? "";
  const setSelectedSubtitle = (v: string) => put({ subtitle: v });
  const watermarkEnabled = draft.wmEnabled ?? mark?.enabled ?? false;
  const setWatermarkEnabled = (v: boolean) => put({ wmEnabled: v });
  const watermarkOpacity = draft.wmOpacity ?? mark?.opacity ?? 35;
  const setWatermarkOpacity = (v: number) => put({ wmOpacity: v });
  const watermarkPosition = draft.wmPosition ?? mark?.position ?? "top-right";
  const setWatermarkPosition = (v: string) => put({ wmPosition: v });
  const waveformDisplay = draft.waveform ?? me?.waveform ?? true;
  const setWaveformDisplay = (v: boolean) => put({ waveform: v });
  const timelineSnap = draft.snap ?? me?.timeline_snap ?? true;
  const setTimelineSnap = (v: boolean) => put({ snap: v });
  const glowIntensity = draft.glow ?? GLOW_OUT[me?.glow ?? "medium"];
  const setGlowIntensity = (v: string) => {
    put({ glow: v });
    applyTheme(draft.theme ?? me?.theme_preset, GLOW_IN[v]);
  };
  // Saiu sem salvar: volta ao que está salvo.
  useEffect(() => {
    const saved = settings.data?.me;
    return () => applyTheme(saved?.theme_preset, saved?.glow);
  }, [settings.data]);
  const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];

  const save = async () => {
    try {
      await api("/api/v1/settings/me", {
        method: "PATCH",
        body: { theme_preset: selectedTheme, waveform: waveformDisplay, timeline_snap: timelineSnap, glow: GLOW_IN[glowIntensity] },
      });
      if (canEditWorkspace) {
        await api("/api/v1/settings/workspace", {
          method: "PATCH",
          body: {
            render: {
              watermark: {
                enabled: watermarkEnabled,
                opacity: Math.max(5, watermarkOpacity),
                position: watermarkPosition,
                text: mark?.text || `@${(settings.data && (await api<{ user: { name: string } }>("/api/me")).user.name.split(" ")[0].toLowerCase()) || "clipo"}`,
              },
            },
          },
        });
      }
      if (draft.subtitle && draft.subtitle !== defaultTemplate?.id && templates.data?.items.some((t) => t.id === draft.subtitle)) {
        await api(`/api/v1/templates/${draft.subtitle}/default`, { method: "POST" });
      }
      await Promise.all([settings.reload(), templates.reload()]);
      applyTheme(selectedTheme, GLOW_IN[glowIntensity]);
      setDraft({});
      showToast(canEditWorkspace ? "Preferências salvas." : "Suas preferências foram salvas (a marca d'água é do dono do workspace).");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Não foi possível salvar.");
    }
  };
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const activeThemeObj = THEME_PRESETS.find((t) => t.id === selectedTheme) || THEME_PRESETS[0];
  const activeSubObj = SUBTITLE_PRESETS.find((s) => s.id === selectedSubtitle) || SUBTITLE_PRESETS[0];

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
          ÁREA PRINCIPAL: PERSONALIZAÇÃO & IDENTIDADE VISUAL
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
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">Personalização & Identidade Visual</h1>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Aparência do editor de timeline, cores de realce, presets de legendas virais e marca d’água.
              </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setDraft({ theme: "dark-neon", wmEnabled: false, wmOpacity: 35, wmPosition: "top-right", waveform: true, snap: true, glow: "medio" });
                  applyTheme("dark-neon", "medium");
                  showToast("Padrões restaurados. Clique em Salvar para manter.");
                }}
                className="flex items-center gap-1.5 rounded-xl border border-[#1b3d68] bg-[#07172e] px-3.5 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#0d2342] hover:text-white transition"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Restaurar</span>
              </button>

              <button
                type="button"
                onClick={() => void save()}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#0055ff] to-[#00c8ff] px-4 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,140,255,0.4)] hover:brightness-110 active:scale-95 transition"
              >
                <Save className="h-3.5 w-3.5" />
                <span>Salvar Alterações</span>
              </button>
            </div>
          </div>
        </div>

        {/* 4 KPIs NO TOPO (PADRÃO CLIPO DE ALTA DENSIDADE) */}
        <div className="px-8 pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Tema da Plataforma</span>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                  Ativo
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{activeThemeObj.name}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Paleta Neon Cobalto & Ciano 2026</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Preset de Legendas</span>
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#10b981]">
                  Alta Retenção
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{activeSubObj.name}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Destaque em tempo real no áudio</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Marca d’Água Dinâmica</span>
                <span
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${
                    watermarkEnabled
                      ? "border-sky-500/30 bg-sky-500/10 text-[#38bdf8]"
                      : "border-slate-500/30 bg-slate-500/10 text-slate-400"
                  }`}
                >
                  {watermarkEnabled ? `${watermarkOpacity}% Opacidade` : "Desativada"}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">
                {watermarkEnabled ? `Texto "${mark?.text || "@seu_nome"}"` : "Sem marca d'água"}
              </p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Posição: {watermarkPosition.toUpperCase()}</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Render Timeline</span>
                <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#c084fc]">
                  Snap 60 FPS
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">
                {waveformDisplay ? "Waveform + Snap" : "Modo Simplificado"}
              </p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Corte preciso no milissegundo</p>
            </div>
          </div>
        </div>

        {/* CONTEÚDO PRINCIPAL: 2 COLUNAS (CONFIGURAÇÕES + LIVE PREVIEW) */}
        <main className="px-8 pt-6 pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* COLUNA ESQUERDA: OPÇÕES DE PERSONALIZAÇÃO (7 COLS) */}
            <div className="lg:col-span-7 space-y-6">
              {/* 1. SELEÇÃO DE TEMA DO SISTEMA */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Palette className="h-5 w-5 text-[#00e5ff]" />
                    <h2 className="text-base font-bold text-white">Tema da Plataforma & Iluminação</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#5e779d]">Dark Glass HDR</span>
                </div>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {THEME_PRESETS.map((theme) => {
                    const isSelected = selectedTheme === theme.id;
                    return (
                      <div
                        key={theme.id}
                        onClick={() => {
                          setSelectedTheme(theme.id);
                        }}
                        className={`group relative flex flex-col justify-between rounded-xl border p-3.5 cursor-pointer transition-all ${
                          isSelected
                            ? "border-[#00e5ff] bg-[#081c38] shadow-[0_0_20px_rgba(0,229,255,0.2)]"
                            : "border-[#142845] bg-[#050e1c] hover:border-[#22487a] hover:bg-[#07162b]"
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span
                                className="h-3.5 w-3.5 rounded-full border border-white/20 shadow-md"
                                style={{ backgroundColor: theme.primary }}
                              />
                              <span
                                className="h-3.5 w-3.5 rounded-full border border-white/20 shadow-md"
                                style={{ backgroundColor: theme.accent }}
                              />
                              <h3 className="text-sm font-bold text-white group-hover:text-[#38bdf8] transition">
                                {theme.name}
                              </h3>
                            </div>
                            {isSelected && (
                              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#00e5ff] text-[#030914]">
                                <Check className="h-3 w-3 stroke-[3]" />
                              </div>
                            )}
                          </div>
                          <p className="mt-2 text-xs text-[#7187a5] leading-relaxed">{theme.desc}</p>
                        </div>

                        {theme.isPopular && (
                          <span className="mt-3 inline-block w-fit rounded-md bg-[#0066ff]/20 px-1.5 py-0.5 text-[9px] font-bold text-[#38bdf8] border border-[#0066ff]/30">
                            Padrão Oficial
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Intensidade de Glow */}
                <div className="mt-4 flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                  <div>
                    <p className="text-xs font-bold text-white">Intensidade de Efeito Neon Glow</p>
                    <p className="text-[11px] text-[#5e779d]">
                      Glow difuso ao redor de botões, borders e badges de status.
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 bg-[#08162b] p-1 rounded-lg border border-[#16355d]">
                    {(["sutil", "medio", "alto"] as const).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => {
                          setGlowIntensity(lvl);
                        }}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition capitalize ${
                          glowIntensity === lvl
                            ? "bg-[#0055ff] text-white shadow-[0_0_10px_rgba(0,102,255,0.5)]"
                            : "text-[#7187a5] hover:text-white"
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 2. PRESETS DE LEGENDAS VIRAIS */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Type className="h-5 w-5 text-[#00b4d8]" />
                    <h2 className="text-base font-bold text-white">Estilo de Legendas Virais (TikTok / Reels)</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#5e779d]">Destaque por Palavra</span>
                </div>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {SUBTITLE_PRESETS.map((sub) => {
                    const isSelected = selectedSubtitle === sub.id;
                    return (
                      <div
                        key={sub.id}
                        onClick={() => {
                          setSelectedSubtitle(sub.id);
                        }}
                        className={`relative rounded-xl border p-3.5 cursor-pointer transition-all ${
                          isSelected
                            ? "border-[#00e5ff] bg-[#081c38] shadow-[0_0_20px_rgba(0,229,255,0.2)]"
                            : "border-[#142845] bg-[#050e1c] hover:border-[#22487a] hover:bg-[#07162b]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-bold text-white">{sub.name}</h3>
                          {isSelected && (
                            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#00e5ff] text-[#030914]">
                              <Check className="h-3 w-3 stroke-[3]" />
                            </div>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-[#7187a5]">{sub.desc}</p>

                        {/* Amostra visual do texto */}
                        <div className="mt-3 rounded-lg bg-[#020712] border border-[#11243e] p-2 text-center">
                          <span className={`text-xs ${sub.font} text-white`}>
                            CRIE VÍDEOS{" "}
                            <span style={{ color: sub.highlightColor }}>COM IMPACTO</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 3. MARCA D'ÁGUA & OVERLAYS */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Sparkles className="h-5 w-5 text-[#38bdf8]" />
                    <h2 className="text-base font-bold text-white">Marca d’Água & Branding Automático</h2>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={watermarkEnabled}
                      onChange={(e) => {
                        setWatermarkEnabled(e.target.checked);
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0055ff]"></div>
                  </label>
                </div>

                {watermarkEnabled && (
                  <div className="mt-4 space-y-4">
                    {/* Slider de Opacidade */}
                    <div>
                      <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
                        <span className="text-[#8fa2be]">Nível de Transparência</span>
                        <span className="text-[#00e5ff] font-bold">{watermarkOpacity}%</span>
                      </div>
                      <input
                        type="range"
                        min="5"
                        max="80"
                        value={watermarkOpacity}
                        onChange={(e) => setWatermarkOpacity(Number(e.target.value))}
                        className="w-full h-1.5 bg-[#0a182c] rounded-lg appearance-none cursor-pointer accent-[#00e5ff]"
                      />
                      <div className="flex justify-between text-[10px] text-[#5e779d] mt-1">
                        <span>Discreto (5%)</span>
                        <span>Equilibrado (25%)</span>
                        <span>Marcante (80%)</span>
                      </div>
                    </div>

                    {/* Grade de 9 posições na tela */}
                    <div>
                      <p className="text-xs font-semibold text-[#8fa2be] mb-2">Posicionamento no Quadro</p>
                      <div className="grid grid-cols-3 gap-2 w-48">
                        {[
                          { id: "top-left", label: "TL" },
                          { id: "top-center", label: "TC" },
                          { id: "top-right", label: "TR" },
                          { id: "mid-left", label: "ML" },
                          { id: "center", label: "C" },
                          { id: "mid-right", label: "MR" },
                          { id: "bottom-left", label: "BL" },
                          { id: "bottom-center", label: "BC" },
                          { id: "bottom-right", label: "BR" },
                        ].map((pos) => {
                          const isPos = watermarkPosition === pos.id;
                          return (
                            <button
                              key={pos.id}
                              type="button"
                              disabled={!CORNERS.includes(pos.id)}
                              title={CORNERS.includes(pos.id) ? undefined : "Em breve: hoje a marca d'água vai nos cantos"}
                              onClick={() => {
                                setWatermarkPosition(pos.id);
                              }}
                              className={`h-9 rounded-lg border text-xs font-bold transition ${
                                isPos
                                  ? "border-[#00e5ff] bg-[#0066ff]/30 text-white shadow-[0_0_10px_rgba(0,102,255,0.4)]"
                                  : "border-[#142845] bg-[#050e1c] text-[#5e779d] hover:bg-[#0a1a33] hover:text-white"
                              }`}
                            >
                              {pos.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 4. PREFERÊNCIAS DA TIMELINE */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center gap-2.5 pb-3 border-b border-[#0f2138]">
                  <Film className="h-5 w-5 text-[#38bdf8]" />
                  <h2 className="text-base font-bold text-white">Preferências do Player & Linha do Tempo</h2>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Volume2 className="h-4 w-4 text-[#00b4d8]" />
                      <div>
                        <p className="text-xs font-bold text-white">Exibir Ondas Sonoras (Waveform)</p>
                        <p className="text-[11px] text-[#5e779d]">
                          Desenha a trilha espectral de frequência para sincronização vocal.
                        </p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={waveformDisplay}
                        onChange={(e) => {
                          setWaveformDisplay(e.target.checked);
                        }}
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Zap className="h-4 w-4 text-[#ffe600]" />
                      <div>
                        <p className="text-xs font-bold text-white">Snap Magnético a 60 FPS</p>
                        <p className="text-[11px] text-[#5e779d]">
                          Trava os cortes cirurgicamente nos keyframes de transição.
                        </p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={timelineSnap}
                        onChange={(e) => {
                          setTimelineSnap(e.target.checked);
                        }}
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* COLUNA DIREITA: LIVE PREVIEW DO SMARTPHONE (5 COLS) */}
            <div className="lg:col-span-5">
              <div className="sticky top-6 rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-2xl backdrop-blur-sm">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2">
                    <Eye className="h-4 w-4 text-[#00e5ff]" />
                    <h3 className="text-sm font-bold text-white">Prévia em Tempo Real (9:16)</h3>
                  </div>
                  <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                    Renderização Ativa
                  </span>
                </div>

                {/* MOCKUP DO DISPOSITIVO SMARTPHONE */}
                <div className="mt-5 mx-auto max-w-[280px] rounded-[32px] border-4 border-[#16355d] bg-[#020611] p-3 shadow-[0_0_35px_rgba(0,102,255,0.25)]">
                  {/* Speaker Notch */}
                  <div className="mx-auto h-3 w-20 rounded-full bg-[#0a182c] mb-2" />

                  {/* Tela de Vídeo 9:16 */}
                  <div className="relative aspect-[9/16] w-full overflow-hidden rounded-[20px] bg-gradient-to-b from-[#091830] via-[#040c1a] to-[#02050c] flex flex-col justify-between p-3.5 border border-[#142d4f]">
                    {/* Imagem de Fundo Simulada com Montanhas */}
                    <div className="absolute inset-0 opacity-40">
                      <Image
                        src="/dashboard/mountains-glow.png"
                        alt=""
                        fill
                        className="object-cover"
                      />
                    </div>

                    {/* MARCA D'ÁGUA EM TEMPO REAL */}
                    {watermarkEnabled && (
                      <div
                        className={`absolute z-20 flex items-center gap-1.5 transition-all ${
                          watermarkPosition === "top-left"
                            ? "top-3 left-3"
                            : watermarkPosition === "top-center"
                            ? "top-3 left-1/2 -translate-x-1/2"
                            : watermarkPosition === "top-right"
                            ? "top-3 right-3"
                            : watermarkPosition === "mid-left"
                            ? "top-1/2 left-3 -translate-y-1/2"
                            : watermarkPosition === "center"
                            ? "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                            : watermarkPosition === "mid-right"
                            ? "top-1/2 right-3 -translate-y-1/2"
                            : watermarkPosition === "bottom-left"
                            ? "bottom-14 left-3"
                            : watermarkPosition === "bottom-center"
                            ? "bottom-14 left-1/2 -translate-x-1/2"
                            : "bottom-14 right-3"
                        }`}
                        style={{ opacity: watermarkOpacity / 100 }}
                      >
                        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[#0066ff] text-[9px] font-black text-white shadow-md">
                          C
                        </div>
                        <span className="text-[10px] font-extrabold tracking-tight text-white drop-shadow">
                          clipo
                        </span>
                      </div>
                    )}

                    {/* Header do Player */}
                    <div className="relative z-10 flex items-center justify-between text-[10px] text-white/70">
                      <span className="rounded bg-black/40 px-1.5 py-0.5 backdrop-blur-sm">4K 60FPS</span>
                      <span className="rounded bg-black/40 px-1.5 py-0.5 backdrop-blur-sm">00:14 / 00:58</span>
                    </div>

                    {/* ÁREA CENTRAL: LEGENDA DINÂMICA COM ESTILO APLICADO */}
                    <div className="relative z-10 my-auto text-center px-2">
                      <div
                        className={`inline-block rounded-xl bg-black/50 p-2.5 backdrop-blur-md border border-white/10 ${activeSubObj.stroke}`}
                      >
                        <p className={`text-sm ${activeSubObj.font} text-white leading-tight`}>
                          O SEGREDO PARA{" "}
                          <span
                            className="transition-colors"
                            style={{ color: activeSubObj.highlightColor }}
                          >
                            VIRALIZAR
                          </span>{" "}
                          EM 2026!
                        </p>
                      </div>
                    </div>

                    {/* BARRAS DE WAVEFORM E CONTROLES */}
                    <div className="relative z-10 space-y-2">
                      {waveformDisplay && (
                        <div className="flex items-center gap-0.5 h-4 justify-center">
                          {[40, 75, 100, 60, 85, 30, 90, 50, 70, 95, 30, 80, 60, 90, 45, 100, 65, 80, 50].map(
                            (h, idx) => (
                              <span
                                key={idx}
                                className="w-1 rounded-full bg-[#00e5ff] shadow-[0_0_6px_#00e5ff] transition-all"
                                style={{ height: `${h}%` }}
                              />
                            )
                          )}
                        </div>
                      )}

                      <div className="h-1 w-full bg-white/20 rounded-full overflow-hidden">
                        <div className="h-full w-2/5 bg-[#00e5ff]" />
                      </div>
                    </div>
                  </div>

                  {/* Botão Home do Mockup */}
                  <div className="mx-auto mt-2 h-1 w-24 rounded-full bg-[#16355d]" />
                </div>

                <div className="mt-4 rounded-xl border border-[#16355d] bg-[#040e1b] p-3 text-center">
                  <p className="text-xs font-semibold text-white">Preset Selecionado:</p>
                  <p className="text-xs text-[#00e5ff] font-bold mt-0.5">
                    {activeSubObj.name} + {activeThemeObj.name}
                  </p>
                  <p className="text-[10px] text-[#5e779d] mt-1">
                    Renderizado em GPU Metal / CUDA com resolução vertical 1080x1920.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}


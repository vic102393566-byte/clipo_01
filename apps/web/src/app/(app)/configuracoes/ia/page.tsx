"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Cpu,
  Eye,
  FileText,
  Key,
  Layers,
  LayoutDashboard,
  Mic,
  Play,
  RotateCcw,
  Save,
  Scissors,
  Settings,
  Sliders,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Video as VideoIcon,
  Volume2,
  Wand2,
  Wifi,
  Zap,
} from "lucide-react";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import type { SettingsAll } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface ModelOption {
  id: string;
  name: string;
  provider: string;
  latency: string;
  desc: string;
  isDefault?: boolean;
}

const TEXT_MODELS: ModelOption[] = [
  {
    id: "auto",
    name: "Automático (recomendado)",
    provider: "Clipo",
    latency: "fallback",
    desc: "Usa a ordem de modelos definida pelo admin e troca de provedor sozinho se um falhar.",
    isDefault: true,
  },
  { id: "gemini", name: "Google Gemini", provider: "Google AI", latency: "", desc: "Rápido e barato: bom para ideias, textos de publicação e roteiros." },
  { id: "anthropic", name: "Anthropic Claude", provider: "Anthropic", latency: "", desc: "Texto mais natural e cuidadoso; ótimo para roteiros longos." },
  { id: "openai", name: "OpenAI GPT", provider: "OpenAI", latency: "", desc: "Versátil, segue bem o formato pedido." },
  { id: "local", name: "Modelo local (Ollama)", provider: "Servidor próprio", latency: "", desc: "Roda no seu servidor: sem custo por chamada, mais lento." },
];

type AICheck = {
  providers: { id: string; ready: boolean }[];
  transcription: { provider: string; model: string };
  subtitles_burn: boolean;
  credits: { used: number; limit: number; remaining: number };
};

/** Toggle de recurso que ainda não existe no processamento: aparece desligado, com aviso. */
const SOON = "Em breve: ainda não aplicado no processamento";

export default function IAConfiguracoesPage() {
  const settings = useApi<SettingsAll>("/api/v1/settings");
  const check = useApi<AICheck>("/api/v1/settings/ai/check");
  const ai = settings.data?.workspace.ai;
  const canEdit = settings.data?.can_edit_workspace ?? false;
  const [draft, setDraft] = useState<{ provider?: string; creativity?: number; filter_profanity?: boolean }>({});
  const selectedTextModel = draft.provider ?? ai?.provider ?? "auto";
  const setSelectedTextModel = (id: string) => setDraft((d) => ({ ...d, provider: id }));
  const [whisperModel, setWhisperModel] = useState("large-v3-turbo");
  const temperature = draft.creativity ?? ai?.creativity ?? 0.7;
  const setTemperature = (v: number) => setDraft((d) => ({ ...d, creativity: v }));
  const [silenceThreshold, setSilenceThreshold] = useState(0.25);
  const autoZoom = false;
  const autoReframe = false;
  const vocalIsolation = false;
  const filterProfanity = draft.filter_profanity ?? ai?.filter_profanity ?? false;
  const setFilterProfanity = (v: boolean) => setDraft((d) => ({ ...d, filter_profanity: v }));
  const autoEmoji = false;
  const [customApiKey, setCustomApiKey] = useState("");
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isTestingEngines, setIsTestingEngines] = useState(false);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleTestEngines = async () => {
    setIsTestingEngines(true);
    try {
      const out = await check.reload().then(() => api<AICheck>("/api/v1/settings/ai/check"));
      const ready = out.providers.filter((p) => p.ready).map((p) => TEXT_MODELS.find((m) => m.id === p.id)?.provider ?? p.id);
      showToast(ready.length ? `Prontos no servidor: ${ready.join(", ")}.` : "Nenhum provedor de IA configurado no servidor.");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Não foi possível testar.");
    } finally {
      setIsTestingEngines(false);
    }
  };

  const save = async () => {
    try {
      await api("/api/v1/settings/workspace", {
        method: "PATCH",
        body: { ai: { provider: selectedTextModel, creativity: temperature, filter_profanity: filterProfanity } },
      });
      await settings.reload();
      setDraft({});
      showToast("Preferências de IA salvas para o workspace.");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Não foi possível salvar.");
    }
  };

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
          ÁREA PRINCIPAL: IA & AUTOMAÇÕES
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
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">IA Generativa & Motores Neurais</h1>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Ajuste os modelos de roteirização, transcrição Whisper, auto-corte de silêncios e automação de vídeo.
              </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handleTestEngines()}
                disabled={isTestingEngines}
                className="flex items-center gap-1.5 rounded-xl border border-[#1b3d68] bg-[#07172e] px-3.5 py-2 text-xs font-semibold text-[#38bdf8] hover:border-[#00e5ff] hover:bg-[#0d2342] hover:text-white transition shadow-[0_0_15px_rgba(0,180,216,0.15)] disabled:opacity-50"
              >
                <Activity className={`h-3.5 w-3.5 text-[#00e5ff] ${isTestingEngines ? "animate-spin" : ""}`} />
                <span>{isTestingEngines ? "Conferindo..." : "Conferir provedores"}</span>
              </button>

              <button
                type="button"
                onClick={() => void save()}
                disabled={!canEdit}
                title={canEdit ? undefined : "Só o dono do workspace muda estas preferências"}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#0055ff] to-[#00c8ff] px-4 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,140,255,0.4)] hover:brightness-110 active:scale-95 transition"
              >
                <Save className="h-3.5 w-3.5" />
                <span>Salvar Configurações</span>
              </button>
            </div>
          </div>
        </div>

        {/* 4 KPIS NO TOPO (PADRÃO CLIPO DE ALTA DENSIDADE) */}
        <div className="px-8 pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Modelo de Roteiro</span>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                  Gemini 2.5 Pro
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">Google DeepMind</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Latência média: 140ms / resposta</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Motor Vocal STT</span>
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#10b981]">
                  {check.data?.transcription.provider === "local" ? "Local" : "API"}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">
                {check.data ? (check.data.transcription.provider === "local" ? `Whisper ${check.data.transcription.model}` : "Whisper (API)") : "Whisper"}
              </p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Definido no servidor; idioma pela conta</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Auto-Corte de Silêncio</span>
                <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#c084fc]">
                  {silenceThreshold}s Limiar
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">Smart JumpCut</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Elimina pausas de respiração</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>B-Rolls & Visuais</span>
                <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#f59e0b]">
                  GPU Metal / CUDA
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">Flux.1 Schnell</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Geração em 1.8s por frame 4K</p>
            </div>
          </div>
        </div>

        {/* CONTEÚDO PRINCIPAL: 2 COLUNAS (MODELOS LLM + AUTOMAÇÕES DE CORTE) */}
        <main className="px-8 pt-6 pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* COLUNA ESQUERDA: MODELOS DE IA & PROMPT ENGINEERING (7 COLS) */}
            <div className="lg:col-span-7 space-y-6">
              {/* 1. SELEÇÃO DO MODELO DE ROTEIRO */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Brain className="h-5 w-5 text-[#00e5ff]" />
                    <h2 className="text-base font-bold text-white">Motor Neural de Roteiros & Storytelling</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#5e779d]">LLM Padrão</span>
                </div>

                <div className="mt-4 space-y-3">
                  {TEXT_MODELS.map((model) => {
                    const isSelected = selectedTextModel === model.id;
                    return (
                      <div
                        key={model.id}
                        onClick={() => {
                          setSelectedTextModel(model.id);
                        }}
                        className={`group relative flex items-start justify-between rounded-xl border p-3.5 cursor-pointer transition-all ${
                          isSelected
                            ? "border-[#00e5ff] bg-[#081c38] shadow-[0_0_20px_rgba(0,229,255,0.2)]"
                            : "border-[#142845] bg-[#050e1c] hover:border-[#22487a] hover:bg-[#07162b]"
                        }`}
                      >
                        <div className="min-w-0 pr-3">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-white group-hover:text-[#38bdf8] transition">
                              {model.name}
                            </h3>
                            {model.isDefault && (
                              <span className="rounded bg-[#0066ff]/20 px-1.5 py-0.2 text-[9px] font-bold text-[#38bdf8] border border-[#0066ff]/30">
                                Recomendado Clipo
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-[#7187a5] leading-relaxed">{model.desc}</p>
                          <div className="mt-2 flex items-center gap-3 text-[11px] text-[#5e779d]">
                            <span>Provedor: {model.provider}</span>
                            <span>•</span>
                            <span className="text-[#00e5ff]">Latência: {model.latency}</span>
                          </div>
                        </div>

                        {isSelected ? (
                          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#00e5ff] text-[#030914]">
                            <Check className="h-3 w-3 stroke-[3]" />
                          </div>
                        ) : (
                          <div className="h-5 w-5 shrink-0 rounded-full border border-[#22487a]" />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Slider de Temperatura / Criatividade */}
                <div className="mt-5 pt-4 border-t border-[#0f2138]">
                  <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
                    <span className="text-[#8fa2be]">Temperatura Criativa (Ganchos & Ideias)</span>
                    <span className="text-[#00e5ff] font-bold">{temperature.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={temperature}
                    onChange={(e) => setTemperature(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-[#0a182c] rounded-lg appearance-none cursor-pointer accent-[#00e5ff]"
                  />
                  <div className="flex justify-between text-[10px] text-[#5e779d] mt-1">
                    <span>Foco Rígido (0.1)</span>
                    <span>Equilíbrio Viral (0.7)</span>
                    <span>Hiper-Criativo (1.0)</span>
                  </div>
                </div>

                {/* Chave de API Personalizada (Opcional) */}
                <div className="mt-4 rounded-xl border border-[#11243e] bg-[#040e1b] p-3.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Key className="h-3.5 w-3.5 text-[#38bdf8]" />
                      <span>Chave de API Própria (BYOK - Bring Your Own Key)</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setIsKeyVisible(!isKeyVisible)}
                      className="text-[11px] text-[#00b4d8] hover:underline"
                    >
                      {isKeyVisible ? "Ocultar" : "Exibir"}
                    </button>
                  </div>
                  <input
                    type={isKeyVisible ? "text" : "password"}
                    placeholder="Em breve"
                    value={customApiKey}
                    disabled
                    title="Em breve"
                    onChange={(e) => setCustomApiKey(e.target.value)}
                    className="w-full h-9 rounded-lg border border-[#16355d] bg-[#020712] px-3 text-xs text-white placeholder:text-[#425d7e] focus:border-[#00e5ff] focus:outline-none transition"
                  />
                  <p className="mt-1 text-[10px] text-[#5e779d]">
                    Em breve: chave própria por workspace. Hoje a IA usa as chaves do servidor e os créditos do plano.
                  </p>
                </div>
              </div>

              {/* 2. RECONHECIMENTO VOCAL & WHISPER */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Mic className="h-5 w-5 text-[#00b4d8]" />
                    <h2 className="text-base font-bold text-white">Transcrição Vocal Neural (Whisper AI)</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#10b981]">Whisper Large-v3 Turbo</span>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div>
                      <p className="text-xs font-bold text-white">Filtro de Termos Sensíveis & Anti-Shadowban</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Substitui palavrões e termos restritos por asteriscos para preservar o alcance do algoritmo.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={filterProfanity}
                        onChange={(e) => setFilterProfanity(e.target.checked)}
                        disabled={!canEdit}
                        aria-label="Filtrar palavrões nas legendas"
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div>
                      <p className="text-xs font-bold text-white">Inserção Automática de Emojis Contextuais</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Analisa o sentimento de cada frase e insere emojis nas legendas virais automaticamente.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoEmoji}
                        disabled
                        title={SOON}
                        readOnly
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* COLUNA DIREITA: AUTOMAÇÕES DE CORTE, VÍDEO & ÁUDIO (5 COLS) */}
            <div className="lg:col-span-5 space-y-6">
              {/* 3. AUTO-CORTE DE SILÊNCIO & JUMPCUTS */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Scissors className="h-5 w-5 text-[#38bdf8]" />
                    <h2 className="text-base font-bold text-white">Auto-Corte de Silêncios (Smart JumpCut)</h2>
                  </div>
                  <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[10px] font-bold text-[#c084fc]">
                    IA Ativa
                  </span>
                </div>

                <div className="mt-4 space-y-4">
                  <div>
                    <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
                      <span className="text-[#8fa2be]">Duração Mínima do Silêncio para Corte</span>
                      <span className="text-[#00e5ff] font-bold">{silenceThreshold}s</span>
                    </div>
                    <input
                      type="range"
                      min="0.10"
                      max="0.80"
                      step="0.05"
                      value={silenceThreshold}
                      onChange={(e) => setSilenceThreshold(parseFloat(e.target.value))}
                      disabled
                      title={SOON}
                      className="w-full h-1.5 bg-[#0a182c] rounded-lg appearance-none cursor-pointer accent-[#00e5ff]"
                    />
                    <div className="flex justify-between text-[10px] text-[#5e779d] mt-1">
                      <span>Corte Agressivo (0.10s)</span>
                      <span>Equilibrado (0.25s)</span>
                      <span>Suave (0.80s)</span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-[#142845] bg-[#050e1c] p-3 text-[11px] text-[#7187a5] leading-relaxed">
                    <p>
                      O detector acústico FFT corta automaticamente intervalos mudos entre sentenças, acelerando a
                      velocidade média de fala para aumentar a retenção nos primeiros 10 segundos.
                    </p>
                  </div>
                </div>
              </div>

              {/* 4. ENQUADRAMENTO DINÂMICO & ZOOM */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center gap-2.5 pb-3 border-b border-[#0f2138]">
                  <Wand2 className="h-5 w-5 text-[#ffe600]" />
                  <h2 className="text-base font-bold text-white">Efeitos Automáticos de Retenção</h2>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div>
                      <p className="text-xs font-bold text-white">Smart Punch-In Zoom (1.15x)</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Aplica zoom sutil automático em palavras de ênfase para quebrar monotonia visual.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoZoom}
                        disabled
                        title={SOON}
                        readOnly
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div>
                      <p className="text-xs font-bold text-white">Auto-Reframe Inteligente (9:16)</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Rastreia o rosto do criador e centraliza no formato vertical automaticamente.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoReframe}
                        disabled
                        title={SOON}
                        readOnly
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div>
                      <p className="text-xs font-bold text-white">Isolamento Vocal por IA (DeepFilterNet)</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Remove eco de sala, ruído de ar-condicionado e teclado sem distorcer a voz.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={vocalIsolation}
                        disabled
                        title={SOON}
                        readOnly
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
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


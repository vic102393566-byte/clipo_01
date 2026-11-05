"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Flame,
  Globe,
  HardDrive,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Lightbulb,
  Maximize2,
  Mic,
  Minimize2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Sparkles,
  Target,
  TrendingUp,
  Video as VideoIcon,
  Wand2,
  Zap,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { mmss, type Script, type ScriptBlock as ScriptBlockApi } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface ScriptBlock {
  id: string;
  timeRange: string;
  actLabel: string;
  speechText: string;
  visualCue: string;
  emphasisWord?: string;
  pacingNote?: string;
}

interface ScriptItem {
  id: string;
  title: string;
  hook: string;
  niche: string;
  targetDuration: string;
  wordCount: number;
  wpm: number;
  retentionScore: number;
  status: "pronto" | "rascunho" | "gravado";
  updatedAt: string;
  blocks: ScriptBlock[];
}

const STATUS_OUT: Record<Script["status"], ScriptItem["status"]> = { draft: "rascunho", ready: "pronto", recorded: "gravado" };
const STATUS_IN: Record<ScriptItem["status"], Script["status"]> = { rascunho: "draft", pronto: "ready", gravado: "recorded" };

function toScript(s: Script): ScriptItem {
  return {
    id: s.id,
    title: s.title,
    hook: s.hook,
    niche: s.niche || "Sem nicho",
    targetDuration: `${s.target_duration_s}s`,
    wordCount: s.word_count,
    wpm: s.wpm,
    retentionScore: s.retention_score ?? 0,
    status: STATUS_OUT[s.status],
    updatedAt: s.updated_at ?? s.created_at,
    blocks: s.blocks.map((b) => ({
      id: b.id,
      timeRange: `${mmss(b.start_s)} - ${mmss(b.end_s)}`,
      actLabel: b.act || "Bloco",
      speechText: b.speech,
      visualCue: b.visual || "Sem indicação visual.",
      emphasisWord: b.emphasis || undefined,
      pacingNote: b.pacing_note || undefined,
    })),
  };
}

const EMPTY_SCRIPT: ScriptItem = {
  id: "",
  title: "Nenhum roteiro ainda",
  hook: "Crie um roteiro em branco ou gere um a partir de uma ideia.",
  niche: "—",
  targetDuration: "—",
  wordCount: 0,
  wpm: 160,
  retentionScore: 0,
  status: "rascunho",
  updatedAt: "",
  blocks: [],
};

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms % 1000, 3)}`;
}


export default function RoteirosPage() {
  const list = useApi<{ items: Script[]; counts: Record<string, number> }>("/api/v1/scripts");
  const raw = useMemo(() => list.data?.items ?? [], [list.data]);
  // Fala editada e ainda não salva (salva sozinha 1 s depois de parar de digitar).
  const [drafts, setDrafts] = useState<Record<string, ScriptBlockApi[]>>({});
  const saveTimer = useRef<number | undefined>(undefined);
  const scripts = useMemo(
    () => raw.map((s) => toScript(drafts[s.id] ? { ...s, blocks: drafts[s.id], word_count: drafts[s.id].reduce((n, b) => n + b.speech.trim().split(/\s+/).filter(Boolean).length, 0) } : s)),
    [raw, drafts],
  );
  const [selectedScriptId, setSelectedScriptId] = useState<string>(() =>
    typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("script") ?? ""),
  );
  const [filterStatus, setFilterStatus] = useState<string>("todos");
  const [searchQuery, setSearchQuery] = useState("");
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  // Modo Teleprompter
  const [isTeleprompterOpen, setIsTeleprompterOpen] = useState(false);
  const [prompterSpeed, setPrompterSpeed] = useState<number>(3); // 1 to 5
  const [isPrompterPlaying, setIsPrompterPlaying] = useState(false);
  const [prompterFontSize, setPrompterFontSize] = useState<number>(36);
  const [isPrompterMirrored, setIsPrompterMirrored] = useState(false);

  // Estados de IA & Edição
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const currentScript = useMemo(() => {
    return scripts.find((s) => s.id === selectedScriptId) || scripts[0] || EMPTY_SCRIPT;
  }, [scripts, selectedScriptId]);
  const currentApi = raw.find((s) => s.id === currentScript.id);
  const hasScript = Boolean(currentApi);
  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  // Filtragem dos roteiros na barra lateral interna
  const filteredScripts = useMemo(() => {
    return scripts.filter((s) => {
      const matchSearch =
        s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.hook.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchSearch) return false;
      if (filterStatus === "todos") return true;
      return s.status === filterStatus;
    });
  }, [scripts, searchQuery, filterStatus]);

  // Atualizar texto de fala de um bloco (salva sozinho)
  // Ditado: fala no microfone e o texto entra no bloco em foco (ou no último bloco do roteiro).
  const [listening, setListening] = useState(false);
  const [focusedBlock, setFocusedBlock] = useState<string | null>(null);
  const recognition = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => recognition.current?.stop(), []);
  const toggleDictation = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!currentApi) {
      showToast("Crie ou abra um roteiro para ditar.");
      return;
    }
    type Rec = {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      start: () => void;
      stop: () => void;
      onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
      onend: (() => void) | null;
      onerror: ((e: { error: string }) => void) | null;
    };
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      showToast("Este navegador não tem ditado por voz. Use Chrome, Edge ou Safari.");
      return;
    }
    const target = focusedBlock && currentApi.blocks.some((b) => b.id === focusedBlock) ? focusedBlock : currentApi.blocks.at(-1)?.id;
    if (!target) {
      showToast("O roteiro não tem bloco de fala.");
      return;
    }
    const rec = new Ctor();
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = false;
    let text = (drafts[currentApi.id] ?? currentApi.blocks).find((b) => b.id === target)?.speech ?? "";
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const piece = e.results[i][0].transcript.trim();
          if (piece) {
            text = `${text}${text && !text.endsWith(" ") ? " " : ""}${piece}`;
            handleUpdateSpeech(target, text);
          }
        }
      }
    };
    rec.onerror = (e) => {
      showToast(e.error === "not-allowed" ? "Libere o microfone no navegador para ditar." : "O ditado parou. Tente de novo.");
    };
    rec.onend = () => {
      setListening(false);
      recognition.current = null;
    };
    recognition.current = rec;
    rec.start();
    setListening(true);
    showToast("Ouvindo… fale o texto do bloco. Clique no microfone para parar.");
  };

  const handleUpdateSpeech = (blockId: string, newText: string) => {
    if (!currentApi) return;
    const id = currentApi.id;
    const blocks = (drafts[id] ?? currentApi.blocks).map((b) => (b.id === blockId ? { ...b, speech: newText } : b));
    setDrafts((d) => ({ ...d, [id]: blocks }));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        await api(`/api/v1/scripts/${id}`, { method: "PATCH", body: { blocks } });
        await list.reload();
        setDrafts((d) => {
          const next = { ...d };
          delete next[id];
          return next;
        });
      } catch (err) {
        fail(err, "Não foi possível salvar a fala.");
      }
    }, 1000);
  };

  // IA: gancho, B-roll, refinar ou encurtar (gasta crédito de IA; dá para desfazer uma vez)
  const handleOptimizeAI = async (action: "hook" | "broll" | "refine" | "shorten") => {
    if (isOptimizing || !currentApi) return;
    setIsOptimizing(true);
    try {
      const out = await api<{ asset_suggestions: unknown[] }>(`/api/v1/scripts/${currentApi.id}/ai`, {
        method: "POST",
        body: { action },
      });
      await list.reload();
      const messages = {
        hook: "Gancho reescrito pela IA.",
        broll: out.asset_suggestions.length
          ? `B-roll sugerido; ${out.asset_suggestions.length} bloco(s) combinam com ativos da sua biblioteca.`
          : "B-roll sugerido pela IA.",
        refine: "Fala refinada pela IA.",
        shorten: "Roteiro encurtado pela IA.",
      };
      showToast(messages[action]);
    } catch (err) {
      fail(err, "A IA não respondeu. Tente de novo.");
    } finally {
      setIsOptimizing(false);
    }
  };

  const undoAI = async () => {
    if (!currentApi) return;
    try {
      await api(`/api/v1/scripts/${currentApi.id}/undo`, { method: "POST" });
      await list.reload();
      showToast("Mudança da IA desfeita.");
    } catch (err) {
      fail(err, "Não foi possível desfazer.");
    }
  };

  const setStatus = async (status: ScriptItem["status"]) => {
    if (!currentApi) return;
    try {
      await api(`/api/v1/scripts/${currentApi.id}`, { method: "PATCH", body: { status: STATUS_IN[status] } });
      await list.reload();
    } catch (err) {
      fail(err, "Não foi possível mudar a situação.");
    }
  };

  const createScript = async () => {
    try {
      const { script } = await api<{ script: Script }>("/api/v1/scripts", {
        method: "POST",
        body: { title: "Novo roteiro", hook: "" },
      });
      await list.reload();
      setSelectedScriptId(script.id);
      showToast("Roteiro criado. Escreva a fala de cada bloco.");
    } catch (err) {
      fail(err, "Não foi possível criar o roteiro.");
    }
  };

  const exportSrt = () => {
    if (!currentApi) return;
    const body = currentApi.blocks
      .filter((b) => b.speech.trim())
      .map((b, i) => `${i + 1}\n${srtTime(b.start_s)} --> ${srtTime(b.end_s)}\n${b.speech.trim()}\n`)
      .join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "application/x-subrip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentApi.title.slice(0, 60) || "roteiro"}.srt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Legenda .srt baixada com os tempos estimados pela fala.");
  };

  // Teleprompter Auto-Scroll Effect
  useEffect(() => {
    if (!isTeleprompterOpen || !isPrompterPlaying) return;
    const interval = setInterval(() => {
      const container = document.getElementById("teleprompter-content-box");
      if (container) {
        container.scrollTop += prompterSpeed;
      }
    }, 40);
    return () => clearInterval(interval);
  }, [isTeleprompterOpen, isPrompterPlaying, prompterSpeed]);

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
        {/* Topo: Logo Clipo e Recolher */}
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

        {/* Links de Navegação */}
        <div className="flex-1 overflow-y-auto px-3.5 py-2 scrollbar-none">
          <nav className="space-y-4">
            {/* Item Início */}
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

            {/* SEÇÃO ESTÚDIO IA (ATIVO EM ROTEIROS) */}
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
                  <li className="relative flex items-center text-white font-semibold">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#00b4d8] bg-[#00e5ff] shadow-[0_0_10px_#00e5ff]" />
                    <Link href="/roteiros" className="w-full py-0.5 text-[#38bdf8]">
                      Roteiros
                    </Link>
                  </li>
                  <li className="relative flex items-center text-[#9db2ce] hover:text-white transition">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#0d3ea7] bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]" />
                    <Link href="/modelos" className="w-full py-0.5">Modelos</Link>
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
          ÁREA PRINCIPAL (MAIN CONTENT)
         ========================================================================= */}
      <div className="flex-1 pl-[270px]">
        {/* HEADER: Busca, Notificações, Título com Montanhas */}
        <header className="relative px-8 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar roteiros, falas, ganchos ou tags..."
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
              onClick={toggleDictation}
              aria-pressed={listening}
              aria-label={listening ? "Parar ditado" : "Ditar fala do roteiro"}
              title={listening ? "Parar ditado" : "Ditar: fale e o texto entra no bloco selecionado"}
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition ${
                listening
                  ? "bg-red-500/15 text-red-400 ring-1 ring-red-500/40"
                  : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
              }`}
            >
              <Mic className={`h-5 w-5 ${listening ? "text-red-400 motion-safe:animate-pulse" : "text-[#38bdf8]"}`} />
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
                  Roteiros & Scripts IA
                </h1>
                <span className="flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#38bdf8] backdrop-blur-md">
                  <Sparkles className="h-3 w-3" />
                  Teleprompter & Cadência Ativos
                </span>
              </div>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Estruture ganchos, controle marcações de tempo e guie a gravação com teleprompter espelhado.
              </p>
            </div>

            {/* Ações Primárias */}
            <div className="relative z-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setIsTeleprompterOpen(true)}
                className="flex h-10 items-center gap-2 rounded-xl border border-[#1b3d6b] bg-[#081b33] px-4 text-xs font-bold text-[#38bdf8] hover:border-[#00a6ff] hover:bg-[#0c2447] transition shadow-md"
              >
                <Maximize2 className="h-4 w-4" />
                <span>Abrir Teleprompter</span>
              </button>

              <button
                type="button"
                onClick={() => void createScript()}
                className="flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-4 text-xs font-bold text-white shadow-[0_0_20px_rgba(0,102,255,0.4)] hover:brightness-110 active:scale-[0.98] transition"
              >
                <Plus className="h-4 w-4" />
                <span>Novo Roteiro</span>
              </button>
            </div>
          </div>
        </header>

        {/* =========================================================================
            CORPO DA PÁGINA (SPLIT VIEW: LISTA DE ROTEIROS + STUDIO DE GRAVAÇÃO)
           ========================================================================= */}
        <main className="px-8 pt-2 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* COLUNA ESQUERDA: LISTA DE ROTEIROS (4 COLUNAS) */}
            <div className="lg:col-span-4 space-y-4">
              {/* Filtros de Status */}
              <div className="flex items-center gap-1.5 rounded-xl border border-[#12233b] bg-[#050e1c] p-1">
                <button
                  type="button"
                  onClick={() => setFilterStatus("todos")}
                  className={`flex-1 rounded-lg py-1.5 text-center text-xs font-semibold transition ${
                    filterStatus === "todos"
                      ? "bg-[#0f2a4f] text-[#38bdf8] shadow"
                      : "text-[#7187a5] hover:text-white"
                  }`}
                >
                  Todos ({scripts.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterStatus("pronto")}
                  className={`flex-1 rounded-lg py-1.5 text-center text-xs font-semibold transition ${
                    filterStatus === "pronto"
                      ? "bg-[#0f2a4f] text-[#38bdf8] shadow"
                      : "text-[#7187a5] hover:text-white"
                  }`}
                >
                  Prontos
                </button>
                <button
                  type="button"
                  onClick={() => setFilterStatus("rascunho")}
                  className={`flex-1 rounded-lg py-1.5 text-center text-xs font-semibold transition ${
                    filterStatus === "rascunho"
                      ? "bg-[#0f2a4f] text-[#38bdf8] shadow"
                      : "text-[#7187a5] hover:text-white"
                  }`}
                >
                  Rascunhos
                </button>
              </div>

              {/* Lista dos Roteiros */}
              <div className="space-y-3">
                {list.loading && !list.data &&
                  Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-28 animate-pulse rounded-2xl border border-[#11233d] bg-[#061224]" />
                  ))}
                {list.data && filteredScripts.length === 0 && (
                  <p className="rounded-2xl border border-dashed border-[#15273f] p-4 text-xs text-[#6e84a3]">
                    {raw.length ? "Nenhum roteiro com esse filtro." : "Sem roteiros ainda. Crie um ou gere a partir de uma ideia."}
                  </p>
                )}
                {filteredScripts.map((item) => {
                  const isSelected = item.id === selectedScriptId;
                  return (
                    <div
                      key={item.id}
                      onClick={() => setSelectedScriptId(item.id)}
                      className={`cursor-pointer rounded-2xl border p-4 transition-all duration-200 ${
                        isSelected
                          ? "border-[#2563eb] bg-[#071a33] shadow-[0_0_20px_rgba(37,99,235,0.25)]"
                          : "border-[#11223a] bg-[#051122]/90 hover:border-[#193a63] hover:bg-[#07162b]"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="rounded-md border border-[#18365c] bg-[#0b213d] px-2 py-0.5 text-[10px] font-semibold text-[#8eb0dc]">
                          {item.niche}
                        </span>
                        <span
                          className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            item.status === "pronto"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                          }`}
                        >
                          {item.status === "pronto" ? "Pronto p/ Gravar" : item.status === "gravado" ? "Gravado" : "Rascunho"}
                        </span>
                      </div>

                      <h3
                        className={`text-sm font-bold leading-snug line-clamp-2 ${
                          isSelected ? "text-white" : "text-[#c2d2ea]"
                        }`}
                      >
                        {item.title}
                      </h3>

                      <p className="mt-2 text-xs italic text-[#7187a5] line-clamp-2">
                        &ldquo;{item.hook}&rdquo;
                      </p>

                      <div className="mt-3 flex items-center justify-between border-t border-[#0e213b] pt-2.5 text-[11px] text-[#5e779d]">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3 text-[#38bdf8]" />
                          {item.targetDuration} ({item.wordCount} palavras)
                        </span>
                        <span className="flex items-center gap-1 font-bold text-[#38bdf8]">
                          <Sparkles className="h-3 w-3" />
                          Score {item.retentionScore}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* COLUNA DIREITA: EDITOR DE ROTEIRO & TIMECODES (8 COLUNAS) */}
            <div className="lg:col-span-8 space-y-5">
              {/* Topo do Script Selecionado: Título & Métricas de Cadência */}
              <div className="rounded-2xl border border-[#142947] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#0f213b] pb-4">
                  <div className="min-w-0">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#00b4d8]">
                      Script Ativo • {currentScript.niche}
                    </span>
                    <h2 className="mt-1 text-lg font-bold text-white leading-snug">
                      {currentScript.title}
                    </h2>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      aria-label="Situação do roteiro"
                      value={currentScript.status}
                      disabled={!hasScript}
                      onChange={(e) => void setStatus(e.target.value as ScriptItem["status"])}
                      className="h-8 rounded-xl border border-[#1b3e6e] bg-[#081d38] px-2 text-xs font-semibold text-[#c4d4eb] focus:outline-none"
                    >
                      <option value="rascunho">Rascunho</option>
                      <option value="pronto">Pronto p/ gravar</option>
                      <option value="gravado">Gravado</option>
                    </Select>
                    {currentApi?.can_undo && (
                      <button
                        type="button"
                        onClick={() => void undoAI()}
                        className="rounded-xl border border-[#1b3e6e] px-3 py-1.5 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
                      >
                        Desfazer IA
                      </button>
                    )}
                    {(["broll", "refine"] as const).map((action) => (
                      <button
                        key={action}
                        type="button"
                        onClick={() => void handleOptimizeAI(action)}
                        disabled={isOptimizing || !hasScript}
                        className="rounded-xl border border-[#1b3e6e] bg-[#081d38] px-3 py-1.5 text-xs font-semibold text-[#38bdf8] hover:border-[#0094ff] hover:text-white transition disabled:opacity-50"
                      >
                        {action === "broll" ? "Sugerir B-roll" : "Refinar fala"}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => void handleOptimizeAI("hook")}
                      disabled={isOptimizing || !hasScript}
                      className="flex items-center gap-1.5 rounded-xl border border-[#1b3e6e] bg-[#081d38] px-3 py-1.5 text-xs font-semibold text-[#38bdf8] hover:border-[#0094ff] hover:text-white transition disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Otimizar Gancho</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsTeleprompterOpen(true)}
                      className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-3.5 py-1.5 text-xs font-bold text-white shadow hover:brightness-110 transition"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                      <span>Gravar</span>
                    </button>
                  </div>
                </div>

                {/* Métricas de Leitura do Roteiro */}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="rounded-xl border border-[#10233d] bg-[#040d1a] p-3 text-center">
                    <span className="text-[10px] font-bold text-[#5e779d] uppercase">Duração Alvo</span>
                    <p className="mt-0.5 text-base font-extrabold text-[#38bdf8]">{currentScript.targetDuration}</p>
                  </div>
                  <div className="rounded-xl border border-[#10233d] bg-[#040d1a] p-3 text-center">
                    <span className="text-[10px] font-bold text-[#5e779d] uppercase">Total de Palavras</span>
                    <p className="mt-0.5 text-base font-extrabold text-white">{currentScript.wordCount}</p>
                  </div>
                  <div className="rounded-xl border border-[#10233d] bg-[#040d1a] p-3 text-center">
                    <span className="text-[10px] font-bold text-[#5e779d] uppercase">Cadência Ideal</span>
                    <p className="mt-0.5 text-base font-extrabold text-[#10b981]">{currentScript.wpm} WPM</p>
                  </div>
                  <div className="rounded-xl border border-[#10233d] bg-[#040d1a] p-3 text-center">
                    <span className="text-[10px] font-bold text-[#5e779d] uppercase">Score de Retenção</span>
                    <p className="mt-0.5 text-base font-extrabold text-[#38bdf8]">{currentScript.retentionScore}/100</p>
                  </div>
                </div>
              </div>

              {/* Blocos de Atos Estruturados com Linha do Tempo Visual */}
              <div className="space-y-4">
                {currentScript.blocks.map((block, index) => (
                  <div
                    key={block.id}
                    className="relative rounded-2xl border border-[#12253f] bg-[#051122]/90 p-5 shadow-[0_4px_20px_rgba(0,10,25,0.4)] backdrop-blur-sm transition hover:border-[#1d4373]"
                  >
                    {/* Cabeçalho do Bloco: Timestamp e Título do Ato */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#0e213b] pb-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex items-center gap-1 rounded-lg border border-[#183a66] bg-[#091f3a] px-2.5 py-0.5 text-xs font-bold text-[#38bdf8]">
                          <Clock className="h-3 w-3" />
                          {block.timeRange}
                        </span>
                        <h4 className="text-sm font-bold text-white">{block.actLabel}</h4>
                      </div>

                      {block.emphasisWord && (
                        <span className="rounded-md border border-purple-500/20 bg-purple-500/10 px-2 py-0.5 text-[10px] font-bold text-purple-300">
                          Ênfase: &ldquo;{block.emphasisWord}&rdquo;
                        </span>
                      )}
                    </div>

                    {/* Texto da Fala (Teleprompter Copy Editável) */}
                    <div className="mt-3">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-[#5e779d]">
                        Fala do Criador (Voz / Teleprompter)
                      </label>
                      <textarea
                        value={block.speechText}
                        onChange={(e) => handleUpdateSpeech(block.id, e.target.value)}
                        onFocus={() => setFocusedBlock(block.id)}
                        rows={3}
                        className="mt-1.5 w-full rounded-xl border border-[#152e4d] bg-[#030914] p-3.5 text-sm leading-relaxed text-[#d6e3f5] focus:border-[#00a6ff] focus:outline-none transition resize-none font-medium"
                      />
                    </div>

                    {/* Instrução Visual & B-Roll Cue */}
                    <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-[#10243e] bg-[#040e1c] p-3 text-xs">
                      <Camera className="h-4 w-4 text-[#00e5ff] shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="font-bold text-[#00e5ff]">Direção de Cena & B-Roll: </span>
                        <span className="text-[#89a4c7]">{block.visualCue}</span>
                      </div>
                    </div>

                    {/* Nota de Cadência / Respiração se houver */}
                    {block.pacingNote && (
                      <div className="mt-2 text-[11px] text-[#5e779d] italic flex items-center gap-1.5 pl-1">
                        <span>🎙️ Ritmo: {block.pacingNote}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Botões do Rodapé do Editor */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#11233d] bg-[#061224] p-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(
                        currentScript.blocks.map((b) => b.speechText).join("\n\n")
                      );
                      showToast("Texto completo copiado para a área de transferência!");
                    }}
                    className="flex items-center gap-1.5 rounded-xl border border-[#162b47] bg-[#091729] px-3.5 py-2 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copiar Texto Integral</span>
                  </button>

                  <button
                    type="button"
                    onClick={exportSrt}
                    disabled={!hasScript}
                    className="flex items-center gap-1.5 rounded-xl border border-[#162b47] bg-[#091729] px-3.5 py-2 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Exportar SRT / Legenda</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setIsTeleprompterOpen(true)}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-5 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,102,255,0.4)] hover:brightness-110 transition"
                >
                  <Maximize2 className="h-4 w-4" />
                  <span>Iniciar Sessão de Gravação</span>
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* =========================================================================
          MODAL DE TELEPROMPTER FULLSCREEN PRO
         ========================================================================= */}
      {isTeleprompterOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#02060f] animate-in fade-in">
          {/* Barra de Ferramentas Superior do Teleprompter */}
          <div className="flex items-center justify-between border-b border-[#0f1f35] bg-[#040b17] px-6 py-3.5">
            <div className="flex items-center gap-3">
              <span className="flex h-3 w-3 rounded-full bg-rose-500 animate-pulse" />
              <span className="text-sm font-bold text-white">Teleprompter Clipo</span>
              <span className="text-xs text-[#7187a5]">• {currentScript.title}</span>
            </div>

            {/* Controles de Reprodução */}
            <div className="flex items-center gap-4">
              {/* Play / Pause */}
              <button
                type="button"
                onClick={() => setIsPrompterPlaying(!isPrompterPlaying)}
                className="flex items-center gap-2 rounded-xl bg-[#0066ff] px-4 py-1.5 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,102,255,0.5)] hover:bg-[#0055dd] transition"
              >
                {isPrompterPlaying ? (
                  <>
                    <Pause className="h-3.5 w-3.5 fill-current" />
                    <span>Pausar (Espaço)</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 fill-current" />
                    <span>Rolar Texto</span>
                  </>
                )}
              </button>

              {/* Velocidade (WPM / Velocidade de rolagem) */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[#7187a5]">Velocidade:</span>
                <input
                  type="range"
                  min="1"
                  max="6"
                  value={prompterSpeed}
                  onChange={(e) => setPrompterSpeed(Number(e.target.value))}
                  className="w-24 accent-[#00b4d8] cursor-pointer"
                />
                <span className="font-bold text-white">{prompterSpeed}x</span>
              </div>

              {/* Tamanho da Fonte */}
              <div className="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => setPrompterFontSize((s) => Math.max(24, s - 4))}
                  className="rounded-lg border border-[#142640] px-2 py-1 text-[#8fa2be] hover:text-white"
                >
                  A-
                </button>
                <button
                  type="button"
                  onClick={() => setPrompterFontSize((s) => Math.min(64, s + 4))}
                  className="rounded-lg border border-[#142640] px-2 py-1 text-[#8fa2be] hover:text-white"
                >
                  A+
                </button>
              </div>

              {/* Modo Espelho para Hardware Físico */}
              <button
                type="button"
                onClick={() => setIsPrompterMirrored(!isPrompterMirrored)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                  isPrompterMirrored
                    ? "border-[#00b4d8] bg-[#00b4d8]/20 text-[#00b4d8]"
                    : "border-[#142640] text-[#7187a5] hover:text-white"
                }`}
              >
                Espelhar
              </button>
            </div>

            {/* Sair */}
            <button
              type="button"
              onClick={() => {
                setIsTeleprompterOpen(false);
                setIsPrompterPlaying(false);
              }}
              className="flex items-center gap-1 rounded-xl border border-[#162942] bg-[#091526] px-3 py-1.5 text-xs font-semibold text-[#8fa2be] hover:text-white"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              <span>Sair</span>
            </button>
          </div>

          {/* Área Central de Leitura com Linha Guia de Olhar */}
          <div className="relative flex-1 overflow-hidden px-8 py-10 flex justify-center">
            {/* Linha guia visual de onde olhar na lente */}
            <div className="pointer-events-none absolute top-1/3 left-0 right-0 z-10 flex items-center justify-between px-10">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[#00b4d8]/40 to-transparent" />
              <span className="mx-4 text-[10px] font-bold uppercase tracking-widest text-[#00e5ff]/70 bg-[#02060f] px-2 py-0.5 rounded border border-[#00b4d8]/30">
                Linha de Olhar da Lente
              </span>
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[#00b4d8]/40 to-transparent" />
            </div>

            {/* Caixa de Texto com Auto-scroll */}
            <div
              id="teleprompter-content-box"
              className={`h-full w-full max-w-4xl overflow-y-auto px-6 py-20 scrollbar-none transition-transform duration-300 ${
                isPrompterMirrored ? "scale-x-[-1]" : ""
              }`}
            >
              <div className="space-y-16">
                {currentScript.blocks.map((block) => (
                  <div key={block.id} className="space-y-3">
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#00b4d8]">
                      <span>{block.timeRange}</span>
                      <span>•</span>
                      <span>{block.actLabel}</span>
                    </div>

                    <p
                      style={{ fontSize: `${prompterFontSize}px` }}
                      className="font-semibold leading-relaxed tracking-wide text-white"
                    >
                      {block.speechText}
                    </p>

                    <div className="rounded-xl border border-[#173052] bg-[#061427]/80 p-3 text-xs text-[#7ea0c7]">
                      🎬 <strong>Cena:</strong> {block.visualCue}
                    </div>
                  </div>
                ))}
                {/* Espaço extra final */}
                <div className="h-96" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


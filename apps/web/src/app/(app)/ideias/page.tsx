"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  Filter,
  Flame,
  Globe,
  HardDrive,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Lightbulb,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Radio,
  RefreshCw,
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
import { compact, type Idea, type IdeaList, type RadarItem, signedPct } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface IdeaItem {
  id: string;
  title: string;
  hook: string;
  score: number;
  category: "viral" | "conversion" | "educational" | "production";
  niche: string;
  format: string;
  estimatedDuration: string;
  effort: "Baixo" | "Médio" | "Alto";
  bulletPoints: string[];
  ctaSuggestion: string;
  platforms: Array<"tiktok" | "instagram" | "youtube" | "linkedin">;
  saved: boolean;
  status: "disponivel" | "roteirizado" | "em_producao";
  trendingGrowth?: string;
}

const EFFORT: Record<Idea["effort"], IdeaItem["effort"]> = { low: "Baixo", medium: "Médio", high: "Alto" };
const STATUS: Record<Idea["status"], IdeaItem["status"]> = {
  available: "disponivel",
  scripted: "roteirizado",
  in_production: "em_producao",
};

function toIdea(i: Idea): IdeaItem {
  return {
    id: i.id,
    title: i.title,
    hook: i.hook,
    score: i.score ?? 0,
    category: i.category,
    niche: i.niche || "Sem nicho",
    format: i.format || "Vídeo curto",
    estimatedDuration: i.duration_s ? `${i.duration_s}s` : "—",
    effort: EFFORT[i.effort],
    bulletPoints: i.bullets,
    ctaSuggestion: i.cta,
    platforms: i.platforms,
    saved: i.saved,
    status: STATUS[i.status],
    trendingGrowth: i.source === "ai" && i.score_reason ? i.score_reason : undefined,
  };
}

const NICHES = ["Tecnologia & IA", "Produtividade", "Design & UX", "Audiovisual & Hardware", "DevOps & Automação"];

export default function IdeiasPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [selectedNiche, setSelectedNiche] = useState<string>("Todos os Nichos");
  const router = useRouter();
  const list = useApi<IdeaList>("/api/v1/ideas");
  const radar = useApi<{ items: RadarItem[]; simulated: boolean }>("/api/v1/ideas/radar");
  const ideas = useMemo(() => (list.data?.items ?? []).map(toIdea), [list.data]);
  const niches = useMemo(() => Array.from(new Set([...NICHES, ...(list.data?.niches ?? [])])), [list.data]);
  const [scripting, setScripting] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [selectedTone, setSelectedTone] = useState("Direto & Disruptivo");
  const [selectedFormat, setSelectedFormat] = useState("Shorts / Reels (< 60s)");
  const [selectedIdeaDetail, setSelectedIdeaDetail] = useState<IdeaItem | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Submenu de vídeos na barra lateral
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  // Exibir toast temporário
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Filtragem de ideias
  const filteredIdeas = useMemo(() => {
    return ideas.filter((idea) => {
      const matchesSearch =
        idea.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        idea.hook.toLowerCase().includes(searchTerm.toLowerCase()) ||
        idea.niche.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesNiche =
        selectedNiche === "Todos os Nichos" || idea.niche === selectedNiche;

      if (!matchesSearch || !matchesNiche) return false;

      if (activeCategory === "all") return true;
      if (activeCategory === "saved") return idea.saved;
      if (activeCategory === "viral") return idea.category === "viral";
      if (activeCategory === "conversion") return idea.category === "conversion";
      if (activeCategory === "educational") return idea.category === "educational";
      if (activeCategory === "production") return idea.status === "em_producao";

      return true;
    });
  }, [ideas, searchTerm, selectedNiche, activeCategory]);

  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  // Salvar / tirar dos favoritos
  const toggleSaveIdea = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return;
    try {
      await api(`/api/v1/ideas/${id}`, { method: "PATCH", body: { saved: !idea.saved } });
      await list.reload();
      showToast(!idea.saved ? "Ideia salva nos favoritos." : "Ideia removida dos favoritos.");
    } catch (err) {
      fail(err, "Não foi possível salvar a ideia.");
    }
  };

  // Gerar ideias com a IA (usa os créditos de IA do plano)
  const handleGenerateIdeas = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const out = await api<{ items: Idea[] }>("/api/v1/ideas/generate", {
        method: "POST",
        body: {
          prompt: promptText.trim(),
          niche: selectedNiche === "Todos os Nichos" ? "" : selectedNiche,
          tone: selectedTone,
          format: selectedFormat,
          count: 3,
        },
      });
      await list.reload();
      setPromptText("");
      showToast(`${out.items.length} ideia(s) nova(s) da IA.`);
    } catch (err) {
      fail(err, "A IA não respondeu. Tente de novo.");
    } finally {
      setIsGenerating(false);
    }
  };

  // Roteirizar: a IA escreve o roteiro e abre no editor de roteiros
  const scriptIdea = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    const idea = list.data?.items.find((i) => i.id === id);
    if (idea?.script_id) {
      router.push(`/roteiros?script=${idea.script_id}`);
      return;
    }
    setScripting(id);
    try {
      const { script } = await api<{ script: { id: string } }>(`/api/v1/ideas/${id}/script`, { method: "POST" });
      router.push(`/roteiros?script=${script.id}`);
    } catch (err) {
      fail(err, "Não foi possível criar o roteiro.");
      setScripting(null);
    }
  };

  const copyHookToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
    showToast("Gancho copiado para a área de transferência!");
  };

  return (
    <div className="flex min-h-screen bg-[#030914] text-[#c3d0e5] font-sans antialiased selection:bg-[#0066ff] selection:text-white">
      {/* Toast Notification Flutuante */}
      {toastMessage && (
        <div className="fixed top-5 right-6 z-50 flex items-center gap-2.5 rounded-xl border border-[#22487a] bg-[#0c1f38]/95 px-4 py-3 text-sm font-semibold text-white shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-3">
          <Sparkles className="h-4 w-4 text-[#00b4d8]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* =========================================================================
          BARRA LATERAL FIXA (SIDEBAR FIDELIDADE 100%)
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

        {/* Links de Navegação com Scroll customizado */}
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

              {/* Botão Vídeos com Submenu Dropdown */}
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

                {/* Subitens de Vídeos */}
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

            {/* SEÇÃO ESTÚDIO IA (ATIVO AQUI) */}
            <div>
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] font-bold tracking-wider text-[#456999] uppercase">
                <span>Estúdio IA</span>
                <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                <span className="h-px flex-1 bg-gradient-to-r from-[#172c47] to-transparent" />
              </div>
              <div className="relative ml-4 pl-4 pt-1 pb-1 before:absolute before:top-2.5 before:bottom-2.5 before:left-[3px] before:w-px before:bg-[#193356]">
                <ul className="space-y-2.5 text-[13px]">
                  <li className="relative flex items-center text-white font-semibold">
                    <span className="absolute -left-[18px] h-2 w-2 rounded-full border border-[#00b4d8] bg-[#00e5ff] shadow-[0_0_10px_#00e5ff]" />
                    <Link href="/ideias" className="w-full py-0.5 text-[#38bdf8]">
                      Ideias de conteúdo
                    </Link>
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
        {/* HEADER: Busca, Notificações, Título com Montanhas e Ação Primária */}
        <header className="relative px-8 pt-5 pb-3">
          {/* Linha 1: Input de Busca e Notificações */}
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar ideias, ganchos, tendências ou palavras-chave..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
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
              <Lightbulb className="h-5 w-5 text-[#f59e0b]" />
            </button>
          </div>

          {/* Linha 2: Banner de Título com Montanhas */}
          <div className="relative mt-4 flex items-center justify-between min-h-[90px] rounded-2xl overflow-hidden px-4">
            {/* Montanhas azuis com fade out lateral suave */}
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

            {/* Título e Subtítulo */}
            <div className="relative z-10 py-2">
              <div className="flex items-center gap-3">
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">
                  Ideias de Conteúdo
                </h1>
                <span className="flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#38bdf8] backdrop-blur-md">
                  <Sparkles className="h-3 w-3" />
                  Radar Preditivo IA
                </span>
              </div>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Descubra ângulos virais, ganchos magnéticos e roteiros de alta retenção gerados pelo algoritmo.
              </p>
            </div>

            {/* Seletor de Nicho */}
            <div className="relative z-10 flex items-center gap-3">
              <div className="relative">
                <Select
                  value={selectedNiche}
                  onChange={(e) => setSelectedNiche(e.target.value)}
                  className="appearance-none h-9 rounded-xl border border-[#1b3557] bg-[#08162b] px-3.5 pr-8 text-xs font-semibold text-white focus:border-[#3b82f6] focus:outline-none cursor-pointer"
                >
                  <option value="Todos os Nichos">Todos os Nichos</option>
                  {niches.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#7187a5]" />
              </div>
            </div>
          </div>
        </header>

        {/* =========================================================================
            CORPO DA PÁGINA
           ========================================================================= */}
        <main className="space-y-6 px-8 pt-2 pb-12">
          {/* 1. GERADOR RÁPIDO COM IA (HERO PROMPT CARD) */}
          <div className="relative overflow-hidden rounded-2xl border border-[#163359] bg-gradient-to-b from-[#081933] to-[#040e1e] p-5 shadow-[0_4px_30px_rgba(0,40,90,0.18)]">
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <Wand2 className="h-4 w-4 text-[#00e5ff]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[#00e5ff]">
                    Gerador Neural de Ângulos Virais
                  </span>
                </div>
                <div className="relative flex items-center">
                  <input
                    type="text"
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleGenerateIdeas()}
                    placeholder="Sobre o que você quer gravar hoje? (ex: 3 automações com agentes que escalam vídeos curtos)..."
                    className="h-11 w-full rounded-xl border border-[#1e3b63] bg-[#030914]/90 px-4 pr-10 text-[13px] text-white placeholder:text-[#526a8c] focus:border-[#00a6ff] focus:outline-none shadow-inner"
                  />
                  {promptText && (
                    <button
                      onClick={() => setPromptText("")}
                      className="absolute right-3 text-xs text-[#7187a5] hover:text-white"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Controles de Tom e Formato + Botão Gerar */}
              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <Select
                  value={selectedTone}
                  onChange={(e) => setSelectedTone(e.target.value)}
                  className="h-11 rounded-xl border border-[#1c385f] bg-[#07172c] px-3 text-xs font-medium text-[#c0d4ed] focus:outline-none cursor-pointer"
                >
                  <option value="Direto & Disruptivo">Direto & Disruptivo</option>
                  <option value="Educacional & Autoridade">Educacional & Autoridade</option>
                  <option value="Storytelling Pessoal">Storytelling Pessoal</option>
                  <option value="Provocativo / Polêmico">Provocativo</option>
                </Select>

                <Select
                  value={selectedFormat}
                  onChange={(e) => setSelectedFormat(e.target.value)}
                  className="h-11 rounded-xl border border-[#1c385f] bg-[#07172c] px-3 text-xs font-medium text-[#c0d4ed] focus:outline-none cursor-pointer"
                >
                  <option value="Shorts / Reels (< 60s)">Shorts / Reels (&lt; 60s)</option>
                  <option value="Teardown Visual">Teardown Visual</option>
                  <option value="Tutorial Prático">Tutorial Prático</option>
                </Select>

                <button
                  type="button"
                  onClick={() => void handleGenerateIdeas()}
                  disabled={isGenerating}
                  className="flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-5 text-[13px] font-bold text-white shadow-[0_0_20px_rgba(0,102,255,0.45)] hover:brightness-110 active:scale-[0.98] transition disabled:opacity-50"
                >
                  {isGenerating ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span>Gerando Ideias...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      <span>Criar Ideias com IA</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Sugestões de Prompts Rápidos */}
            <div className="mt-3 flex items-center gap-2 overflow-x-auto text-[11px] text-[#5e779d] scrollbar-none pt-1">
              <span className="font-semibold text-[#7187a5] shrink-0">Sugestões rápidas:</span>
              <button
                type="button"
                onClick={() => setPromptText("Por que ninguém assiste seu gancho de 5 segundos no Reels")}
                className="shrink-0 rounded-lg border border-[#193356] bg-[#071424] px-2.5 py-1 text-[#8fa2be] hover:border-[#3b82f6] hover:text-white transition"
              >
                Ganchos de 0-3 segundos
              </button>
              <button
                type="button"
                onClick={() => setPromptText("Pipeline de B-Rolls automáticos com SeaweedFS e FFmpeg")}
                className="shrink-0 rounded-lg border border-[#193356] bg-[#071424] px-2.5 py-1 text-[#8fa2be] hover:border-[#3b82f6] hover:text-white transition"
              >
                Automação de B-Rolls
              </button>
              <button
                type="button"
                onClick={() => setPromptText("Como transformar 1 podcast longo em 12 shorts virais")}
                className="shrink-0 rounded-lg border border-[#193356] bg-[#071424] px-2.5 py-1 text-[#8fa2be] hover:border-[#3b82f6] hover:text-white transition"
              >
                Repurposing de Conteúdo
              </button>
            </div>
          </div>

          {/* 2. BARRA DE FILTROS & TABS */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#0f1f35] pb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveCategory("all")}
                className={`flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  activeCategory === "all"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <span>Todas as Ideias</span>
                <span className="rounded-full bg-[#122845] px-1.5 py-0.2 text-[10px] text-[#93b4d8]">
                  {ideas.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveCategory("viral")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  activeCategory === "viral"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Flame className="h-3.5 w-3.5 text-orange-400" />
                <span>Alta Viralidade</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveCategory("conversion")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  activeCategory === "conversion"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Target className="h-3.5 w-3.5 text-emerald-400" />
                <span>Fundo de Funil</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveCategory("educational")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  activeCategory === "educational"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Lightbulb className="h-3.5 w-3.5 text-amber-400" />
                <span>Educacional & Dicas</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveCategory("saved")}
                className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                  activeCategory === "saved"
                    ? "bg-[#0c2445] text-[#38bdf8] border border-[#1b4379]"
                    : "text-[#8fa2be] hover:bg-[#08162b] hover:text-white"
                }`}
              >
                <Bookmark className="h-3.5 w-3.5 text-sky-400" />
                <span>Salvas ({ideas.filter((i) => i.saved).length})</span>
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs text-[#7187a5]">
              <span>Exibindo <b className="text-white">{filteredIdeas.length}</b> ideias mapeadas</span>
            </div>
          </div>

          {/* 3. LAYOUT PRINCIPAL: GRID DE CARDS + PAINEL DE RADAR LATERAL */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* GRID DE CARDS DE IDEIAS (8 COLUNAS) */}
            <div className="lg:col-span-8 space-y-4">
              {list.loading && !list.data ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-52 animate-pulse rounded-2xl border border-[#132742] bg-[#061224]" />
                ))
              ) : list.error && !list.data ? (
                <p role="alert" className="rounded-2xl border border-[#3b1d24] bg-[#1a0b10] p-4 text-sm text-[#fca5a5]">
                  Não foi possível carregar as ideias: {list.error.message}
                </p>
              ) : filteredIdeas.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#15273f] bg-[#050e1a] p-12 text-center">
                  <Lightbulb className="h-10 w-10 text-[#435e82] mb-3" />
                  <p className="text-base font-semibold text-white">Nenhuma ideia encontrada</p>
                  <p className="mt-1 text-xs text-[#6e84a3]">
                    Tente ajustar os filtros ou gere uma nova ideia com o gerador neural acima.
                  </p>
                </div>
              ) : (
                filteredIdeas.map((idea) => (
                  <div
                    key={idea.id}
                    onClick={() => setSelectedIdeaDetail(idea)}
                    className="group relative cursor-pointer rounded-2xl border border-[#12243b] bg-[#061224]/85 p-5 shadow-[0_4px_20px_rgba(0,10,25,0.4)] backdrop-blur-sm transition-all duration-200 hover:border-[#1d4373] hover:shadow-[0_0_25px_rgba(0,102,255,0.12)] hover:bg-[#07162b]"
                  >
                    {/* Header do Card: Badges, Score IA e Botão Salvar */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg border border-[#18365c] bg-[#0c1f38] px-2.5 py-0.5 text-[11px] font-semibold text-[#8eb0dc]">
                          {idea.niche}
                        </span>
                        <span className="rounded-lg border border-[#1a3d66] bg-[#08182d] px-2.5 py-0.5 text-[11px] font-medium text-[#7fa3cc]">
                          {idea.format} • {idea.estimatedDuration}
                        </span>
                        {idea.trendingGrowth && (
                          <span className="flex items-center gap-1 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                            <TrendingUp className="h-3 w-3" />
                            {idea.trendingGrowth}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {/* Score IA Badge */}
                        <div className="flex items-center gap-1.5 rounded-xl border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-bold text-[#38bdf8] shadow-[0_0_10px_rgba(56,189,248,0.2)]">
                          <Sparkles className="h-3.5 w-3.5" />
                          <span>Score {idea.score}</span>
                        </div>

                        {/* Botão de Favoritar */}
                        <button
                          type="button"
                          onClick={(e) => void toggleSaveIdea(idea.id, e)}
                          className={`flex h-8 w-8 items-center justify-center rounded-lg border transition ${
                            idea.saved
                              ? "border-[#0094ff]/40 bg-[#0066ff]/20 text-[#38bdf8]"
                              : "border-[#142640] text-[#5e779d] hover:border-[#1e3b63] hover:text-white"
                          }`}
                          aria-label="Salvar ideia"
                        >
                          <Bookmark className={`h-4 w-4 ${idea.saved ? "fill-current" : ""}`} />
                        </button>
                      </div>
                    </div>

                    {/* Título Principal */}
                    <h3 className="mt-3 text-base font-bold text-white group-hover:text-[#60a5fa] transition">
                      {idea.title}
                    </h3>

                    {/* Gancho Magnético (O Hook de 0-3s) */}
                    <div className="mt-3 rounded-xl border border-[#172e4d] bg-[#040c18] p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#00b4d8]">
                          <Zap className="h-3 w-3" />
                          Gancho de 0 a 3 segundos
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyHookToClipboard(idea.hook);
                          }}
                          className="flex items-center gap-1 text-[11px] font-semibold text-[#6e85a6] hover:text-white transition"
                        >
                          <Copy className="h-3 w-3" />
                          <span>Copiar Gancho</span>
                        </button>
                      </div>
                      <p className="text-[13px] leading-relaxed italic text-[#b5c7df]">
                        &ldquo;{idea.hook}&rdquo;
                      </p>
                    </div>

                    {/* Estrutura Rápida de Retenção */}
                    <div className="mt-3 space-y-1">
                      {idea.bulletPoints.map((bp, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs text-[#8299ba]">
                          <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[#0094ff] shrink-0" />
                          <span>{bp}</span>
                        </div>
                      ))}
                    </div>

                    {/* Rodapé do Card: Plataformas Recomendadas e Ações */}
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#0e1e33] pt-3">
                      {/* Plataformas */}
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-[#5e779d]">Canais:</span>
                        <div className="flex items-center gap-1.5">
                          {idea.platforms.includes("tiktok") && (
                            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#010101] text-[10px] font-bold text-white border border-[#232323]" title="TikTok">
                              TT
                            </span>
                          )}
                          {idea.platforms.includes("instagram") && (
                            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-tr from-amber-500 via-rose-500 to-purple-600 text-[10px] font-bold text-white" title="Instagram">
                              IG
                            </span>
                          )}
                          {idea.platforms.includes("youtube") && (
                            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#ff0000] text-[10px] font-bold text-white" title="YouTube Shorts">
                              YT
                            </span>
                          )}
                          {idea.platforms.includes("linkedin") && (
                            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#0a66c2] text-[10px] font-bold text-white" title="LinkedIn">
                              IN
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Botões de Ação */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={scripting === idea.id}
                          onClick={(e) => void scriptIdea(idea.id, e)}
                          className="flex items-center gap-1.5 rounded-xl border border-[#1b3d6a] bg-[#0c2240] px-3 py-1.5 text-xs font-bold text-[#38bdf8] hover:border-[#00a6ff] hover:bg-[#102d55] transition shadow-sm disabled:opacity-60"
                        >
                          <span>
                            {scripting === idea.id
                              ? "Escrevendo..."
                              : idea.status === "disponivel"
                                ? "Roteirizar com IA"
                                : "Abrir roteiro"}
                          </span>
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* RADAR DE TENDÊNCIAS & INSIGHTS DO ALGORITMO (4 COLUNAS) */}
            <div className="lg:col-span-4 space-y-5">
              {/* Card 1: Radar de Tópicos Quentes */}
              <div className="rounded-2xl border border-[#132742] bg-[#061224] p-5 shadow-[0_4px_25px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f1f35]">
                  <div className="flex items-center gap-2">
                    <Flame className="h-4 w-4 text-orange-400" />
                    <h2 className="text-sm font-bold text-white">Radar do Algoritmo</h2>
                  </div>
                  <span className="rounded-full bg-orange-500/10 px-2 py-0.5 text-[10px] font-bold text-orange-400 border border-orange-500/20">
                    {radar.data?.simulated ? "Simulado" : "Seus vídeos"}
                  </span>
                </div>

                <div className="mt-3 space-y-2.5">
                  {radar.data && radar.data.items.length === 0 && (
                    <p className="rounded-xl border border-dashed border-[#15273f] p-3 text-xs text-[#6e84a3]">
                      Publique vídeos com hashtags: o radar mostra os temas que mais cresceram nos seus resultados.
                    </p>
                  )}
                  {(radar.data?.items ?? []).map((item) => ({
                    keyword: item.keyword,
                    tag: `${compact(item.views)} views em 14 dias`,
                    growth: item.growth_pct == null ? "Novo" : signedPct(item.growth_pct),
                  })).map((topic, i) => (
                    <button
                      type="button"
                      key={i}
                      onClick={() => setPromptText(topic.keyword)}
                      className="group flex w-full text-left items-center justify-between rounded-xl border border-[#122238] bg-[#040c19] p-2.5 cursor-pointer hover:border-[#1d4373] hover:bg-[#07162b] transition"
                    >
                      <div className="min-w-0 pr-2">
                        <p className="truncate text-xs font-semibold text-white group-hover:text-[#38bdf8] transition">
                          {topic.keyword}
                        </p>
                        <span className="text-[10px] text-[#5e779d]">{topic.tag}</span>
                      </div>
                      <span className="shrink-0 text-xs font-bold text-emerald-400">
                        {topic.growth}
                      </span>
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => void radar.reload().then(() => showToast("Radar atualizado com os seus resultados."))}
                  className="mt-3 w-full rounded-xl border border-[#142640] bg-[#08162b] py-2 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
                >
                  Sincronizar Tendências
                </button>
              </div>

              {/* Card 2: Blueprint de Retenção (Dica de IA) */}
              <div className="relative overflow-hidden rounded-2xl border border-[#1a3861] bg-gradient-to-b from-[#091f3d] to-[#051122] p-5">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="h-4 w-4 text-[#38bdf8]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[#38bdf8]">
                    Fórmula de 2026
                  </span>
                </div>
                <h4 className="text-sm font-bold text-white">A Regra dos 2 Cortes no Gancho</h4>
                <p className="mt-1 text-xs leading-relaxed text-[#93b0d4]">
                  Vídeos verticais com 2 variações angulares nos primeiros 3 segundos têm <strong>48% mais probabilidade</strong> de ultrapassar 50% de retenção no TikTok e Reels.
                </p>
                <div className="mt-3 rounded-lg border border-[#193a63] bg-[#030914]/70 p-2 text-[11px] text-[#7ea0c7]">
                  💡 <em>Dica: Não espere o áudio terminar para cortar a imagem.</em>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* =========================================================================
          MODAL DE DETALHES COMPLETOS DA IDEIA (AO CLICAR)
         ========================================================================= */}
      {selectedIdeaDetail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => setSelectedIdeaDetail(null)}
        >
          <div
            className="relative w-full max-w-2xl rounded-2xl border border-[#1d4373] bg-[#05101f] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Fechar */}
            <button
              type="button"
              onClick={() => setSelectedIdeaDetail(null)}
              className="absolute top-5 right-5 text-sm text-[#7187a5] hover:text-white"
            >
              ✕
            </button>

            {/* Cabeçalho do Modal */}
            <div className="flex items-center gap-2 mb-2">
              <span className="rounded-lg border border-[#1e436f] bg-[#0b213d] px-2.5 py-0.5 text-xs font-semibold text-[#38bdf8]">
                {selectedIdeaDetail.niche}
              </span>
              <span className="rounded-lg border border-[#1a3659] bg-[#081729] px-2.5 py-0.5 text-xs font-medium text-[#7fa3cc]">
                {selectedIdeaDetail.format}
              </span>
              <div className="ml-auto mr-8 flex items-center gap-1.5 rounded-xl border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs font-bold text-[#38bdf8]">
                <Sparkles className="h-3 w-3" />
                <span>Score IA {selectedIdeaDetail.score}</span>
              </div>
            </div>

            <h2 className="text-xl font-bold text-white">
              {selectedIdeaDetail.title}
            </h2>

            {/* Gancho em destaque */}
            <div className="mt-4 rounded-xl border border-[#1a3b66] bg-[#030914] p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-[#00e5ff]">
                  Gancho de 0 a 3 segundos (O Hook)
                </span>
                <button
                  type="button"
                  onClick={() => copyHookToClipboard(selectedIdeaDetail.hook)}
                  className="flex items-center gap-1 text-xs font-semibold text-[#38bdf8] hover:underline"
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span>{isCopied ? "Copiado!" : "Copiar Gancho"}</span>
                </button>
              </div>
              <p className="text-sm italic text-[#d3e3f7] leading-relaxed">
                &ldquo;{selectedIdeaDetail.hook}&rdquo;
              </p>
            </div>

            {/* Roteiro Estruturado em 3 Atos */}
            <div className="mt-4 space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-[#5e779d]">
                Estrutura de Retenção Recomendada
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="rounded-xl border border-[#132742] bg-[#07152b] p-3">
                  <span className="text-[10px] font-bold text-[#38bdf8] uppercase">Ato 1 (0-15s)</span>
                  <p className="mt-1 text-xs text-[#a2bad8]">{selectedIdeaDetail.bulletPoints[0]}</p>
                </div>
                <div className="rounded-xl border border-[#132742] bg-[#07152b] p-3">
                  <span className="text-[10px] font-bold text-[#38bdf8] uppercase">Ato 2 (15-40s)</span>
                  <p className="mt-1 text-xs text-[#a2bad8]">{selectedIdeaDetail.bulletPoints[1]}</p>
                </div>
                <div className="rounded-xl border border-[#132742] bg-[#07152b] p-3">
                  <span className="text-[10px] font-bold text-[#38bdf8] uppercase">Ato 3 (CTA)</span>
                  <p className="mt-1 text-xs text-[#a2bad8]">{selectedIdeaDetail.bulletPoints[2]}</p>
                </div>
              </div>
            </div>

            {/* CTA sugerido */}
            <div className="mt-4 rounded-xl border border-[#142640] bg-[#050e1b] p-3">
              <span className="text-xs font-bold text-white">Call to Action (CTA) Recomendado:</span>
              <p className="mt-1 text-xs text-[#8da6c7]">{selectedIdeaDetail.ctaSuggestion}</p>
            </div>

            {/* Ações do Modal */}
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-[#102238] pt-4">
              <button
                type="button"
                onClick={() => setSelectedIdeaDetail(null)}
                className="rounded-xl border border-[#162a45] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#0c1b30] hover:text-white transition"
              >
                Fechar
              </button>
              <button
                type="button"
                disabled={scripting === selectedIdeaDetail.id}
                onClick={(e) => void scriptIdea(selectedIdeaDetail.id, e)}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-5 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,102,255,0.4)] hover:brightness-110 transition disabled:opacity-60"
              >
                <Sparkles className="h-4 w-4" />
                <span>
                  {scripting === selectedIdeaDetail.id
                    ? "Escrevendo o roteiro..."
                    : selectedIdeaDetail.status === "disponivel"
                      ? "Gerar Roteiro Completo com IA"
                      : "Abrir roteiro"}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


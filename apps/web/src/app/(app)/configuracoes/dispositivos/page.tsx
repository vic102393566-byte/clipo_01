"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Bell,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Cpu,
  ExternalLink,
  Flame,
  Globe,
  HardDrive,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Mic,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sliders,
  Smartphone,
  Sparkles,
  Trash2,
  Tv,
  Video as VideoIcon,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { ago } from "@/lib/format";
import { compact, countdown, type SettingsAll } from "@/lib/studio";
import type { Connection } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface SocialChannel {
  id: string;
  name: string;
  handle: string;
  platform: "tiktok" | "instagram" | "youtube" | "linkedin";
  apiSpec: string;
  status: "conectado" | "atencao" | "desconectado";
  followers: string;
  autoPublish: boolean;
  tokenExpiresIn: string;
  lastSync: string;
}

function toChannel(c: Connection, automation: boolean): SocialChannel {
  const exp = c.access_expires_at ? new Date(c.access_expires_at).getTime() : null;
  return {
    id: c.platform,
    name: c.label,
    handle: c.account?.handle ? `@${c.account.handle.replace(/^@/, "")}` : c.configured ? "não conectado" : "sem credenciais no servidor",
    platform: c.platform,
    apiSpec: "API oficial • OAuth 2.0",
    status: c.status === "active" ? "conectado" : c.status === "needs_reconnect" ? "atencao" : "desconectado",
    followers: compact(c.account?.followers ?? null),
    autoPublish: automation && c.status === "active",
    tokenExpiresIn: exp ? countdown(c.access_expires_at) : c.connected ? "renova sozinho" : "—",
    lastSync: c.last_diagnostic ? ago(c.last_diagnostic.created_at) : "sem teste",
  };
}

interface HardwareDevice {
  id: string;
  name: string;
  category: "camera" | "mic" | "display";
  specs: string;
  status: "ativo" | "disponivel";
  icon: LucideIcon;
}


export default function DispositivosConfigPage() {
  const router = useRouter();
  const conns = useApi<{ items: Connection[] }>("/api/v1/connections");
  const settings = useApi<SettingsAll>("/api/v1/settings");
  const automation = settings.data?.workspace.automation.enabled ?? true;
  const raw = conns.data?.items ?? [];
  const channels = raw.map((c) => toChannel(c, automation));
  const connectedCount = raw.filter((c) => c.connected).length;
  const reconnect = raw.filter((c) => c.status === "needs_reconnect").length;
  const followersTotal = raw.reduce((n, c) => n + (c.account?.followers ?? 0), 0);
  const configuredOf = (platform: string) => raw.find((c) => c.platform === platform)?.configured ?? false;
  const [HARDWARE_DEVICES, setDevices] = useState<HardwareDevice[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };
  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  // A publicação automática vale para o workspace inteiro (Fila > Pausar fila).
  const toggleAutoPublish = async () => {
    try {
      await api("/api/v1/settings/workspace", { method: "PATCH", body: { automation: { enabled: !automation } } });
      await settings.reload();
      showToast(automation ? "Fila automática pausada para todas as redes." : "Fila automática religada.");
    } catch (err) {
      fail(err, "Não foi possível mudar a automação.");
    }
  };

  const refresh = async (platform: string, label: string) => {
    try {
      await api(`/api/v1/connections/${platform}/refresh`, { method: "POST" });
      await conns.reload();
      showToast(`Acesso ao ${label} renovado.`);
    } catch (err) {
      fail(err, `Não foi possível renovar o ${label}.`);
    }
  };

  const testChannel = async (platform: string, label: string) => {
    try {
      await api("/api/v1/diagnostics", { method: "POST", body: { target: platform } });
      showToast(`Teste do ${label} iniciado. O resultado aparece em Redes sociais.`);
      window.setTimeout(() => void conns.reload(), 5000);
    } catch (err) {
      fail(err, "Não foi possível testar.");
    }
  };

  const testAll = async () => {
    const connected = raw.filter((c) => c.connected);
    if (!connected.length) {
      showToast("Nenhuma rede conectada para testar.");
      return;
    }
    setIsSyncing(true);
    for (const c of connected) {
      try {
        await api("/api/v1/diagnostics", { method: "POST", body: { target: c.platform } });
      } catch {
        /* o resultado de cada teste aparece na rede */
      }
    }
    setIsSyncing(false);
    showToast(`${connected.length} teste(s) iniciado(s). Os resultados aparecem em cada rede.`);
    window.setTimeout(() => void conns.reload(), 6000);
  };

  const handleSyncTokens = async () => {
    setIsSyncing(true);
    const connected = (conns.data?.items ?? []).filter((c) => c.connected);
    let ok = 0;
    for (const c of connected) {
      try {
        await api(`/api/v1/connections/${c.platform}/refresh`, { method: "POST" });
        ok += 1;
      } catch {
        /* a rede marca a conexão para reconectar; a lista mostra */
      }
    }
    await conns.reload();
    setIsSyncing(false);
    showToast(connected.length ? `${ok} de ${connected.length} acesso(s) renovado(s).` : "Nenhuma rede conectada.");
  };

  // Câmera e microfone: lidos do navegador (com permissão), nada vai para o servidor.
  const detectDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const list = await navigator.mediaDevices.enumerateDevices();
      stream.getTracks().forEach((t) => t.stop());
      setDevices(
        list
          .filter((d) => d.kind !== "audiooutput")
          .map((d, i) => ({
            id: d.deviceId || String(i),
            name: d.label || (d.kind === "videoinput" ? "Câmera" : "Microfone"),
            category: d.kind === "videoinput" ? "camera" : "mic",
            specs: d.kind === "videoinput" ? "Entrada de vídeo deste aparelho" : "Entrada de áudio deste aparelho",
            status: i === 0 ? "ativo" : "disponivel",
            icon: d.kind === "videoinput" ? Camera : Mic,
          })),
      );
      showToast("Dispositivos deste aparelho detectados.");
    } catch {
      showToast("O navegador não liberou câmera e microfone.");
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
          ÁREA PRINCIPAL: CANAIS CONECTADOS & DISPOSITIVOS
         ========================================================================= */}
      <div className="flex-1 pl-[270px]">
        {/* Header com Breadcrumb, Título & Montanhas */}
        <header className="relative px-8 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <div className="relative w-full max-w-[480px]">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#587194]" />
              <input
                type="text"
                placeholder="Buscar redes sociais, handles, câmeras ou microfones..."
                className="h-10 w-full rounded-xl border border-[#162942] bg-[#061120] pr-12 pl-10 text-[13px] text-[#cad5e6] placeholder:text-[#587194] focus:border-[#3b82f6] focus:outline-none transition shadow-inner"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-[#1d3557] bg-[#0c1f38] px-1.5 py-0.5 text-[11px] font-semibold text-[#5e779d]">
                ⌘ K
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void testAll()}
                className="flex h-10 items-center gap-2 rounded-xl border border-[#162b45] bg-[#07162b] px-3.5 text-xs font-semibold text-[#8fa2be] hover:border-[#3b82f6] hover:text-white transition"
              >
                <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin text-[#00e5ff]" : ""}`} />
                <span>Testar Conexões</span>
              </button>

              <button
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[#8fa2be] transition hover:bg-[#08162b] hover:text-white"
                aria-label="Notificações"
              >
                <Bell className="h-5 w-5 text-[#38bdf8]" />
              </button>
            </div>
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

            <div className="relative z-10 py-2 flex items-center gap-4">
              <Link
                href="/configuracoes"
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#19365c] bg-[#081b33] text-[#7187a5] hover:border-[#00a6ff] hover:text-white transition shadow-sm"
                title="Voltar para Configurações"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-[26px] font-extrabold tracking-tight text-white">
                    Canais Conectados & Dispositivos
                  </h1>
                  <span className="flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-bold text-[#38bdf8] backdrop-blur-md">
                    <Check className="h-3.5 w-3.5" />
                    {connectedCount} rede(s) conectada(s) • OAuth 2.0
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-[#7187a5]">
                  Gerencie as credenciais das redes sociais, permissões de publicação direta e periféricos de estúdio.
                </p>
              </div>
            </div>

            <div className="relative z-10 flex items-center gap-2.5">
              <Link
                href="/configuracoes"
                className="flex h-10 items-center gap-2 rounded-xl border border-[#1a3861] bg-[#07162b] px-4 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
              >
                <span>Central de Hubs</span>
              </Link>

              <button
                type="button"
                onClick={() => router.push("/contas")}
                className="flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-[#0066ff] to-[#00b4d8] px-4 text-xs font-bold text-white shadow-[0_0_20px_rgba(0,102,255,0.4)] hover:brightness-110 active:scale-[0.98] transition"
              >
                <Plus className="h-4 w-4" />
                <span>Conectar Novo Canal</span>
              </button>
            </div>
          </div>
        </header>

        {/* =========================================================================
            CORPO DA PÁGINA (ESTILO DASHBOARD CLIPO)
           ========================================================================= */}
        <main className="space-y-6 px-8 pt-2 pb-12">
          {/* 1. ROW DE KPIS DE CONECTIVIDADE */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Canais Integrados</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/10 text-[#00e5ff]">
                  <Share2 className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">{connectedCount} / {raw.length || 3} Redes</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className={`${reconnect ? "text-amber-400" : "text-emerald-400"} font-bold`}>
                  ● {connectedCount === 0 ? "Nenhuma conectada" : reconnect ? `${reconnect} para reconectar` : "Todas em dia"}
                </span>
                <span className="text-[#5e779d]">TikTok, Instagram, YouTube</span>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Saúde das Chaves</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-[#10b981]">
                  <ShieldCheck className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">
                {connectedCount === 0 ? "—" : reconnect ? "Atenção" : "Válidas"}
              </p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-emerald-400 font-bold">Renovação automática</span>
                <span className="text-[#5e779d]">Tokens criptografados</span>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Alcance Combinado</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/10 text-[#38bdf8]">
                  <Flame className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">{connectedCount ? compact(followersTotal) : "—"}</p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-[#38bdf8]">Seguidores Totais</span>
                <span className="text-[#5e779d]">das redes conectadas</span>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-[#122642] bg-[#061224]/90 p-4 shadow-[0_4px_20px_rgba(0,10,25,0.3)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#7187a5]">Dispositivos Físicos</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-purple-500/20 bg-purple-500/10 text-[#c084fc]">
                  <Camera className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold text-white">
                {HARDWARE_DEVICES.length ? `${HARDWARE_DEVICES.length} detectado(s)` : "Não detectados"}
              </p>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-emerald-400 font-bold">● Deste aparelho</span>
                <span className="text-[#5e779d]">Câmera e microfone</span>
              </div>
            </div>
          </div>

          {/* 2. GRID PRINCIPAL: CARDS DOS CANAIS SOCIAIS (7 COLUNAS) + PERIFÉRICOS DE ESTÚDIO (5 COLUNAS) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* COLUNA ESQUERDA: LISTA DE REDES SOCIAIS (7 COLUNAS) */}
            <div className="lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between pb-1 border-b border-[#0f1f35]">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-[#00e5ff]" />
                  <h2 className="text-sm font-bold text-white">Redes Sociais & APIs de Postagem</h2>
                </div>
                <span className="text-xs text-[#7187a5]">Tokens com renovação automática</span>
              </div>

              {channels.map((channel) => (
                <div
                  key={channel.id}
                  className="rounded-2xl border border-[#12243d] bg-[#061224]/85 p-5 shadow-[0_4px_25px_rgba(0,10,25,0.4)] backdrop-blur-sm transition-all duration-200 hover:border-[#1d4373] hover:shadow-[0_0_25px_rgba(0,102,255,0.12)]"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    {/* Identidade do Canal */}
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[#173863] bg-[#07162b] shadow-md">
                        {channel.platform === "tiktok" && (
                          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-black text-xs font-bold text-white border border-[#222]">
                            TT
                          </span>
                        )}
                        {channel.platform === "instagram" && (
                          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 via-rose-500 to-purple-600 text-xs font-bold text-white">
                            IG
                          </span>
                        )}
                        {channel.platform === "youtube" && (
                          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#ff0000] text-xs font-bold text-white">
                            YT
                          </span>
                        )}
                        {channel.platform === "linkedin" && (
                          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#0a66c2] text-xs font-bold text-white">
                            IN
                          </span>
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-white truncate">{channel.name}</h3>
                          <span
                            className={`flex items-center gap-1 rounded-md border px-2 py-0.2 text-[10px] font-bold ${
                              channel.status === "conectado"
                                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                                : channel.status === "atencao"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                  : "border-[#1e3352] bg-[#0a1a2e] text-[#7187a5]"
                            }`}
                          >
                            {channel.status === "conectado" ? <Check className="h-3 w-3" /> : null}
                            {channel.status === "conectado" ? "Ativo" : channel.status === "atencao" ? "Reconectar" : "Desconectado"}
                          </span>
                        </div>
                        <p className="text-xs font-semibold text-[#38bdf8] mt-0.5">{channel.handle}</p>
                        <p className="text-[11px] text-[#5e779d] mt-0.5 truncate">{channel.apiSpec}</p>
                      </div>
                    </div>

                    {/* Métrica de Seguidores & Switch de Publicação Automática */}
                    <div className="flex items-center justify-between sm:justify-end gap-5 border-t sm:border-t-0 border-[#0f1f35] pt-3 sm:pt-0">
                      <div className="text-left sm:text-right">
                        <p className="text-sm font-extrabold text-white">{channel.followers}</p>
                        <span className="text-[10px] text-[#5e779d]">Seguidores</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[#7187a5]">Postar auto:</span>
                        <button
                          type="button"
                          onClick={() => void toggleAutoPublish()}
                          title="Vale para todas as redes do workspace"
                          className={`relative h-6 w-11 rounded-full transition cursor-pointer p-0.5 ${
                            channel.autoPublish
                              ? "bg-[#0066ff] shadow-[0_0_10px_rgba(0,102,255,0.4)]"
                              : "bg-[#182c47]"
                          }`}
                        >
                          <span
                            className={`block h-5 w-5 rounded-full bg-white shadow-md transition-transform ${
                              channel.autoPublish ? "translate-x-5" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Rodapé do Card com Status do Token e Ações */}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#0e213b] pt-3 text-[11px] text-[#5e779d]">
                    <div className="flex items-center gap-3">
                      <span>Token expira em: <strong className="text-[#a0b8d8]">{channel.tokenExpiresIn}</strong></span>
                      <span>•</span>
                      <span>Sincronizado: <strong className="text-[#a0b8d8]">{channel.lastSync}</strong></span>
                    </div>

                    <div className="flex items-center gap-2">
                      {channel.status === "conectado" ? (
                        <button
                          type="button"
                          onClick={() => void testChannel(channel.platform, channel.name)}
                          className="rounded-lg border border-[#162d4a] bg-[#08182b] px-2.5 py-1 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
                        >
                          Testar
                        </button>
                      ) : (
                        <a
                          href={configuredOf(channel.platform) ? `/api/v1/connections/${channel.platform}/connect` : undefined}
                          aria-disabled={!configuredOf(channel.platform)}
                          title={configuredOf(channel.platform) ? undefined : "O servidor ainda não tem as credenciais do app desta rede"}
                          className={`rounded-lg border border-[#162d4a] bg-[#08182b] px-2.5 py-1 text-xs font-semibold transition ${
                            configuredOf(channel.platform) ? "text-[#8fa2be] hover:text-white" : "pointer-events-none text-[#3d5677]"
                          }`}
                        >
                          {channel.status === "atencao" ? "Reconectar" : "Conectar"}
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => void refresh(channel.platform, channel.name)}
                        disabled={channel.status === "desconectado"}
                        className="rounded-lg border border-[#1b3d6a] bg-[#0c2240] px-2.5 py-1 text-xs font-bold text-[#38bdf8] hover:border-[#00a6ff] hover:bg-[#102d55] transition disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Renovar Token
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* COLUNA DIREITA: HARDWARE DE ESTÚDIO & BYPASS DE REDE (5 COLUNAS) */}
            <div className="lg:col-span-5 space-y-5">
              {/* Box 1: Dispositivos de Captura & Hardware */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-[#00e5ff]" />
                    <h3 className="text-sm font-bold text-white">Dispositivos de Entrada (Estúdio)</h3>
                  </div>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#10b981]" />
                    {HARDWARE_DEVICES.length ? `${HARDWARE_DEVICES.length} detectado(s)` : "Clique para detectar"}
                  </span>
                </div>

                <div className="mt-3 space-y-3">
                  {HARDWARE_DEVICES.map((dev) => {
                    const IconComp = dev.icon;
                    return (
                      <div
                        key={dev.id}
                        className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#030a17] p-3 text-xs"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#1a3a61] bg-[#07162b] text-[#38bdf8]">
                            <IconComp className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-white truncate">{dev.name}</p>
                            <p className="text-[11px] text-[#5e779d] truncate">{dev.specs}</p>
                          </div>
                        </div>

                        <span className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 shrink-0">
                          {dev.status === "ativo" ? "Ativo" : "Pronto"}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => void detectDevices()}
                  className="mt-3 w-full rounded-xl border border-[#162d4a] bg-[#08182b] py-2 text-xs font-semibold text-[#8fa2be] hover:text-white transition"
                >
                  Detectar câmera e microfone
                </button>
              </div>

              {/* Box 2: Proxy Residencial Inteligente & Segurança de IP */}
              <div className="rounded-2xl border border-[#122642] bg-[#061224] p-5 shadow-[0_4px_30px_rgba(0,15,35,0.4)]">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f213b]">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-[#38bdf8]" />
                    <h3 className="text-sm font-bold text-white">Como o Clipo publica</h3>
                  </div>
                  <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-[#38bdf8] border border-sky-500/20">
                    APIs oficiais
                  </span>
                </div>
                <div className="mt-3 space-y-3 text-xs text-[#7ea0c7]">
                  <p>
                    Cada publicação sai pela API oficial da rede, com o acesso que você autorizou (OAuth). Sem proxy de IP e
                    sem disfarçar o app: é isso que mantém a conta longe de bloqueios.
                  </p>
                  <p>
                    Fila automática do workspace:{" "}
                    <strong className={automation ? "text-emerald-400" : "text-amber-400"}>{automation ? "ligada" : "pausada"}</strong>.
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


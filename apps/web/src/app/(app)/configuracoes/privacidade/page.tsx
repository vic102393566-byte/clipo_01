"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  Fingerprint,
  HardDrive,
  Key,
  Layers,
  LayoutDashboard,
  Lock,
  RotateCcw,
  Save,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  Video as VideoIcon,
  Zap,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { ago } from "@/lib/format";
import type { SettingsAll } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface AuditLog {
  id: string;
  action: string;
  actor: string;
  ip: string;
  status: "Sucesso" | "Aviso" | "Alerta";
  time: string;
}

type Activity = { id: string; event: string; message: string; level: string; outcome: string | null; ip: string | null; at: string };

function toLog(x: Activity): AuditLog {
  return {
    id: x.id,
    action: x.message,
    actor: x.event,
    ip: x.ip ?? "—",
    status: x.outcome === "denied" || x.level === "error" ? "Alerta" : x.level === "warning" ? "Aviso" : "Sucesso",
    time: ago(x.at),
  };
}

const SOON = "Em breve";

export default function PrivacidadeConfiguracoesPage() {
  const settings = useApi<SettingsAll>("/api/v1/settings");
  const activity = useApi<{ items: Activity[] }>("/api/v1/account/activity");
  const AUDIT_LOGS = (activity.data?.items ?? []).slice(0, 12).map(toLog);
  const canEdit = settings.data?.can_edit_workspace ?? false;
  const zeroDataRetention = false;
  const stripExif = true;
  const anonymizeAnalytics = false;
  const autoPurgeDays = String(settings.data?.workspace.privacy.trash_days ?? 7);
  const strictIpMode = settings.data?.me.strict_ip ?? false;
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };
  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  const setAutoPurgeDays = async (days: string) => {
    try {
      await api("/api/v1/settings/workspace", { method: "PATCH", body: { privacy: { trash_days: Number(days) } } });
      await settings.reload();
      showToast(`Itens da lixeira somem de vez em ${days} dias.`);
    } catch (err) {
      fail(err, "Não foi possível mudar o prazo.");
    }
  };

  const setStrictIpMode = async (enabled: boolean) => {
    try {
      await api("/api/v1/settings/me", { method: "PATCH", body: { strict_ip: enabled } });
      await settings.reload();
      showToast(enabled ? "IP estrito ligado." : "IP estrito desligado.");
    } catch (err) {
      fail(err, "Não foi possível mudar a proteção.");
    }
  };

  const handleRunAudit = async () => {
    setIsAuditing(true);
    try {
      const out = await api<{ score: number; checks: { ok: boolean; label: string; optional?: boolean }[] }>("/api/v1/account/security-check");
      const pending = out.checks.filter((c) => !c.ok && !c.optional).map((c) => c.label);
      showToast(pending.length ? `Segurança ${out.score}%. Falta: ${pending.join("; ")}.` : `Segurança ${out.score}%: tudo certo.`);
      await activity.reload();
    } catch (err) {
      fail(err, "Não foi possível fazer a checagem.");
    } finally {
      setIsAuditing(false);
    }
  };

  const exportCsv = () => {
    const rows = (activity.data?.items ?? []).map((x) => `${x.at};${x.event};"${x.message.replace(/"/g, "'")}";${x.ip ?? ""}`);
    const url = URL.createObjectURL(new Blob(["\ufeffquando;evento;mensagem;ip\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "clipo-auditoria.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const deleteAccount = async () => {
    const word = window.prompt("Isto agenda a exclusão da conta e de todos os dados. Digite EXCLUIR para confirmar:");
    if (word?.trim().toUpperCase() !== "EXCLUIR") return;
    const current_password = window.prompt("Digite sua senha atual (deixe vazio se você entra só com Google/Apple):") || undefined;
    try {
      await api("/api/v1/account/delete", { method: "POST", body: { confirmation: "EXCLUIR", current_password } });
      window.location.href = "/login";
    } catch (err) {
      fail(err, "Não foi possível agendar a exclusão.");
    }
  };

  return (
    <div className="flex min-h-screen bg-[#030914] text-[#c3d0e5] font-sans antialiased selection:bg-[#0066ff] selection:text-white">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-5 right-6 z-50 flex items-center gap-2.5 rounded-xl border border-[#22487a] bg-[#0c1f38]/95 px-4 py-3 text-sm font-semibold text-white shadow-2xl backdrop-blur-md animate-in fade-in">
          <ShieldCheck className="h-4 w-4 text-[#00e5ff]" />
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
          ÁREA PRINCIPAL: PRIVACIDADE & SEGURANÇA
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
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">Privacidade, Conformidade & Segurança</h1>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Governança de dados de IA, criptografia de tokens em repouso, purga de mídias e auditoria OWASP 2026.
              </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handleRunAudit()}
                disabled={isAuditing}
                className="flex items-center gap-1.5 rounded-xl border border-[#1b3d68] bg-[#07172e] px-3.5 py-2 text-xs font-semibold text-[#38bdf8] hover:border-[#00e5ff] hover:bg-[#0d2342] hover:text-white transition shadow-[0_0_15px_rgba(0,180,216,0.15)] disabled:opacity-50"
              >
                <ShieldCheck className={`h-3.5 w-3.5 text-[#00e5ff] ${isAuditing ? "animate-spin" : ""}`} />
                <span>{isAuditing ? "Auditando..." : "Auditar Políticas"}</span>
              </button>

              <button
                type="button"
                onClick={() => showToast("As mudanças desta tela são salvas na hora.")}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#0055ff] to-[#00c8ff] px-4 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,140,255,0.4)] hover:brightness-110 active:scale-95 transition"
              >
                <Save className="h-3.5 w-3.5" />
                <span>Salvar Políticas</span>
              </button>
            </div>
          </div>
        </div>

        {/* 4 KPIS NO TOPO (PADRÃO CLIPO DE ALTA DENSIDADE) */}
        <div className="px-8 pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Criptografia de Dados</span>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                  AES-256-GCM
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">Chaves Cifradas</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Tokens OAuth e credenciais em repouso</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Privacidade de IA</span>
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#10b981]">
                  Zero-Retention
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">
                {"Sem treino"}
              </p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Seus vídeos não treinam modelos públicos</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Purga Automática DAM</span>
                <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#c084fc]">
                  {autoPurgeDays} Dias
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">SeaweedFS S3</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Exclusão segura de temporários brutos</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Conformidade</span>
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#10b981]">
                  LGPD / GDPR
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">100% Conforme</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">Padrão OWASP GenAI Top 10 2026</p>
            </div>
          </div>
        </div>

        {/* CONTEÚDO PRINCIPAL: 2 COLUNAS (POLÍTICAS + AUDITORIA E DADOS) */}
        <main className="px-8 pt-6 pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* COLUNA ESQUERDA: GOVERNANÇA DE IA & DADOS (7 COLS) */}
            <div className="lg:col-span-7 space-y-6">
              {/* 1. GOVERNANÇA DE IA & PROTEÇÃO DE PROPRIEDADE INTELECTUAL */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Shield className="h-5 w-5 text-[#00e5ff]" />
                    <h2 className="text-base font-bold text-white">
                      Governança de IA & Direitos Autorais (OWASP 2026)
                    </h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#5e779d]">AISVS Tier-2</span>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div>
                      <p className="text-xs font-bold text-white">Opt-Out de Treinamento de LLMs (Zero Data Retention)</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Proíbe contratualmente que Google, OpenAI ou parceiros usem seus vídeos, transcrições e áudios para treino.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={zeroDataRetention}
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
                      <p className="text-xs font-bold text-white">Remoção de Metadados EXIF & GPS dos Arquivos Exportados</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Limpa geolocalização, número de série da câmera Sony e metadados pessoais nos MP4 gerados.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={stripExif}
                        disabled
                        title="Sempre ligado: todo corte e legenda sai sem metadados do arquivo original"
                        readOnly
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] px-4 py-3">
                    <div>
                      <p className="text-xs font-bold text-white">Anonimização de Métricas de Audiência</p>
                      <p className="text-[11px] text-[#5e779d]">
                        Agrupa comentários e visualizações sem armazenar identidades pessoais de seguidores.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={anonymizeAnalytics}
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

              {/* 2. RETENÇÃO DE DADOS & PURGA AUTOMÁTICA */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <HardDrive className="h-5 w-5 text-[#38bdf8]" />
                    <h2 className="text-base font-bold text-white">Ciclo de Vida do Armazenamento (DAM)</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#10b981]">SeaweedFS S3</span>
                </div>

                <div className="mt-4 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#8fa2be] mb-1.5">
                      Prazo da lixeira (vídeos e cortes apagados somem de vez depois de)
                    </label>
                    <Select
                      value={autoPurgeDays}
                      onChange={(e) => void setAutoPurgeDays(e.target.value)}
                      disabled={!canEdit}
                      className="w-full h-10 rounded-xl border border-[#16355d] bg-[#040e1b] px-3 text-xs text-white focus:border-[#00e5ff] focus:outline-none transition"
                    >
                      <option value="7">7 dias</option>
                      <option value="15">15 dias</option>
                      <option value="30">30 dias</option>
                      <option value="60">60 dias</option>
                    </Select>
                  </div>

                  <div className="rounded-xl border border-[#142845] bg-[#050e1c] p-3 text-[11px] text-[#7187a5] leading-relaxed">
                    <p>
                      Vídeos finalizados e métricas de desempenho nunca são excluídos. A purga afeta apenas os arquivos
                      brutos de 4K gravados pela câmera, liberando espaço nos volumes NVMe do servidor.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* COLUNA DIREITA: AUDITORIA, LOGS & PORTABILIDADE (5 COLS) */}
            <div className="lg:col-span-5 space-y-6">
              {/* 3. LOGS DE AUDITORIA & SEGURANÇA */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Fingerprint className="h-5 w-5 text-[#00b4d8]" />
                    <h2 className="text-base font-bold text-white">Trilha de Auditoria Recente</h2>
                  </div>
                  <button
                    type="button"
                    onClick={exportCsv}
                    className="flex items-center gap-1 text-[11px] font-bold text-[#00e5ff] hover:underline"
                  >
                    <Download className="h-3 w-3" />
                    <span>CSV</span>
                  </button>
                </div>

                <div className="mt-4 space-y-2.5">
                  {AUDIT_LOGS.map((log) => (
                    <div
                      key={log.id}
                      className="rounded-xl border border-[#142845] bg-[#050e1c] p-3 hover:border-[#1c3c66] transition"
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold text-white truncate">{log.action}</p>
                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9px] font-bold text-[#10b981] border border-emerald-500/30">
                          {log.status}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] text-[#5e779d]">
                        <span>{log.actor}</span>
                        <span>{log.time}</span>
                      </div>
                      <p className="mt-0.5 text-[9px] text-[#425d7e] font-mono">{log.ip}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* 4. DIREITOS DO TITULAR (LGPD / GDPR) & ZONA DE RISCO */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center gap-2.5 pb-3 border-b border-[#0f2138]">
                  <AlertTriangle className="h-5 w-5 text-[#f59e0b]" />
                  <h2 className="text-base font-bold text-white">Direitos do Titular & Exclusão</h2>
                </div>

                <div className="mt-4 space-y-3">
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = "/api/v1/account/export";
                    }}
                    className="w-full flex items-center justify-between rounded-xl border border-[#1b3d68] bg-[#07172e] p-3 text-xs font-semibold text-white hover:border-[#00e5ff] hover:bg-[#0d2342] transition"
                  >
                    <div className="flex items-center gap-2">
                      <Download className="h-4 w-4 text-[#00b4d8]" />
                      <span>Baixar Cópia Completa dos Dados (LGPD)</span>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[#5e779d]" />
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleRunAudit()}
                    className="w-full flex items-center justify-between rounded-xl border border-[#1b3d68] bg-[#07172e] p-3 text-xs font-semibold text-white hover:border-[#00e5ff] hover:bg-[#0d2342] transition"
                  >
                    <div className="flex items-center gap-2">
                      <RotateCcw className="h-4 w-4 text-[#f59e0b]" />
                      <span>Checar a segurança da conta</span>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[#5e779d]" />
                  </button>

                  <button
                    type="button"
                    onClick={() => void deleteAccount()}
                    className="w-full flex items-center justify-between rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs font-bold text-red-400 hover:bg-red-500/20 hover:text-white transition"
                  >
                    <div className="flex items-center gap-2">
                      <Trash2 className="h-4 w-4" />
                      <span>Excluir minha conta e meus dados</span>
                    </div>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}


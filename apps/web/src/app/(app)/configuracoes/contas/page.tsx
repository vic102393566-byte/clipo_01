"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Copy,
  Globe,
  Key,
  Laptop,
  Layers,
  LayoutDashboard,
  Lock,
  LogOut,
  Mail,
  MoreVertical,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  User,
  UserCheck,
  UserPlus,
  Users,
  Video as VideoIcon,
  Zap,
} from "lucide-react";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import { api, ApiError } from "@/lib/api";
import { ago, day } from "@/lib/format";
import { putFile } from "@/lib/put-file";
import type { Member, SettingsAll } from "@/lib/studio";
import { useApi } from "@/lib/use-api";

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "Proprietário" | "Editor Sênior" | "Roteirista IA" | "Revisor";
  status: "Ativo" | "Pendente";
  avatar: string;
  joinedAt: string;
  lastActive: string;
}

const ROLE_IN: Record<string, "editor" | "writer" | "reviewer"> = {
  "Editor Sênior": "editor",
  "Roteirista IA": "writer",
  Revisor: "reviewer",
};

function toMember(m: Member): TeamMember & { apiId: string; you: boolean } {
  return {
    id: m.id,
    apiId: m.id,
    you: m.you,
    name: m.name,
    email: m.email,
    role: m.role_label as TeamMember["role"],
    status: m.status === "active" ? "Ativo" : "Pendente",
    avatar: m.avatar_url ?? "",
    joinedAt: m.joined_at ? day(m.joined_at) : "Convite enviado",
    lastActive: m.you ? "Agora (sessão atual)" : m.status === "pending" ? "Aguardando o aceite" : m.last_active_at ? ago(m.last_active_at) : "—",
  };
}

interface ActiveSession {
  id: string;
  device: string;
  browser: string;
  location: string;
  ip: string;
  isCurrent: boolean;
  lastSeen: string;
}

type ApiSession = { id: string; current: boolean; last_active_at: string; user_agent: string; ip: string | null; kind: string };

function toSession(x: ApiSession): ActiveSession {
  const ua = x.user_agent;
  const device = /iPhone|iPad/.test(ua) ? "iPhone / iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Aparelho";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua.slice(0, 40) || "Navegador";
  return {
    id: x.id,
    device: x.kind === "support" ? "Suporte do Clipo (só leitura)" : device,
    browser,
    location: x.kind === "support" ? "Acesso de suporte" : "Local não informado",
    ip: x.ip ?? "—",
    isCurrent: x.current,
    lastSeen: x.current ? "Ativo agora" : ago(x.last_active_at),
  };
}

const TIMEZONES: [string, string][] = [
  ["America/Sao_Paulo", "América/São Paulo (UTC −03:00) · Brasília"],
  ["America/Manaus", "América/Manaus (UTC −04:00)"],
  ["America/Noronha", "Fernando de Noronha (UTC −02:00)"],
  ["America/Rio_Branco", "América/Rio Branco (UTC −05:00)"],
  ["Europe/Lisbon", "Europa/Lisboa (UTC +00:00)"],
  ["America/New_York", "América/Nova York (UTC −05:00)"],
  ["UTC", "UTC"],
];

function MemberAvatar({ src, alt, ...rest }: { src: string; alt: string; fill?: boolean; className?: string }) {
  void rest;
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- foto por URL assinada
    <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
  ) : (
    <span className="absolute inset-0 flex items-center justify-center bg-[#0b213d] text-sm font-black text-[#38bdf8]">
      {alt.charAt(0).toUpperCase()}
    </span>
  );
}

export default function ContasConfiguracoesPage() {
  const account = useApi<{ account: { name: string; email: string; avatar_url: string | null; has_password?: boolean } }>("/api/v1/account");
  const team = useApi<{ items: Member[]; seats: { used: number; limit: number }; role: Member["role"] }>("/api/v1/workspace/members");
  const sess = useApi<{ items: ApiSession[] }>("/api/v1/account/sessions");
  const prefs = useApi<SettingsAll>("/api/v1/settings");
  const members = useMemo(() => (team.data?.items ?? []).map(toMember), [team.data]);
  const sessions = useMemo(() => (sess.data?.items ?? []).map(toSession), [sess.data]);
  const seats = team.data?.seats ?? { used: members.length || 1, limit: 1 };
  const viewerIsOwner = team.data?.role === "owner";
  // O formulário nasce com os dados da conta; depois a pessoa edita à vontade.
  const [edited, setEdited] = useState<{ name?: string; email?: string }>({});
  const nameInput = edited.name ?? account.data?.account.name ?? "";
  const emailInput = edited.email ?? account.data?.account.email ?? "";
  const setNameInput = (v: string) => setEdited((e) => ({ ...e, name: v }));
  const setEmailInput = (v: string) => setEdited((e) => ({ ...e, email: v }));
  const twoFactorEnabled = prefs.data?.me.strict_ip ?? false;
  const avatarInput = useRef<HTMLInputElement>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"Editor Sênior" | "Roteirista IA" | "Revisor">("Editor Sênior");
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };
  const fail = (err: unknown, fallback: string) => showToast(err instanceof ApiError ? err.message : fallback);

  const saveProfile = async () => {
    try {
      if (edited.name !== undefined && edited.name.trim() !== account.data?.account.name) {
        await api("/api/v1/account", { method: "PATCH", body: { name: edited.name.trim() } });
      }
      if (edited.email !== undefined && edited.email.trim().toLowerCase() !== account.data?.account.email) {
        const current_password = account.data?.account.has_password === false ? undefined : (window.prompt("Para trocar o e-mail, digite sua senha atual:") ?? "");
        await api("/api/v1/account/email", { method: "POST", body: { new_email: edited.email.trim(), current_password } });
        showToast("Enviamos um link de confirmação para o novo e-mail e para o atual.");
      } else {
        showToast("Perfil salvo.");
      }
      setEdited({});
      await account.reload();
    } catch (err) {
      fail(err, "Não foi possível salvar o perfil.");
    }
  };

  const changeAvatar = async (file: File | undefined) => {
    if (!file) return;
    try {
      const { url, key } = await api<{ url: string; key: string }>("/api/v1/account/avatar/upload-url", {
        method: "POST",
        body: { content_type: file.type, size_bytes: file.size },
      });
      await putFile(url, file, file.type);
      await api("/api/v1/account/avatar", { method: "POST", body: { key } });
      await account.reload();
      showToast("Foto de perfil atualizada.");
    } catch (err) {
      fail(err, "Não foi possível trocar a foto.");
    }
  };

  const timezone = prefs.data?.me.timezone ?? "America/Sao_Paulo";
  const saveTimezone = async (tz: string) => {
    try {
      await api("/api/v1/settings/me", { method: "PATCH", body: { timezone: tz } });
      await prefs.reload();
      showToast("Fuso horário salvo.");
    } catch (err) {
      fail(err, "Não foi possível salvar o fuso.");
    }
  };

  const toggleStrictIp = async (enabled: boolean) => {
    try {
      await api("/api/v1/settings/me", { method: "PATCH", body: { strict_ip: enabled } });
      await prefs.reload();
      showToast(enabled ? "IP estrito ligado: sessões abertas em outra rede caem." : "IP estrito desligado.");
    } catch (err) {
      fail(err, "Não foi possível mudar a proteção.");
    }
  };

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail || !inviteEmail.includes("@")) {
      showToast("Insira um endereço de e-mail válido.");
      return;
    }
    try {
      await api("/api/v1/workspace/invites", { method: "POST", body: { email: inviteEmail.trim(), role: ROLE_IN[inviteRole] } });
      await team.reload();
      setInviteEmail("");
      setIsInviteModalOpen(false);
      showToast(`Convite enviado para ${inviteEmail}.`);
    } catch (err) {
      fail(err, "Não foi possível enviar o convite.");
    }
  };

  const handleRemoveMember = async (id: string, name: string) => {
    if (id === "owner") {
      showToast("O dono do workspace não pode ser removido.");
      return;
    }
    if (!window.confirm(`Remover ${name} do workspace?`)) return;
    try {
      await api(`/api/v1/workspace/members/${id}`, { method: "DELETE" });
      await team.reload();
      showToast(`${name} saiu do workspace.`);
    } catch (err) {
      fail(err, "Não foi possível remover.");
    }
  };

  const changeRole = async (id: string, role: string) => {
    try {
      await api(`/api/v1/workspace/members/${id}`, { method: "PATCH", body: { role: ROLE_IN[role] } });
      await team.reload();
      showToast("Papel atualizado.");
    } catch (err) {
      fail(err, "Não foi possível mudar o papel.");
    }
  };

  const handleDisconnectOtherSessions = async () => {
    try {
      await api("/api/v1/account/sessions/revoke-others", { method: "POST" });
      await sess.reload();
      showToast("As outras sessões foram encerradas.");
    } catch (err) {
      fail(err, "Não foi possível encerrar as sessões.");
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
          ÁREA PRINCIPAL: CONTAS & MEMBROS
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
                <h1 className="text-[26px] font-extrabold tracking-tight text-white">Contas, Equipe & Acessos</h1>
              <p className="mt-1 text-[13px] text-[#7187a5]">
                Perfil do proprietário, gestão de membros da equipe com papéis RBAC e segurança 2FA.
              </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setIsInviteModalOpen(true)}
                className="flex items-center gap-1.5 rounded-xl border border-[#1b3d68] bg-[#07172e] px-3.5 py-2 text-xs font-semibold text-[#38bdf8] hover:border-[#00e5ff] hover:bg-[#0d2342] hover:text-white transition shadow-[0_0_15px_rgba(0,180,216,0.15)]"
              >
                <UserPlus className="h-3.5 w-3.5 text-[#00e5ff]" />
                <span>Convidar Membro</span>
              </button>

              <button
                type="button"
                onClick={() => void saveProfile()}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#0055ff] to-[#00c8ff] px-4 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,140,255,0.4)] hover:brightness-110 active:scale-95 transition"
              >
                <Save className="h-3.5 w-3.5" />
                <span>Salvar Alterações</span>
              </button>
            </div>
          </div>
        </div>

        {/* 4 KPIS NO TOPO (PADRÃO CLIPO DE ALTA DENSIDADE) */}
        <div className="px-8 pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>{viewerIsOwner ? "Dono do workspace" : "Seu perfil"}</span>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                  {team.data?.items.find((m) => m.you)?.role_label ?? "—"}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{nameInput}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">{emailInput}</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Vagas de Membros</span>
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#10b981]">
                  <CurrentPlanName />
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{seats.used} / {seats.limit} Vagas</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">
                {Math.max(0, seats.limit - seats.used)} vaga(s) disponível(is) no plano
              </p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Proteção da sessão</span>
                <span
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${
                    twoFactorEnabled
                      ? "border-emerald-500/30 bg-emerald-500/10 text-[#10b981]"
                      : "border-amber-500/30 bg-amber-500/10 text-[#f59e0b]"
                  }`}
                >
                  {twoFactorEnabled ? "IP estrito" : "Padrão"}
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{twoFactorEnabled ? "IP estrito ligado" : "Sessão padrão"}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">2FA por aplicativo chega numa próxima etapa</p>
            </div>

            <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-[#7187a5]">
                <span>Sessões Ativas</span>
                <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-bold text-[#c084fc]">
                  {sessions.length} Dispositivos
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-white">{sessions.find((x) => x.isCurrent)?.device ?? "—"}</p>
              <p className="mt-1 text-[11px] text-[#5e779d]">
                {sessions.length > 1 ? `Outro aparelho ${sessions.find((x) => !x.isCurrent)?.lastSeen}` : "Só este aparelho"}
              </p>
            </div>
          </div>
        </div>

        {/* CONTEÚDO PRINCIPAL: 2 COLUNAS (PERFIL + MEMBROS + SEGURANÇA) */}
        <main className="px-8 pt-6 pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* COLUNA ESQUERDA: PERFIL DO CRIADOR & CONFIGURAÇÕES PESSOAIS (5 COLS) */}
            <div className="lg:col-span-5 space-y-6">
              {/* 1. PERFIL DO PROPRIETÁRIO */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <User className="h-5 w-5 text-[#00e5ff]" />
                    <h2 className="text-base font-bold text-white">Perfil do Criador Master</h2>
                  </div>
                  <span className="text-[11px] font-semibold text-[#5e779d]">{viewerIsOwner ? "Seu workspace" : "Membro"}</span>
                </div>

                <div className="mt-4 flex items-center gap-4">
                  <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border-2 border-[#1c3c66] shadow-[0_0_20px_rgba(0,102,255,0.25)]">
                    {account.data?.account.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- foto por URL assinada
                      <img src={account.data.account.avatar_url} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center bg-[#0b213d] text-xl font-black text-[#38bdf8]">
                        {nameInput.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">{nameInput}</h3>
                    <p className="text-xs text-[#38bdf8] font-semibold">{viewerIsOwner ? "Dono do workspace" : "Membro do workspace"}</p>
                    <input
                      ref={avatarInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        void changeAvatar(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => avatarInput.current?.click()}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-[#00e5ff] hover:underline"
                    >
                      Alterar avatar
                    </button>
                  </div>
                </div>

                <div className="mt-5 space-y-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-[#8fa2be] mb-1">Nome Completo</label>
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      className="w-full h-10 rounded-xl border border-[#16355d] bg-[#040e1b] px-3 text-xs text-white placeholder:text-[#5e779d] focus:border-[#00e5ff] focus:outline-none transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#8fa2be] mb-1">E-mail Principal</label>
                    <div className="relative">
                      <input
                        type="email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        className="w-full h-10 rounded-xl border border-[#16355d] bg-[#040e1b] pl-3 pr-10 text-xs text-white placeholder:text-[#5e779d] focus:border-[#00e5ff] focus:outline-none transition"
                      />
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center text-emerald-400">
                        <Check className="h-4 w-4" />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#8fa2be] mb-1">Fuso Horário do Painel</label>
                    <Select
                      value={timezone}
                      onChange={(e) => void saveTimezone(e.target.value)}
                      aria-label="Fuso horário"
                      className="w-full h-10 rounded-xl border border-[#16355d] bg-[#040e1b] px-3 text-xs text-white focus:border-[#00e5ff] focus:outline-none transition"
                    >
                      {TIMEZONES.map(([tz, label]) => (
                        <option key={tz} value={tz}>
                          {label}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1 text-[11px] text-[#5e779d]">Usado como padrão ao agendar publicações.</p>
                  </div>
                </div>
              </div>

              {/* 2. AUTENTICAÇÃO & SSO */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center gap-2.5 pb-3 border-b border-[#0f2138]">
                  <ShieldCheck className="h-5 w-5 text-[#10b981]" />
                  <h2 className="text-base font-bold text-white">Segurança & Conexões SSO</h2>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] p-3">
                    <div className="flex items-center gap-2.5">
                      <Lock className="h-4 w-4 text-[#00b4d8]" />
                      <div>
                        <p className="text-xs font-bold text-white">IP estrito</p>
                        <p className="text-[11px] text-[#5e779d]">
                          Encerra a sessão se ela for usada de outra rede (2FA chega numa próxima etapa)
                        </p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={twoFactorEnabled}
                        onChange={(e) => void toggleStrictIp(e.target.checked)}
                        aria-label="IP estrito"
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-[#0e1f36] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#0055ff]"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#040e1b] p-3">
                    <div className="flex items-center gap-2.5">
                      <Globe className="h-4 w-4 text-[#38bdf8]" />
                      <div>
                        <p className="text-xs font-bold text-white">Sincronização em Nuvem (Cloud Sync)</p>
                        <p className="text-[11px] text-[#5e779d]">
                          Modelos, roteiros e preferências ficam na sua conta, em qualquer aparelho
                        </p>
                      </div>
                    </div>
<span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-[#10b981]">
                      Sempre ligado
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* COLUNA DIREITA: GESTÃO DE MEMBROS DA EQUIPE & SESSÕES (7 COLS) */}
            <div className="lg:col-span-7 space-y-6">
              {/* 3. MEMBROS DA EQUIPE (EQUIPE / TRABALHO) */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Users className="h-5 w-5 text-[#38bdf8]" />
                    <h2 className="text-base font-bold text-white">Membros da Equipe & Permissões RBAC</h2>
                  </div>
                  <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                    {seats.used} / {seats.limit} Vagas
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {members.map((member) => {
                    const isOwner = member.role === "Proprietário";
                    return (
                      <div
                        key={member.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[#142845] bg-[#050e1c] p-3.5 hover:border-[#1c3c66] transition"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-[#22487a]">
                            <MemberAvatar
                              src={member.avatar}
                              alt={member.name}
                              fill
                              className="object-cover"
                            />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-xs font-bold text-white truncate">{member.name}</p>
                              {isOwner && (
                                <span className="rounded bg-[#0066ff]/20 px-1.5 py-0.2 text-[9px] font-bold text-[#38bdf8] border border-[#0066ff]/30">
                                  Owner
                                </span>
                              )}
                              {member.status === "Pendente" && (
                                <span className="rounded bg-amber-500/20 px-1.5 py-0.2 text-[9px] font-bold text-[#f59e0b] border border-amber-500/30">
                                  Pendente
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-[#7187a5] truncate">{member.email}</p>
                            <p className="text-[10px] text-[#5e779d] mt-0.5">
                              Último acesso: {member.lastActive}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-end sm:self-center">
                          {viewerIsOwner && !isOwner ? (
                            <Select
                              aria-label={`Papel de ${member.name}`}
                              value={member.role}
                              onChange={(e) => void changeRole(member.id, e.target.value)}
                              className="rounded-lg border border-[#1b3d68] bg-[#07162b] px-2 py-1 text-[11px] font-semibold text-[#8fa2be] focus:outline-none"
                            >
                              <option value="Editor Sênior">Editor Sênior</option>
                              <option value="Roteirista IA">Roteirista IA</option>
                              <option value="Revisor">Revisor</option>
                            </Select>
                          ) : (
                            <span className="rounded-lg border border-[#1b3d68] bg-[#07162b] px-2.5 py-1 text-[11px] font-semibold text-[#8fa2be]">
                              {member.role}
                            </span>
                          )}

                          {!isOwner && (viewerIsOwner || member.you) && (
                            <button
                              type="button"
                              onClick={() => void handleRemoveMember(member.id, member.name)}
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-white transition"
                              title="Remover membro"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 pt-3 border-t border-[#0f2138] flex items-center justify-between text-xs text-[#7187a5]">
                  <span>Precisa de mais vagas para editores?</span>
                  <Link
                    href="/configuracoes/plano"
                    className="text-[#00e5ff] font-bold hover:underline flex items-center gap-1"
                  >
                    <span>Ver planos com mais vagas</span>
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>
              </div>

              {/* 4. SESSÕES CONECTADAS & AUDITORIA DE SEGURANÇA */}
              <div className="rounded-2xl border border-[#132845] bg-[#061224]/90 p-5 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
                  <div className="flex items-center gap-2.5">
                    <Laptop className="h-5 w-5 text-[#00b4d8]" />
                    <h2 className="text-base font-bold text-white">Sessões Conectadas & Auditoria de Acesso</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDisconnectOtherSessions()}
                    className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-bold text-red-400 hover:bg-red-500/20 hover:text-white transition"
                  >
                    <LogOut className="h-3 w-3" />
                    <span>Desconectar Outras</span>
                  </button>
                </div>

                <div className="mt-4 space-y-3">
                  {sessions.map((sess) => (
                    <div
                      key={sess.id}
                      className="flex items-center justify-between rounded-xl border border-[#142845] bg-[#050e1c] p-3.5"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#19355c] bg-[#091b33] text-[#38bdf8]">
                          {sess.device.includes("iPhone") ? (
                            <Smartphone className="h-5 w-5" />
                          ) : (
                            <Laptop className="h-5 w-5" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-xs font-bold text-white">{sess.device}</p>
                            {sess.isCurrent && (
                              <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9px] font-bold text-[#10b981] border border-emerald-500/30">
                                Esta Sessão
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-[#7187a5]">{sess.browser}</p>
                          <p className="text-[10px] text-[#5e779d] mt-0.5">
                            {sess.location} • IP {sess.ip} • {sess.lastSeen}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* MODAL: CONVIDAR MEMBRO */}
      {isInviteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border border-[#1b3d68] bg-[#061224] p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-[#0f2138]">
              <div className="flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-[#00e5ff]" />
                <h3 className="text-base font-bold text-white">Convidar Membro para a Equipe</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsInviteModalOpen(false)}
                className="text-[#7187a5] hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => void handleSendInvite(e)} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#8fa2be] mb-1">
                  E-mail do Convidado
                </label>
                <input
                  type="email"
                  required
                  placeholder="ex: editor@produtora.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="w-full h-10 rounded-xl border border-[#16355d] bg-[#040e1b] px-3 text-xs text-white placeholder:text-[#5e779d] focus:border-[#00e5ff] focus:outline-none transition"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#8fa2be] mb-1">
                  Papel na Organização (RBAC)
                </label>
                <Select
                  value={inviteRole}
                  onChange={(e) =>
                    setInviteRole(e.target.value as "Editor Sênior" | "Roteirista IA" | "Revisor")
                  }
                  className="w-full h-10 rounded-xl border border-[#16355d] bg-[#040e1b] px-3 text-xs text-white focus:border-[#00e5ff] focus:outline-none transition"
                >
                  <option value="Editor Sênior">Editor Sênior (envia, corta, agenda e publica)</option>
                  <option value="Roteirista IA">Roteirista IA (ideias e roteiros com IA)</option>
                  <option value="Revisor">Revisor (vê tudo, sem editar nem publicar)</option>
                </Select>
              </div>

              <div className="rounded-xl border border-[#11243e] bg-[#040e1b] p-3 text-[11px] text-[#7187a5]">
                <p>
                  O membro convidado receberá um link temporário assinado via e-mail para configurar a senha
                  e entrar no workspace do Clipo.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsInviteModalOpen(false)}
                  className="rounded-xl border border-[#1b3d68] bg-[#07172e] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#0d2342] hover:text-white transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#0055ff] to-[#00c8ff] px-4 py-2 text-xs font-bold text-white shadow-[0_0_15px_rgba(0,140,255,0.4)] hover:brightness-110 active:scale-95 transition"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Enviar Convite</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


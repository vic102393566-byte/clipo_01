"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Accessibility,
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Clock,
  Cpu,
  CreditCard,
  Eye,
  Globe,
  HardDrive,
  Key,
  Languages,
  Laptop,
  Layers,
  Layout,
  LayoutDashboard,
  Lightbulb,
  Lock,
  Moon,
  Paintbrush,
  Palette,
  Search,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Sliders,
  Smartphone,
  Sparkles,
  Sun,
  User,
  Users,
  Video as VideoIcon,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "@/components/app/session";
import { Select } from "@/components/ui/clipo-select";
import { CurrentPlanName, CurrentUserAvatar, CurrentUserName } from "@/components/app/current-user";

import type { SettingsAll } from "@/lib/studio";
import type { Billing, Connection } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface SettingHub {
  id: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  category: "geral" | "contas" | "avancado";
  badge?: string;
  details: {
    description: string;
    items: Array<{
      name: string;
      desc: string;
      type: "toggle" | "button" | "select" | "status";
      value?: boolean | string;
    }>;
  };
}

const SETTING_HUBS: SettingHub[] = [
  {
    id: "sistema",
    title: "Sistema",
    subtitle: "Exportação dos cortes, fila da madrugada, status dos serviços e limpeza",
    icon: Laptop,
    category: "geral",
    details: {
      description: "Como os cortes são renderizados e a saúde dos serviços do Clipo.",
      items: [
        { name: "Resolução, fps e qualidade", desc: "Preset aplicado a todo corte renderizado do workspace.", type: "button" },
        { name: "Fila da madrugada", desc: "Cortes pedidos de dia esperam até 1 h para renderizar.", type: "button" },
        { name: "Status dos serviços", desc: "Banco, armazenamento, worker e FFmpeg, com o tempo de resposta.", type: "button" },
      ],
    },
  },
  {
    id: "dispositivos",
    title: "Canais & Dispositivos",
    subtitle: "TikTok, Instagram, YouTube, renovar acesso, testar e câmera/microfone",
    icon: Smartphone,
    category: "geral",
    details: {
      description: "Redes conectadas pela API oficial e os dispositivos deste aparelho.",
      items: [
        { name: "Renovar acessos", desc: "Renova o token de cada rede conectada.", type: "button" },
        { name: "Teste por rede", desc: "Confere conexão, permissões e envio de teste.", type: "button" },
        { name: "Câmera e microfone", desc: "Detectados pelo navegador, com sua permissão.", type: "button" },
      ],
    },
  },
  {
    id: "rede",
    title: "Rede e Webhooks",
    subtitle: "Webhooks assinados para n8n/Zapier e status dos serviços",
    icon: Globe,
    category: "geral",
    details: {
      description: "Avise seus sistemas quando um vídeo fica pronto ou uma publicação sai.",
      items: [
        { name: "Webhooks com HMAC", desc: "Corpo assinado com SHA-256; até 5 tentativas com espera crescente.", type: "button" },
        { name: "Teste de ping", desc: "Envia um evento de teste e mostra o resultado da entrega.", type: "button" },
      ],
    },
  },
  {
    id: "personalizacao",
    title: "Personalização",
    subtitle: "Tema, estilo de legenda padrão, marca d'água e editor",
    icon: Paintbrush,
    category: "geral",
    details: {
      description: "Aparência do editor e o que vai gravado no vídeo final.",
      items: [
        { name: "Estilo de legenda padrão", desc: "O modelo padrão vale quando você grava a legenda num corte.", type: "button" },
        { name: "Marca d'água", desc: "Texto num canto do vídeo, gravado junto com a legenda.", type: "button" },
      ],
    },
  },
  {
    id: "contas",
    title: "Contas & Membros",
    subtitle: "Perfil, foto, equipe com papéis, convites e sessões",
    icon: User,
    category: "contas",
    details: {
      description: "Quem é você e quem trabalha no seu workspace.",
      items: [
        { name: "Equipe", desc: "Editor, Roteirista e Revisor, com vagas conforme o plano.", type: "button" },
        { name: "Sessões", desc: "Aparelhos com sessão aberta; encerre as que não reconhecer.", type: "button" },
      ],
    },
  },
  {
    id: "ia",
    title: "IA & Automações",
    subtitle: "Provedor preferido, criatividade, filtro de palavrões e créditos",
    icon: Sparkles,
    category: "avancado",
    details: {
      description: "Como a IA escreve ideias, roteiros e textos de publicação.",
      items: [
        { name: "Provedor preferido", desc: "Vai primeiro na fila; os outros ficam de reserva.", type: "button" },
        { name: "Créditos de IA", desc: "Cada ação gasta créditos do plano do dono do workspace.", type: "button" },
      ],
    },
  },
  {
    id: "privacidade",
    title: "Privacidade & Segurança",
    subtitle: "Lixeira, IP estrito, auditoria, exportar e excluir dados",
    icon: Lock,
    category: "avancado",
    details: {
      description: "Seus direitos pela LGPD e a segurança da conta.",
      items: [
        { name: "Tokens das redes criptografados", desc: "Guardados cifrados no banco.", type: "status", value: "Ativo" },
        { name: "Metadados removidos", desc: "Todo corte sai sem os metadados do arquivo original.", type: "status", value: "Sempre" },
        { name: "Exportar e excluir", desc: "Baixe seus dados ou agende a exclusão da conta.", type: "button" },
      ],
    },
  },
  {
    id: "plano",
    title: "Assinatura & Faturamento",
    subtitle: "Plano, troca de plano, uso e faturas do Asaas",
    icon: CreditCard,
    category: "contas",
    details: {
      description: "Seu plano, o que ele inclui e as faturas.",
      items: [
        { name: "Trocar de plano", desc: "Subir vale na hora; descer vale no fim do período pago.", type: "button" },
        { name: "Faturas", desc: "Pague por Pix, boleto ou cartão na página do Asaas.", type: "button" },
      ],
    },
  },
];

export default function ConfiguracoesPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();
  const [selectedHub, setSelectedHub] = useState<SettingHub | null>(null);
  const bill = useApi<Billing>("/api/v1/billing");
  const conns = useApi<{ items: Connection[] }>("/api/v1/connections");
  const team = useApi<{ seats: { used: number; limit: number } }>("/api/v1/workspace/members");
  const prefs = useApi<SettingsAll>("/api/v1/settings");
  const badges: Record<string, string | undefined> = {
    plano: bill.data ? `Plano ${bill.data.plan.name}` : undefined,
    dispositivos: conns.data ? `${conns.data.items.filter((c) => c.connected).length} conectada(s)` : undefined,
    contas: team.data ? `${team.data.seats.used}/${team.data.seats.limit} pessoas` : undefined,
    sistema: prefs.data ? (prefs.data.workspace.automation.enabled ? "Fila ativa" : "Fila pausada") : undefined,
  };
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Filtragem dinâmica pela busca (igual ao "Localizar uma configuração")
  const { user } = useSession();
  const isAdmin = ["admin", "super_admin"].includes(user.role);
  const filteredHubs = useMemo(() => {
    // Rede e webhooks são do painel do administrador.
    const hubs = SETTING_HUBS.filter((hub) => hub.id !== "rede" || isAdmin);
    if (!searchQuery.trim()) return hubs;
    const q = searchQuery.toLowerCase();
    return hubs.filter(
      (hub) =>
        hub.title.toLowerCase().includes(q) ||
        hub.subtitle.toLowerCase().includes(q) ||
        hub.details.items.some((i) => i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q))
    );
  }, [searchQuery, isAdmin]);

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

            {/* Item Configurações (ATIVO AQUI) */}
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
          ÁREA PRINCIPAL (MAIN CONTENT)
          Fiel ao layout do Windows Settings, porém com Dark Glass, Neon e Identidade Clipo
         ========================================================================= */}
      <div className="flex-1 pl-[270px]">
        {/* Banner Sutil de Fundo com Montanhas */}
        <div className="relative px-8 pt-8 pb-4">
          <div
            className="absolute top-0 right-16 w-[620px] h-48 pointer-events-none opacity-40"
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

          {/* CABEÇALHO CENTRALIZADO: TÍTULO & CAMPO DE BUSCA (IGUAL AO PRINT) */}
          <div className="relative z-10 mx-auto max-w-2xl text-center pt-4">
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Configurações do Clipo
            </h1>
            <p className="mt-2 text-sm text-[#7187a5]">
              Gerencie preferências do sistema, canais conectados, automações neurais e privacidade.
            </p>

            {/* Input Central: Localizar uma configuração (Fidelidade ao Print) */}
            <div className="relative mx-auto mt-6 max-w-lg">
              <input
                type="text"
                placeholder="Localizar uma configuração..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-11 w-full rounded-xl border border-[#1b3d68] bg-[#061224]/95 pr-11 pl-4 text-sm text-white placeholder:text-[#5e779d] focus:border-[#00e5ff] focus:outline-none focus:ring-1 focus:ring-[#00e5ff] shadow-[0_0_20px_rgba(0,102,255,0.15)] transition"
              />
              <div className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[#38bdf8]">
                <Search className="h-4 w-4" />
              </div>
            </div>
          </div>
        </div>

        {/* =========================================================================
            GRADE DE HUBS DE CONFIGURAÇÃO (LAYOUT BASEADO NO PRINT)
           ========================================================================= */}
        <main className="mx-auto max-w-5xl px-8 pt-6 pb-20">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-8">
            {filteredHubs.map((hub) => {
              const IconComp = hub.icon;
              const isSistema = hub.id === "sistema";
              const isDispositivos = hub.id === "dispositivos";
              const isRede = hub.id === "rede";
              const isPersonalizacao = hub.id === "personalizacao";
              const isContas = hub.id === "contas";
              const isIA = hub.id === "ia";
              const isPrivacidade = hub.id === "privacidade";
              const isPlano = hub.id === "plano";
              const content = (
                <div
                  key={hub.id}
                  onClick={() => {
                    if (
                      !isSistema &&
                      !isDispositivos &&
                      !isRede &&
                      !isPersonalizacao &&
                      !isContas &&
                      !isIA &&
                      !isPrivacidade &&
                      !isPlano
                    )
                      setSelectedHub(hub);
                  }}
                  className="group relative flex flex-col items-center text-center cursor-pointer rounded-2xl border border-transparent p-4 transition-all duration-200 hover:border-[#1c3c66] hover:bg-[#07162b]/80 hover:shadow-[0_0_25px_rgba(0,102,255,0.12)] active:scale-[0.98]"
                >
                  {/* Badge se houver */}
                  {(badges[hub.id] ?? hub.badge) && (
                    <span className="absolute top-2 right-2 rounded-md border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-bold text-[#38bdf8]">
                      {badges[hub.id] ?? hub.badge}
                    </span>
                  )}

                  {/* Ícone no Centro com Estética do Print e Glow Clipo */}
                  <div className="relative mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#16355d] bg-[#07172d] text-[#00b4d8] shadow-[0_0_15px_rgba(0,180,216,0.15)] group-hover:border-[#00e5ff] group-hover:text-[#00e5ff] group-hover:shadow-[0_0_20px_rgba(0,229,255,0.3)] transition-all">
                    <IconComp className="h-7 w-7 transition-transform group-hover:scale-110" />
                  </div>

                  {/* Título do Hub */}
                  <h3 className="text-base font-bold text-white group-hover:text-[#38bdf8] transition">
                    {hub.title}
                  </h3>

                  {/* Subtítulo / Lista de Sub-itens (Fidelidade ao Print) */}
                  <p className="mt-1 text-xs leading-relaxed text-[#7891b2] group-hover:text-[#a0b8d8] transition">
                    {hub.subtitle}
                  </p>
                </div>
              );

              if (isSistema) {
                return (
                  <Link key={hub.id} href="/configuracoes/sistema" className="block">
                    {content}
                  </Link>
                );
              }

              if (isDispositivos) {
                return (
                  <Link key={hub.id} href="/configuracoes/dispositivos" className="block">
                    {content}
                  </Link>
                );
              }

              if (isRede) {
                return (
                  <Link key={hub.id} href="/configuracoes/rede" className="block">
                    {content}
                  </Link>
                );
              }

              if (isPersonalizacao) {
                return (
                  <Link key={hub.id} href="/configuracoes/personalizacao" className="block">
                    {content}
                  </Link>
                );
              }

              if (isContas) {
                return (
                  <Link key={hub.id} href="/configuracoes/contas" className="block">
                    {content}
                  </Link>
                );
              }

              if (isIA) {
                return (
                  <Link key={hub.id} href="/configuracoes/ia" className="block">
                    {content}
                  </Link>
                );
              }

              if (isPrivacidade) {
                return (
                  <Link key={hub.id} href="/configuracoes/privacidade" className="block">
                    {content}
                  </Link>
                );
              }

              if (isPlano) {
                return (
                  <Link key={hub.id} href="/configuracoes/plano" className="block">
                    {content}
                  </Link>
                );
              }

              return content;
            })}
          </div>

          {filteredHubs.length === 0 && (
            <div className="mx-auto mt-8 max-w-md rounded-2xl border border-dashed border-[#152a45] bg-[#050e1a] p-8 text-center">
              <Search className="mx-auto h-8 w-8 text-[#587194] mb-2" />
              <p className="text-sm font-semibold text-white">Nenhuma configuração encontrada</p>
              <p className="mt-1 text-xs text-[#7187a5]">
                Não encontramos resultados para &ldquo;{searchQuery}&rdquo;. Tente buscar por termos como GPU, contas, canais ou notificações.
              </p>
            </div>
          )}
        </main>
      </div>

      {/* =========================================================================
          DRAWER / MODAL DE DETALHES DA CONFIGURAÇÃO SELECIONADA
         ========================================================================= */}
      {selectedHub && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => setSelectedHub(null)}
        >
          <div
            className="relative w-full max-w-xl rounded-2xl border border-[#1d4373] bg-[#051122] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Fechar */}
            <button
              type="button"
              onClick={() => setSelectedHub(null)}
              className="absolute top-5 right-5 text-sm text-[#7187a5] hover:text-white"
            >
              ✕
            </button>

            {/* Cabeçalho do Hub */}
            <div className="flex items-center gap-3 border-b border-[#0f213b] pb-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#1b3e6d] bg-[#081d38] text-[#00e5ff]">
                <selectedHub.icon className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">{selectedHub.title}</h2>
                <p className="text-xs text-[#7187a5]">{selectedHub.details.description}</p>
              </div>
            </div>

            {/* Lista Interativa de Configurações */}
            <div className="mt-5 space-y-3">
              {selectedHub.details.items.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-xl border border-[#11243e] bg-[#030a17] p-3.5"
                >
                  <div className="pr-3 min-w-0">
                    <p className="text-xs font-bold text-white">{item.name}</p>
                    <p className="text-[11px] text-[#7187a5] mt-0.5">{item.desc}</p>
                  </div>

                  <div className="shrink-0">
                    {item.type === "toggle" && (
                      <button
                        type="button"
                        onClick={() => router.push(`/configuracoes/${selectedHub.id}`)}
                        className="relative h-6 w-11 rounded-full bg-[#0066ff] transition cursor-pointer p-0.5 shadow-[0_0_10px_rgba(0,102,255,0.4)]"
                      >
                        <span className="block h-5 w-5 rounded-full bg-white shadow-md translate-x-5 transition-transform" />
                      </button>
                    )}

                    {item.type === "status" && (
                      <span className="flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-400">
                        <Check className="h-3 w-3" />
                        {String(item.value)}
                      </span>
                    )}

                    {item.type === "select" && (
                      <span className="rounded-lg border border-[#1a3861] bg-[#08182d] px-2.5 py-1 text-[11px] font-semibold text-[#38bdf8]">
                        {String(item.value)}
                      </span>
                    )}

                    {item.type === "button" && (
                      <button
                        type="button"
                        onClick={() => router.push(`/configuracoes/${selectedHub.id}`)}
                        className="rounded-lg border border-[#1b3d6a] bg-[#0c2240] px-3 py-1 text-xs font-bold text-[#38bdf8] hover:border-[#00a6ff] hover:bg-[#102d55] transition"
                      >
                        Gerenciar
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Rodapé do Modal */}
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-[#0f213b] pt-4">
              <button
                type="button"
                onClick={() => setSelectedHub(null)}
                className="rounded-xl border border-[#162a45] px-4 py-2 text-xs font-semibold text-[#8fa2be] hover:bg-[#0c1b30] hover:text-white transition"
              >
                Fechar
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedHub(null);
                  showToast("Configurações salvas e aplicadas em todos os nós!");
                }}
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

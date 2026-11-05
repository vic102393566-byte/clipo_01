// Tipos das áreas de criação e resultados (biblioteca, modelos, ideias, roteiros, métricas, equipe).

export type Net = "tiktok" | "instagram" | "youtube" | "linkedin" | "x";

export type ApiAsset = {
  id: string;
  name: string;
  type: "video" | "audio" | "sfx" | "overlay" | "preset";
  type_label: string;
  category: string;
  tags: string[];
  status: "uploading" | "processing" | "ready" | "failed";
  error: string | null;
  content_type: string;
  size_bytes: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bpm: number | null;
  usage_count: number;
  trending: boolean;
  file_url: string | null;
  thumb_url: string | null;
  created_at: string;
};

export type AssetList = {
  items: ApiAsset[];
  counts: Record<"all" | ApiAsset["type"], number>;
  categories: string[];
};

export type Caption = {
  preset: "classico" | "destaque" | "minimal";
  color: string;
  highlight: string | null;
  uppercase: boolean;
  position: "bottom" | "middle" | "top";
  size: number;
};

export type Template = {
  id: string;
  name: string;
  category: "legendas" | "ritmo" | "cores" | "audio";
  category_label: string;
  description: string;
  aspect: "9:16" | "16:9" | "both";
  font_label: string;
  animation: string;
  pacing: "ultra" | "rapido" | "medio" | "lento";
  pacing_label: string;
  cut_seconds: number;
  sfx: string;
  sample_text: string;
  accent: string;
  caption: Caption;
  is_default: boolean;
  usage_count: number;
  created_at: string;
};

export type Idea = {
  id: string;
  title: string;
  hook: string;
  category: "viral" | "conversion" | "educational";
  niche: string;
  format: string;
  duration_s: number | null;
  effort: "low" | "medium" | "high";
  bullets: string[];
  cta: string;
  platforms: Array<"tiktok" | "instagram" | "youtube" | "linkedin">;
  score: number | null;
  score_reason: string;
  saved: boolean;
  status: "available" | "scripted" | "in_production";
  source: "ai" | "manual";
  script_id: string | null;
  created_at: string;
};

export type IdeaList = { items: Idea[]; counts: Record<string, number>; niches: string[] };

export type RadarItem = { keyword: string; views: number; growth_pct: number | null };

export type ScriptBlock = {
  id: string;
  act: string;
  speech: string;
  visual: string;
  emphasis: string;
  pacing_note: string;
  start_s: number;
  end_s: number;
};

export type Script = {
  id: string;
  title: string;
  hook: string;
  niche: string;
  status: "draft" | "ready" | "recorded";
  target_duration_s: number;
  wpm: number;
  word_count: number;
  estimated_duration_s: number;
  retention_score: number | null;
  blocks: ScriptBlock[];
  idea_id: string | null;
  can_undo: boolean;
  created_at: string;
  updated_at: string | null;
};

export type Kpi = { value: number | null; delta_pct: number | null };

export type TopPublication = {
  publication_id: string;
  title: string;
  thumbnail_url: string;
  platforms: Net[];
  views: number;
  views_in_period: number;
  likes: number;
  shares: number;
  comments: number;
  retention_pct: number | null;
  score: number;
  published_at: string | null;
  simulated: boolean;
};

export type Overview = {
  period: "7d" | "30d" | "90d" | "year";
  platform: string | null;
  simulated: boolean;
  has_data: boolean;
  kpis: Record<"views" | "retention" | "engagement" | "shares" | "likes" | "followers", Kpi>;
  series: { day: string; views: number; likes: number }[];
  platforms: { platform: Net; views: number; pct: number }[];
  retention_curve: number[] | null;
  top: TopPublication[];
};

export type Member = {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  avatar_url: string | null;
  role: "owner" | "editor" | "writer" | "reviewer";
  role_label: string;
  status: "active" | "pending";
  joined_at: string | null;
  invited_at?: string;
  last_active_at: string | null;
  you: boolean;
};

export type WorkspaceSettings = {
  automation: { enabled: boolean };
  ai: { provider: "auto" | "gemini" | "anthropic" | "openai" | "local"; creativity: number | null; filter_profanity: boolean };
  render: {
    watermark: { enabled: boolean; text: string; opacity: number; position: "top-left" | "top-right" | "bottom-left" | "bottom-right" };
    night_queue: boolean;
  };
  privacy: { trash_days: 7 | 15 | 30 | 60 };
};

export type MyPrefs = {
  theme_preset: string;
  waveform: boolean;
  timeline_snap: boolean;
  glow: "low" | "medium" | "high";
  strict_ip: boolean;
  timezone: string;
};

export type SettingsAll = { workspace: WorkspaceSettings; me: MyPrefs; role: Member["role"]; can_edit_workspace: boolean };

/** "00:18" / "02:45" para a duração dos cards. */
export function mmss(seconds: number | null | undefined): string {
  if (seconds == null) return "--:--";
  const s = Math.round(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 189400 → "189,4K". */
export function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Variação com sinal: "+12,4%" / "-3%" / "—". */
export function signedPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

/** "Hoje, 18:30" / "Amanhã, 11:30" / "Sex, 26/09, 19:00". */
export function whenLabel(iso: string | null, now = new Date()): string {
  if (!iso) return "Sem data";
  const d = new Date(iso);
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return `Hoje, ${time}`;
  if (diff === 1) return `Amanhã, ${time}`;
  if (diff === -1) return `Ontem, ${time}`;
  const date = d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
  return `${date.charAt(0).toUpperCase()}${date.slice(1).replace(".", "")}, ${time}`;
}

/** "em 42 minutos" / "em 3 horas e 12 min" / "há 5 minutos". */
export function countdown(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - now;
  const mins = Math.round(Math.abs(diff) / 60000);
  const text =
    mins < 1
      ? "agora"
      : mins < 60
        ? `${mins} minuto${mins === 1 ? "" : "s"}`
        : mins < 48 * 60
          ? `${Math.floor(mins / 60)} hora${Math.floor(mins / 60) === 1 ? "" : "s"}${mins % 60 ? ` e ${mins % 60} min` : ""}`
          : `${Math.round(mins / 1440)} dias`;
  if (text === "agora") return "agora";
  return diff >= 0 ? `em ${text}` : `há ${text}`;
}

export const POST_TYPE: Record<string, string> = {
  tiktok: "TikTok Video",
  instagram: "Reels",
  youtube: "Shorts",
  linkedin: "Post de Vídeo",
  x: "Vídeo no Feed",
};

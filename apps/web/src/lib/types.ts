// Formatos das respostas da API v1 usados nas telas.

export type Platform = "youtube" | "instagram" | "tiktok";

export type Video = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  status: "uploading" | "processing" | "ready" | "failed" | "rejected";
  error: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number;
  filename: string | null;
  thumbnail_url: string | null;
  preview_url: string | null;
  source_url: string | null;
  job_id: string | null;
  created_at: string;
  deleted_at: string | null;
  purge_after: string | null;
};

export type Clip = {
  id: string;
  video_id: string;
  title: string;
  description: string;
  tags: string[];
  index: number | null;
  start_s: number;
  end_s: number;
  duration_s: number;
  status: "queued" | "rendering" | "ready" | "failed" | "cancelled";
  size_bytes: number;
  media_url: string | null;
  thumbnail_url: string | null;
  subtitled_url: string | null;
  job_id: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type Usage = {
  plan_id: string;
  storage_used_bytes: number;
  storage_limit_bytes: number;
  uploading_bytes: number;
  videos_this_month: number;
  videos_per_month: number;
  max_file_bytes: number;
  max_duration_seconds: number;
};

export type Target = {
  platform: Platform;
  title: string;
  description: string;
  tags: string[];
  privacy: string;
  status: "pending" | "uploading" | "processing" | "published" | "failed" | "removed";
  remote_id: string | null;
  url: string | null;
  remote_status: string | null;
  error: string | null;
  error_code: string | null;
  uploaded_at: string | null;
  published_at: string | null;
  /** Só na listagem: @ da conta conectada. */
  account?: string | null;
};

export type Publication = {
  id: string;
  source: { kind: "video" | "clip"; id: string };
  title: string;
  status: "draft" | "scheduled" | "paused" | "publishing" | "published" | "partial" | "failed" | "cancelled";
  timezone: string;
  scheduled_at: string | null;
  scheduled_local: string | null;
  targets: Target[];
  job_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

/** Item da listagem (calendário e fila): vem com miniatura, duração e tamanho da origem. */
export type PublicationRow = Publication & {
  thumbnail_url: string | null;
  duration_s: number | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
};

export type Diagnostic = {
  id: string;
  target: string;
  status: "queued" | "running" | "passed" | "warning" | "failed";
  steps: { name: string; status: "ok" | "failed" | "warning" | "skipped"; message: string; ms: number }[];
  created_at: string;
  finished_at: string | null;
};

export type Connection = {
  platform: Platform;
  label: string;
  configured: boolean;
  connected: boolean;
  status: "active" | "needs_reconnect" | "disconnected";
  account: { id: string; name: string; handle: string; avatar_url?: string | null; followers?: number | null } | null;
  connected_at: string | null;
  access_expires_at: string | null;
  last_error: string | null;
  supports_delete: boolean;
  last_diagnostic: Diagnostic | null;
};

export type Plan = {
  id: string;
  name: string;
  price_monthly_cents: number;
  price_yearly_cents: number;
  storage_bytes: number;
  max_file_bytes: number;
  max_duration_seconds: number;
  videos_per_month: number;
  social_accounts: number;
  ai_credits_month: number;
  features: string[];
  public: boolean;
  active: boolean;
  order: number;
};

export type Subscription = {
  status: "trialing" | "active" | "past_due" | "manual" | "expired";
  plan_id: string;
  effective_plan_id: string;
  cycle: "monthly" | "yearly" | null;
  trial_ends_at?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  grace_ends_at?: string | null;
  pending_plan_id?: string | null;
  pending_cycle?: string | null;
  pending_from?: string | null;
  manual_until?: string | null;
  coupon?: { code: string; kind: string; value: number; duration: string } | null;
  document_last4?: string | null;
  checkout: {
    plan_id: string;
    cycle: string;
    invoice_url: string | null;
    first_charge_cents: number;
    value_cents: number;
    created_at: string;
  } | null;
};

export type Billing = {
  gateway: "asaas" | "simulado" | "off";
  subscription: Subscription;
  plan: Plan;
  usage: Usage;
  payments: {
    id: string;
    value_cents: number;
    status: string;
    billing_type: string;
    due_date: string;
    invoice_url: string | null;
    refunded: boolean;
    created_at: string;
  }[];
};

export type Word = { s: number; e: number; w: string };
export type Segment = { start: number; end: number; text: string; words?: Word[] };
export type Transcript = {
  video_id: string;
  status: "processing" | "ready" | "failed";
  language: string | null;
  provider: string;
  model: string;
  word_count: number;
  segments: Segment[];
};

export type Suggestion = {
  id: string;
  video_id: string;
  start_s: number;
  end_s: number;
  duration_s: number;
  title: string;
  hook: string;
  score: number;
  reason: string;
  status: "new" | "accepted" | "dismissed";
  clip_id: string | null;
  created_at: string;
};

export type AiCredits = { month: string; used: number; limit: number; remaining: number; plan: string };

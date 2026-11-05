import { Badge } from "@/components/ui/primitives";
import type { Clip, Publication, Target, Video } from "@/lib/types";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const VIDEO: Record<Video["status"], [string, Tone]> = {
  uploading: ["Enviando", "info"],
  processing: ["Processando", "info"],
  ready: ["Pronto", "success"],
  failed: ["Falhou", "danger"],
  rejected: ["Recusado", "danger"],
};

const CLIP: Record<Clip["status"], [string, Tone]> = {
  queued: ["Na fila", "neutral"],
  rendering: ["Renderizando", "info"],
  ready: ["Pronto", "success"],
  failed: ["Falhou", "danger"],
  cancelled: ["Cancelado", "neutral"],
};

export const PUBLICATION: Record<Publication["status"], [string, Tone]> = {
  draft: ["Rascunho", "neutral"],
  scheduled: ["Agendada", "brand"],
  paused: ["Pausada", "warning"],
  publishing: ["Publicando", "info"],
  published: ["Publicada", "success"],
  partial: ["Parcial", "warning"],
  failed: ["Falhou", "danger"],
  cancelled: ["Cancelada", "neutral"],
};

const TARGET: Record<Target["status"], [string, Tone]> = {
  pending: ["Aguardando", "neutral"],
  uploading: ["Enviando", "info"],
  processing: ["Processando na rede", "info"],
  published: ["Publicado", "success"],
  failed: ["Falhou", "danger"],
  removed: ["Apagado da rede", "neutral"],
};

export function VideoStatus({ status }: { status: Video["status"] }) {
  const [label, tone] = VIDEO[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function ClipStatus({ status }: { status: Clip["status"] }) {
  const [label, tone] = CLIP[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function PublicationStatus({ status }: { status: Publication["status"] }) {
  const [label, tone] = PUBLICATION[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function TargetStatus({ status }: { status: Target["status"] }) {
  const [label, tone] = TARGET[status];
  return <Badge tone={tone}>{label}</Badge>;
}

"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { pumpJobs } from "@/lib/job-pump";

export type Job = {
  id: string;
  type: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  attempts: number;
  error: string | null;
  result: Record<string, unknown>;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export const JOB_DONE = new Set(["done", "failed", "cancelled"]);

export const JOB_LABEL: Record<string, string> = {
  "video.ingest": "Processando vídeo",
  "video.split": "Gerando cortes",
  "clip.render": "Renderizando corte",
  "video.transcribe": "Transcrevendo",
  "video.highlights": "IA escolhendo trechos",
  "clip.subtitles": "Gravando legendas",
  "publication.publish": "Publicando",
  "diagnostic.run": "Teste da integração",
};

/**
 * Andamento de um job: consulta a cada 2 s até terminar e, quando o SSE da API chega ao navegador,
 * usa os eventos em tempo real também.
 */
export function useJob(jobId: string | null | undefined, onFinish?: (job: Job) => void): Job | null {
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: number | undefined;
    let finished = false;

    const accept = (next: Job) => {
      if (stopped) return;
      setJob(next);
      if (JOB_DONE.has(next.status) && !finished) {
        finished = true;
        source?.close();
        onFinish?.(next);
      }
    };

    const poll = async () => {
      if (stopped || finished) return;
      try {
        accept((await api<{ job: Job }>(`/api/v1/jobs/${jobId}`)).job);
      } catch {
        /* tenta de novo no próximo ciclo */
      }
      if (!finished) {
        // Na Vercel, quem faz o job andar é esta chamada (uma por vez, sem travar a consulta).
        void pumpJobs();
        timer = window.setTimeout(poll, 2000);
      }
    };

    // Consulta sempre (proxies podem segurar o fluxo de eventos); o SSE só deixa mais rápido.
    let source: EventSource | null = null;
    try {
      source = new EventSource(`/api/v1/jobs/${jobId}/events`);
      source.addEventListener("job", (e) => accept(JSON.parse((e as MessageEvent).data)));
      source.onerror = () => source?.close();
    } catch {
      source = null;
    }
    void poll();
    return () => {
      stopped = true;
      source?.close();
      if (timer) window.clearTimeout(timer);
    };
    // onFinish muda a cada render; o job é o que importa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  return job;
}

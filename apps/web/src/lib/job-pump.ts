"use client";

import { api } from "@/lib/api";
import { invalidate } from "@/lib/use-api";

/*
 * Na Vercel não há worker ligado o tempo todo: a fila anda quando a tela chama /jobs/pump.
 * Uma chamada por vez (cada uma trabalha até ~45 s). Com um worker de verdade (Docker),
 * a API responde "worker" na primeira vez e as chamadas param.
 */
let running: Promise<void> | null = null;
let hasRealWorker = false;

export function pumpJobs(): Promise<void> {
  if (hasRealWorker) return Promise.resolve();
  if (running) return running;
  running = api<{ mode: string; ran: number }>("/api/v1/jobs/pump", { method: "POST" })
    .then((out) => {
      if (out.mode === "worker") hasRealWorker = true;
      if (out.ran > 0) {
        invalidate("/api/v1/videos");
        invalidate("/api/v1/assets");
        invalidate("/api/v1/publications");
      }
    })
    .catch(() => {
      /* sem sessão ou rede caiu: tenta na próxima */
    })
    .finally(() => {
      running = null;
    });
  return running;
}

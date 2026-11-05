"use client";

import { CheckCircle2, CloudUpload, FileVideo, RotateCcw } from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/primitives";
import { api, ApiError } from "@/lib/api";
import { bytes } from "@/lib/format";
import { invalidate } from "@/lib/use-api";
import { useJob, type Job } from "@/lib/use-job";

type Upload = {
  id: string;
  status: string;
  size_bytes: number;
  part_size: number;
  parts_count: number;
  uploaded_parts: number[];
};

type Phase =
  | { kind: "pick" }
  | { kind: "sending"; sent: number; total: number }
  | { kind: "processing"; jobId: string; videoId: string }
  | { kind: "done"; videoId: string }
  | { kind: "error"; message: string; canResume: boolean };

const UploadContext = createContext<() => void>(() => {});
export const useUpload = () => useContext(UploadContext);

const ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska";
const PARALLEL = 4;
const resumeKey = (f: File) => `clipo:upload:${f.name}:${f.size}:${f.lastModified}`;

function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  // XHR em vez de fetch: só ele informa o andamento do envio.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("rede"));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(blob);
  });
}

/** Envio de vídeo, aberto de qualquer tela pelo botão "Enviar vídeo". */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const job = useJob(phase.kind === "processing" ? phase.jobId : null, (j: Job) => {
    invalidate("/api/v1/videos");
    invalidate("/api/v1/usage");
    if (phase.kind === "processing") {
      setPhase(
        j.status === "done"
          ? { kind: "done", videoId: phase.videoId }
          : { kind: "error", message: j.error ?? "O vídeo não pôde ser processado.", canResume: false },
      );
    }
  });

  const reset = () => {
    setFile(null);
    setTitle("");
    setPhase({ kind: "pick" });
  };

  const close = () => {
    if (phase.kind === "sending") return; // não fecha no meio do envio sem querer
    setOpen(false);
    if (phase.kind !== "processing") reset();
  };

  const choose = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setTitle(f.name.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_-]+/g, " ").trim());
    setPhase({ kind: "pick" });
  };

  const send = useCallback(async () => {
    if (!file) return;
    const controller = new AbortController();
    abort.current = controller;
    try {
      // Retoma um envio interrompido do mesmo arquivo, se ainda existir.
      let upload: Upload | null = null;
      const saved = localStorage.getItem(resumeKey(file));
      if (saved) {
        upload = await api<{ upload: Upload }>(`/api/v1/uploads/${saved}`)
          .then((r) => (r.upload.status === "uploading" ? r.upload : null))
          .catch(() => null);
      }
      if (!upload) {
        upload = (
          await api<{ upload: Upload }>("/api/v1/uploads", {
            method: "POST",
            body: { filename: file.name, content_type: file.type || "video/mp4", size_bytes: file.size },
          })
        ).upload;
        localStorage.setItem(resumeKey(file), upload.id);
      }
      const done = new Set(upload.uploaded_parts);
      const partBytes = (n: number) => Math.min(upload!.part_size, file.size - (n - 1) * upload!.part_size);
      let base = [...done].reduce((sum, n) => sum + partBytes(n), 0);
      const inFlight = new Map<number, number>();
      const report = () =>
        setPhase({ kind: "sending", sent: base + [...inFlight.values()].reduce((a, b) => a + b, 0), total: file.size });
      report();

      const missing = Array.from({ length: upload.parts_count }, (_, i) => i + 1).filter((n) => !done.has(n));
      for (let i = 0; i < missing.length; i += 100) {
        const batch = missing.slice(i, i + 100);
        const { urls } = await api<{ urls: { part_number: number; url: string }[] }>(
          `/api/v1/uploads/${upload.id}/parts`,
          { method: "POST", body: { part_numbers: batch } },
        );
        const queue = [...urls];
        await Promise.all(
          Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
            while (queue.length) {
              const { part_number: n, url } = queue.shift()!;
              const start = (n - 1) * upload!.part_size;
              await putPart(url, file.slice(start, start + upload!.part_size), (loaded) => {
                inFlight.set(n, loaded);
                report();
              }, controller.signal);
              inFlight.delete(n);
              base += partBytes(n);
              report();
            }
          }),
        );
      }
      const finished = await api<{ video: { id: string }; job?: { id: string } }>(
        `/api/v1/uploads/${upload.id}/complete`,
        { method: "POST", body: { title } },
      );
      localStorage.removeItem(resumeKey(file));
      invalidate("/api/v1/videos");
      setPhase(
        finished.job
          ? { kind: "processing", jobId: finished.job.id, videoId: finished.video.id }
          : { kind: "done", videoId: finished.video.id },
      );
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase({ kind: "error", message: "Envio pausado. Você pode continuar de onde parou.", canResume: true });
        return;
      }
      const message =
        err instanceof ApiError ? err.message : "A conexão caiu durante o envio. Continue de onde parou.";
      setPhase({ kind: "error", message, canResume: !(err instanceof ApiError) || err.status === 0 });
    }
  }, [file, title]);

  const percent = phase.kind === "sending" ? (phase.sent / Math.max(phase.total, 1)) * 100 : 0;

  return (
    <UploadContext.Provider value={() => setOpen(true)}>
      {children}
      <Dialog
        open={open}
        onClose={close}
        title="Enviar vídeo"
        description="O arquivo vai direto para o armazenamento, em partes. Se a conexão cair, o envio continua de onde parou."
        footer={
          phase.kind === "pick" ? (
            <>
              <Button variant="ghost" onClick={close}>
                Cancelar
              </Button>
              <Button variant="primary" disabled={!file || !title.trim()} onClick={send} icon={<CloudUpload aria-hidden className="h-4 w-4" />}>
                Enviar
              </Button>
            </>
          ) : phase.kind === "sending" ? (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              Pausar
            </Button>
          ) : phase.kind === "error" ? (
            <>
              <Button variant="ghost" onClick={reset}>
                Escolher outro arquivo
              </Button>
              {phase.canResume ? (
                <Button variant="primary" onClick={send} icon={<RotateCcw aria-hidden className="h-4 w-4" />}>
                  Continuar envio
                </Button>
              ) : null}
            </>
          ) : phase.kind === "done" ? (
            <>
              <Button variant="ghost" onClick={reset}>
                Enviar outro
              </Button>
              <Link
                href={`/videos/${phase.videoId}`}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className="btn-glow inline-flex h-10 items-center rounded-[0.625rem] px-4 text-sm font-semibold text-white"
              >
                Abrir vídeo
              </Link>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Fechar (continua em segundo plano)
            </Button>
          )
        }
      >
        {phase.kind === "pick" ? (
          <div className="grid gap-5">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                choose(e.dataTransfer.files[0]);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-9 text-center transition-colors focus-within:outline-2 focus-within:outline-brand-soft ${
                dragging ? "border-brand-soft bg-brand/10" : "border-line-strong bg-surface-2/50 hover:border-brand-soft/60"
              }`}
            >
              <input ref={input} type="file" accept={ACCEPT} className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
              {file ? (
                <>
                  <FileVideo aria-hidden className="h-8 w-8 text-brand-soft" />
                  <span className="mt-3 max-w-full truncate text-sm font-semibold text-ink">{file.name}</span>
                  <span className="mt-1 text-xs text-muted">{bytes(file.size)} · clique para trocar</span>
                </>
              ) : (
                <>
                  <CloudUpload aria-hidden className="h-8 w-8 text-brand-soft" />
                  <span className="mt-3 text-sm font-semibold text-ink">Arraste o vídeo aqui ou clique para escolher</span>
                  <span className="mt-1 text-xs text-muted">MP4, MOV, WebM ou MKV</span>
                </>
              )}
            </label>
            <Field label="Título" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Aula 3 de edição" />
          </div>
        ) : phase.kind === "sending" ? (
          <div className="grid gap-3 py-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="truncate font-medium text-ink">{file?.name}</span>
              <span className="ml-3 shrink-0 font-mono text-ink-2 tabular-nums">{Math.floor(percent)}%</span>
            </div>
            <Progress value={percent} label="Andamento do envio" />
            <p className="text-xs text-muted">
              {bytes(phase.sent)} de {bytes(phase.total)}. Pode continuar usando o Clipo, mas deixe esta aba aberta.
            </p>
          </div>
        ) : phase.kind === "processing" ? (
          <div className="grid gap-3 py-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-ink">{job?.message ?? "Na fila de processamento"}</span>
              <span className="font-mono text-ink-2 tabular-nums">{job?.progress ?? 0}%</span>
            </div>
            <Progress value={job?.progress ?? 0} label="Andamento do processamento" />
            <p className="text-xs text-muted">Conferindo o arquivo, criando a miniatura e a prévia. Avisamos quando ficar pronto.</p>
          </div>
        ) : phase.kind === "done" ? (
          <div className="flex items-center gap-3 py-2">
            <CheckCircle2 aria-hidden className="h-6 w-6 text-success" />
            <p className="text-sm text-ink">Vídeo pronto. Já dá para cortar, transcrever e agendar.</p>
          </div>
        ) : (
          <Notice tone="error">{phase.message}</Notice>
        )}
      </Dialog>
    </UploadContext.Provider>
  );
}

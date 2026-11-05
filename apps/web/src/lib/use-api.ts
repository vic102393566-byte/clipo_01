"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { api, ApiError } from "@/lib/api";

/*
 * Leituras da API guardadas por caminho, num armazenamento compartilhado:
 * - voltar a uma tela mostra o último dado na hora e atualiza por trás;
 * - duas partes da tela que leem o mesmo caminho veem a mesma atualização;
 * - pedidos iguais ao mesmo tempo viram um só.
 */

type Entry = { data: unknown; error: ApiError | null; loading: boolean };

const PENDING: Entry = { data: undefined, error: null, loading: true };
const IDLE: Entry = { data: undefined, error: null, loading: false };
const store = new Map<string, Entry>();
const subscribers = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();

function read(path: string): Entry {
  return store.get(path) ?? PENDING;
}

function write(path: string, patch: Partial<Entry>) {
  store.set(path, { ...read(path), ...patch });
  subscribers.get(path)?.forEach((fn) => fn());
}

function load(path: string): Promise<void> {
  const running = inflight.get(path);
  if (running) return running;
  const promise = api(path)
    .then((data) => write(path, { data, error: null, loading: false }))
    .catch((err) =>
      write(path, {
        error: err instanceof ApiError ? err : new ApiError(0, "error", "Não foi possível carregar."),
        loading: false,
      }),
    )
    .finally(() => inflight.delete(path));
  inflight.set(path, promise);
  return promise;
}

function subscribe(path: string, fn: () => void) {
  const set = subscribers.get(path) ?? new Set();
  set.add(fn);
  subscribers.set(path, set);
  return () => {
    set.delete(fn);
  };
}

/** Busca de novo tudo o que está na tela e começa com `prefix`. */
export function invalidate(prefix: string) {
  for (const path of subscribers.keys()) {
    if (path.startsWith(prefix) && subscribers.get(path)?.size) void load(path);
  }
  for (const path of store.keys()) {
    if (path.startsWith(prefix) && !subscribers.get(path)?.size) store.delete(path);
  }
}

export type ApiState<T> = {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
  mutate: (next: T | ((prev: T | undefined) => T)) => void;
};

/** Lê da API. `path` nulo não busca nada (ex.: esperando um id). */
export function useApi<T>(path: string | null, { refreshMs }: { refreshMs?: number } = {}): ApiState<T> {
  const entry = useSyncExternalStore(
    useCallback((fn: () => void) => (path ? subscribe(path, fn) : () => {}), [path]),
    () => (path ? read(path) : IDLE),
    () => (path ? PENDING : IDLE),
  );

  useEffect(() => {
    if (!path) return;
    void load(path);
    if (!refreshMs) return;
    const timer = window.setInterval(() => void load(path), refreshMs);
    return () => window.clearInterval(timer);
  }, [path, refreshMs]);

  const reload = useCallback(() => (path ? load(path) : Promise.resolve()), [path]);
  const mutate = useCallback(
    (next: T | ((prev: T | undefined) => T)) => {
      if (!path) return;
      const prev = read(path).data as T | undefined;
      const value = typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
      write(path, { data: value, error: null, loading: false });
    },
    [path],
  );

  return {
    data: entry.data as T | undefined,
    error: entry.error,
    loading: entry.loading && entry.data === undefined,
    reload,
    mutate,
  };
}

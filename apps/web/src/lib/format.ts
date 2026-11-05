// Formatação em português do Brasil, usada em todas as telas.

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const relative = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const integer = new Intl.NumberFormat("pt-BR");

export function bytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: value < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

/** 75 → "1:15"; 3725 → "1:02:05". */
export function clock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Tempo com décimos para o editor: 61.25 → "1:01,2". */
export function clockPrecise(seconds: number): string {
  const whole = Math.floor(seconds);
  const tenth = Math.floor((seconds - whole) * 10);
  return `${clock(whole)},${tenth}`;
}

export function durationText(seconds: number | null | undefined): string {
  const s = Math.round(seconds ?? 0);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
}

export function when(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : "";
}

export function day(iso: string | null | undefined): string {
  return iso ? dateOnly.format(new Date(iso)) : "";
}

export function hour(iso: string | null | undefined): string {
  return iso ? timeOnly.format(new Date(iso)) : "";
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return relative.format(Math.round(diff), "second");
  if (abs < 3600) return relative.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return relative.format(Math.round(diff / 86400), "day");
  return day(iso);
}

export function brl(cents: number | null | undefined): string {
  return money.format((cents ?? 0) / 100);
}

export function num(n: number | null | undefined): string {
  return integer.format(n ?? 0);
}

export function percent(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((part / total) * 100)) : 0;
}

"use client";

import { useEffect } from "react";

import type { SettingsAll } from "@/lib/studio";
import { applyTheme } from "@/lib/theme";
import { useApi } from "@/lib/use-api";

/** Aplica o tema e o brilho salvos pela pessoa em todas as telas logadas. */
export function ThemeApplier() {
  const { data } = useApi<SettingsAll>("/api/v1/settings");
  useEffect(() => {
    if (data) applyTheme(data.me.theme_preset, data.me.glow);
  }, [data]);
  return <div aria-hidden className="clipo-theme-tint" />;
}

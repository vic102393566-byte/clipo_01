// Tema e brilho da plataforma (preferência da pessoa), aplicados no <html> como data-theme/data-glow.
// O CSS em globals.css recolore os destaques com uma camada de matiz e ajusta as sombras de brilho.

export const THEMES = ["dark-neon", "cyber-purple", "emerald-matrix", "monolith-oled"] as const;
export type ThemeId = (typeof THEMES)[number];
export type Glow = "low" | "medium" | "high";

export function applyTheme(theme: string | undefined, glow: string | undefined) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = THEMES.includes(theme as ThemeId) ? theme : "dark-neon";
  root.dataset.glow = glow === "low" || glow === "high" ? glow : "medium";
}

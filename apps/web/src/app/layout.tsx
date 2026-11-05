import type { Metadata } from "next";
import { JetBrains_Mono, Outfit, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Texto: Plus Jakarta Sans (a da tela de referência). Logo: Outfit. Números e código: JetBrains Mono.
const sans = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"] });
const display = Outfit({ variable: "--font-outfit", subsets: ["latin"], weight: ["500"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Clipo", template: "%s · Clipo" },
  description: "Gerenciamento, corte e publicação de vídeos curtos em várias redes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${sans.variable} ${display.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full bg-canvas text-ink">{children}</body>
    </html>
  );
}

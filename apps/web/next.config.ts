import type { NextConfig } from "next";

// O navegador fala só com o Next (mesma origem, sem CORS). O Next repassa /api/* e /media/*
// para a API Python pela rede interna. Os arquivos de vídeo não passam por aqui: vão direto ao S3.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

// Na Vercel, sem o endereço da API o site subiria sem conseguir logar. Melhor falhar o build com o motivo.
if (process.env.VERCEL && !process.env.API_INTERNAL_URL) {
  throw new Error(
    "Defina API_INTERNAL_URL nas variáveis de ambiente da Vercel (ex.: https://clipo-api.vercel.app) e faça Redeploy.",
  );
}

const nextConfig: NextConfig = {
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  experimental: {
    // Exportação de dados (LGPD) e CSV de logs podem demorar em contas grandes.
    proxyTimeout: 5 * 60 * 1000,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async redirects() {
    // Página inicial: a área logada (quem não tem sessão vai para o login de lá).
    return [{ source: "/", destination: "/dashboard", permanent: false }];
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_INTERNAL_URL}/api/:path*` },
      { source: "/media/:path*", destination: `${API_INTERNAL_URL}/media/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;

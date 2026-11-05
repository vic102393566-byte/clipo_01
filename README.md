# Clipo Platform

Nova base do Clipo: API em Python (FastAPI), front em Next.js e banco MongoDB.
Substitui por completo o Clipo antigo (`~/dev/Clipo-0.1`), que fica só como referência e não roda mais.

## Rodar tudo com Docker

1. Crie o `.env` na raiz a partir do `.env.example` e gere os segredos:

   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(48))"
   ```

2. Suba os serviços:

   ```bash
   docker compose up --build -d
   ```

| Serviço | Endereço | Para quê |
|---|---|---|
| Front (Next.js) | http://localhost:3200 | Telas; repassa `/api/*` para a API |
| API (FastAPI) | http://localhost:8000/docs | Documentação interativa (só fora de produção) |
| Mailpit | http://localhost:8025 | Caixa de saída dos e-mails de confirmação e senha |
| S3 (SeaweedFS) | http://localhost:8333 | Arquivos; em produção, Amazon S3 ou Cloudflare R2 |
| MongoDB | localhost:27017 | Replica set `rs0`, banco `clipo` |

Todas as portas abrem só para `127.0.0.1`.

## Desenvolvimento local

API (precisa do MongoDB do Docker rodando, para os testes):

```bash
cd apps/api && uv sync && uv run pytest
```

Web:

```bash
cd apps/web && npm install && npm run dev
```

## Login

- E-mail e senha com Argon2id; o e-mail precisa ser confirmado antes do primeiro login.
- Token de acesso de 15 min e token de renovação de 30 dias, girado a cada uso. Reusar um token
  antigo encerra todas as sessões da pessoa.
- Tokens só em cookies `HttpOnly`. Requisições que alteram dados levam `X-CSRF-Token` igual ao
  cookie `clipo_csrf`.
- Papéis desde o início: `user`, `support`, `admin`, `super_admin` (`require_role` na API).

## Regras para código novo

- Dados de cliente só por `OwnedRepository` (`apps/api/src/clipo_api/db/repository.py`): o MongoDB não
  tem RLS, então é ele que garante que uma pessoa não veja dados de outra.
- Toda rota nova exige sessão. O teste `test_toda_rota_nao_publica_exige_sessao` falha se uma rota
  responder sem login e não estiver na lista de rotas públicas.
- Arquivos sempre sob `users/<user_id>/` no bucket.

## Estrutura

- `apps/api`: FastAPI, PyMongo assíncrono, login próprio, vídeos (S3 + FFmpeg sem shell), IA de
  metadados (Gemini), plano por usuário, contas sociais por OAuth e publicação no TikTok
- `apps/web/src/clipo`: telas do Clipo antigo, trazidas sem mudar o comportamento
- `apps/web`: Next.js 16 (App Router), TypeScript, Tailwind; o layout `(app)` protege a área logada
- `.github/workflows/ci.yml`: lint, testes, auditoria de dependências, build das imagens e gitleaks
- `docs/plano-migracao.html`: plano unificado por fases

## Produção na Vercel

Dois projetos Vercel a partir deste repositório: o site na raiz (Next.js, `vercel.json`) e a API com
Root Directory `apps/api` (FastAPI, `apps/api/vercel.json`, com a tarefa diária). Sem worker ligado o
tempo todo, a fila anda em fatias (`/api/v1/jobs/pump` e `/api/v1/internal/cron`). Banco: MongoDB Atlas
pela integração da Vercel (`MONGODB_URI`); arquivos privados no Cloudflare R2. Para dar o papel de admin
a uma conta em produção: `MONGODB_URL=... uv run python -m clipo_api.make_admin email` (em `apps/api`).

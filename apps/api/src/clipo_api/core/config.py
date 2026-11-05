from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuração lida do ambiente. Segredos não têm valor padrão: sem eles a API não sobe."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"

    mongodb_url: str = Field(
        default="mongodb://localhost:27017/?directConnection=true",
        description="URL do MongoDB. Em produção, sempre definida pelo ambiente.",
        # A integração do Atlas na Vercel cria MONGODB_URI; as duas formas valem.
        validation_alias=AliasChoices("MONGODB_URL", "MONGODB_URI"),
    )
    mongodb_db: str = "clipo"

    # Origem pública do front: usada em CORS e nos links dos e-mails.
    app_base_url: str = "http://localhost:3200"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3200"])
    # Só ligue atrás de um proxy confiável; senão qualquer cliente forja o IP.
    trust_proxy_headers: bool = False

    jwt_secret: str = Field(min_length=32)
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    # Cookies só por HTTPS. Desligado apenas em desenvolvimento local (http://localhost).
    cookie_secure: bool = True

    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_starttls: bool = False
    email_from: str = "Clipo <nao-responda@clipo.local>"

    s3_endpoint_url: str | None = None
    # Endereço que o navegador usa para abrir as URLs assinadas (pode diferir do interno).
    s3_public_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_bucket: str = "clipo-media"
    s3_url_expires_seconds: int = 900
    # Maior arquivo do maior plano (Premium, 25 GB). O limite por plano é conferido na Fase 4.
    s3_max_upload_bytes: int = 25 * 1024 * 1024 * 1024

    # IA (gateway com LangChain). Cada provedor só entra na fila de modelos se tiver chave.
    gemini_api_key: str | None = None
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    # Modelo local com API no formato da OpenAI (Ollama, vLLM, LM Studio): ex. http://ollama:11434/v1
    local_llm_url: str | None = None
    local_llm_model: str = "qwen2.5:7b"
    # Transcrição: "local" (faster-whisper no worker, sem custo) ou "openai" (API no formato da OpenAI).
    stt_provider: Literal["local", "openai"] = "local"
    stt_base_url: str = "https://api.openai.com/v1"
    stt_api_key: str | None = None  # vazio: usa a OPENAI_API_KEY
    stt_model: str = "whisper-1"
    local_whisper_model: str = "base"
    whisper_models_dir: str = "/models"

    # Entrar com Google (OpenID Connect). Cliente "Aplicativo da Web" no Google Cloud Console.
    google_client_id: str | None = None
    google_client_secret: str | None = None
    # Entrar com Apple. Services ID, Team ID, Key ID e o conteúdo da chave .p8 (PEM).
    apple_client_id: str | None = None
    apple_team_id: str | None = None
    apple_key_id: str | None = None
    apple_private_key: str | None = None

    # Contas sociais (OAuth). Sem as credenciais, a tela mostra "não configurado".
    youtube_client_id: str | None = None
    youtube_client_secret: str | None = None
    instagram_client_id: str | None = None
    instagram_client_secret: str | None = None
    tiktok_client_key: str | None = None
    tiktok_client_secret: str | None = None
    # Chave Fernet para criptografar os tokens das redes sociais no banco.
    token_encryption_key: str | None = None

    # Logs do sistema (consultáveis no admin) e auditoria: apagados sozinhos depois do prazo.
    log_retention_days: int = 90
    audit_retention_days: int = 365
    # Alerta por e-mail aos admins: N erros do mesmo evento em X minutos; depois, silêncio.
    alert_error_threshold: int = 5
    alert_window_minutes: int = 10
    alert_silence_minutes: int = 30

    # LGPD: dias para desistir da exclusão da conta (o worker apaga depois do prazo).
    account_deletion_grace_days: int = 7

    # Endereço da própria API visto pelo worker (o diagnóstico chama o webhook por ele).
    api_internal_url: str = "http://localhost:8000"
    # Webhooks das redes: token de verificação da Meta (o app secret é o INSTAGRAM_CLIENT_SECRET).
    meta_webhook_verify_token: str | None = None

    # Asaas (gateway de pagamento). Sandbox para testes; production só com conta aprovada.
    asaas_api_key: str | None = None
    asaas_environment: Literal["sandbox", "production"] = "sandbox"

    # Métricas simuladas quando a rede não informa (vazio = ligado fora de produção).
    metrics_simulator: bool | None = None
    # Token que o Asaas manda no cabeçalho asaas-access-token de cada webhook (definido no painel).
    asaas_webhook_token: str | None = None
    # Teste gratuito para conta nova (0 desliga) e prazo de tolerância de pagamento atrasado.
    trial_plan_id: str = "pro"
    trial_days: int = 7
    billing_grace_days: int = 5

    @field_validator("jwt_secret")
    @classmethod
    def _secret_not_placeholder(cls, value: str) -> str:
        if value.lower().startswith(("change", "troque")):
            raise ValueError("JWT_SECRET ainda está com o valor de exemplo.")
        return value

    # Vercel (sem servidor fixo): o worker roda em fatias dentro das requisições.
    # Vazio = liga sozinho quando a variável VERCEL existe.
    serverless: bool | None = None
    # Quanto cada fatia pode trabalhar antes de devolver o job à fila (abaixo do limite da função).
    worker_budget_seconds: int = 45
    # A Vercel manda "Authorization: Bearer <CRON_SECRET>" nas tarefas agendadas.
    cron_secret: str | None = None

    @property
    def is_serverless(self) -> bool:
        import os

        return self.serverless if self.serverless is not None else bool(os.environ.get("VERCEL"))

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]

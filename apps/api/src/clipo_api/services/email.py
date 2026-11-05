"""Envio de e-mail por SMTP. Em desenvolvimento o SMTP é o Mailpit (http://localhost:8025)."""

import asyncio
import logging
import smtplib
from email.message import EmailMessage
from html import escape

from clipo_api.core.config import get_settings

log = logging.getLogger("clipo.email")


def _send_sync(to: str, subject: str, text: str, html: str) -> None:
    settings = get_settings()
    msg = EmailMessage()
    msg["From"] = settings.email_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        if settings.smtp_starttls:
            smtp.starttls()
        if settings.smtp_username and settings.smtp_password:
            smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(msg)


async def send_email(to: str, subject: str, text: str, html: str) -> None:
    """Falha de envio não derruba a requisição: fica no log e o usuário pode pedir de novo."""
    try:
        await asyncio.to_thread(_send_sync, to, subject, text, html)
    except (OSError, smtplib.SMTPException):
        log.exception("falha ao enviar e-mail", extra={"path": subject})


def _layout(title: str, intro: str, action_label: str, url: str, outro: str) -> tuple[str, str]:
    text = f"{title}\n\n{intro}\n\n{action_label}: {url}\n\n{outro}\n"
    html = f"""<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#0a0a0a;font-family:system-ui,sans-serif;color:#e7e7ea">
<div style="max-width:480px;margin:0 auto;background:#151515;border:1px solid #27272a;border-radius:12px;padding:28px">
<p style="margin:0 0 4px;color:#f97316;font-weight:700">Clipo</p>
<h1 style="font-size:20px;margin:0 0 12px;color:#fff">{escape(title)}</h1>
<p style="line-height:1.55;margin:0 0 20px">{escape(intro)}</p>
<a href="{escape(url, quote=True)}" style="display:inline-block;background:#f97316;color:#0a0a0a;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">{escape(action_label)}</a>
<p style="font-size:13px;color:#9a9eab;line-height:1.5;margin:20px 0 0">{escape(outro)}</p>
</div></body></html>"""
    return text, html


async def send_verification_email(to: str, name: str, url: str) -> None:
    text, html = _layout(
        f"Confirme seu e-mail, {name}",
        "Falta um passo para usar o Clipo. Confirme que este e-mail é seu.",
        "Confirmar e-mail",
        url,
        "O link vale por 24 horas. Se você não criou uma conta no Clipo, ignore esta mensagem.",
    )
    await send_email(to, "Confirme seu e-mail no Clipo", text, html)


async def send_password_reset_email(to: str, url: str) -> None:
    text, html = _layout(
        "Redefinir sua senha",
        "Recebemos um pedido para trocar a senha da sua conta no Clipo.",
        "Escolher nova senha",
        url,
        "O link vale por 30 minutos e só pode ser usado uma vez. Se não foi você, ignore esta mensagem: sua senha continua a mesma.",
    )
    await send_email(to, "Redefinir sua senha do Clipo", text, html)


async def send_email_change_email(to: str, url: str, *, is_new_address: bool, new_email: str) -> None:
    """Troca de e-mail: os dois endereços precisam confirmar."""
    if is_new_address:
        intro = "Confirme que este é o novo e-mail da sua conta no Clipo."
        outro = "O link vale por 24 horas. A troca só acontece depois que o e-mail antigo também confirmar."
    else:
        intro = f"Pediram para trocar o e-mail da sua conta no Clipo para {new_email}."
        outro = "O link vale por 24 horas. Se não foi você, ignore esta mensagem e troque sua senha: sem esta confirmação o e-mail não muda."
    text, html = _layout("Confirmar troca de e-mail", intro, "Confirmar troca", url, outro)
    await send_email(to, "Confirme a troca de e-mail no Clipo", text, html)


async def send_account_deletion_email(to: str, when: str, url: str) -> None:
    text, html = _layout(
        "Sua conta será excluída",
        f"Recebemos o pedido para excluir sua conta e todos os seus dados no Clipo. A exclusão acontece em {when}.",
        "Entrar e cancelar a exclusão",
        url,
        "Para desistir, é só entrar de novo antes dessa data. Depois dela, os dados não podem ser recuperados.",
    )
    await send_email(to, "Sua conta do Clipo será excluída", text, html)


async def send_notification_email(to: str, title: str, body: str, url: str, action_label: str) -> None:
    """Avisos do sistema (publicou, falhou, reconectar, espaço acabando)."""
    text, html = _layout(
        title,
        body,
        action_label,
        url,
        "Você recebe este aviso pelas preferências de notificação da sua conta. Dá para mudar nas Configurações.",
    )
    await send_email(to, f"[Clipo] {title}", text, html)


async def send_workspace_invite_email(to: str, inviter: str, role_label: str, url: str) -> None:
    text, html = _layout(
        f"{inviter} chamou você para o Clipo",
        f"Você foi convidado para o workspace de {inviter} como {role_label}.",
        "Aceitar convite",
        url,
        "O convite vale por 7 dias. Entre ou crie a conta com este mesmo e-mail para aceitar.",
    )
    await send_email(to, f"Convite de {inviter} no Clipo", text, html)

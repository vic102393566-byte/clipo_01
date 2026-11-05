"""Relatórios de resultados para baixar: PDF com a marca Clipo, Excel (.xlsx) e CSV separado por ";".

Os três saem do mesmo `analytics.overview`, então os números batem com a tela.
"""

import csv
import io
from datetime import UTC, datetime
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas

PERIOD_LABEL = {
    "7d": "Últimos 7 dias",
    "30d": "Últimos 30 dias",
    "90d": "Últimos 90 dias",
    "year": "Último ano",
}
NET_LABEL = {
    "tiktok": "TikTok",
    "instagram": "Instagram Reels",
    "youtube": "YouTube Shorts",
    "linkedin": "LinkedIn",
}

# Cores da plataforma
CANVAS = HexColor("#02070D")
SURFACE = HexColor("#06101A")
LINE = HexColor("#152232")
INK = HexColor("#EEF2F8")
MUTED = HexColor("#8D98A7")
BRAND = HexColor("#1167FF")
CYAN = HexColor("#22B8F5")
GREEN = HexColor("#10B981")
RED = HexColor("#F87171")


def _br(n: float | None, digits: int = 0) -> str:
    """Número no formato brasileiro: 1.234,5."""
    if n is None:
        return "—"
    text = f"{n:,.{digits}f}"
    return text.replace(",", "X").replace(".", ",").replace("X", ".")


def _day(iso: str) -> str:
    y, m, d = iso.split("-")
    return f"{d}/{m}/{y}"


def _pct(n: float | None) -> str:
    return "—" if n is None else f"{'+' if n > 0 else ''}{_br(n, 1)}%"


def _rows(data: dict[str, Any]) -> dict[str, list[list[Any]]]:
    k = data["kpis"]
    return {
        "Resumo": [
            ["Indicador", "Valor", "Variação vs período anterior"],
            ["Visualizações", k["views"]["value"], _pct(k["views"]["delta_pct"])],
            ["Retenção média (%)", k["retention"]["value"], _pct(k["retention"]["delta_pct"])],
            ["Engajamento", k["engagement"]["value"], _pct(k["engagement"]["delta_pct"])],
            ["Curtidas", k["likes"]["value"], _pct(k["likes"]["delta_pct"])],
            ["Compartilhamentos", k["shares"]["value"], _pct(k["shares"]["delta_pct"])],
            ["Novos seguidores", k["followers"]["value"], _pct(k["followers"]["delta_pct"])],
        ],
        "Por dia": [["Dia", "Visualizações", "Curtidas"]]
        + [[r["day"], r["views"], r["likes"]] for r in data["series"]],
        "Por rede": [["Rede", "Visualizações", "Participação (%)"]]
        + [[NET_LABEL.get(r["platform"], r["platform"]), r["views"], r["pct"]] for r in data["platforms"]],
        "Top vídeos": [
            ["Vídeo", "Redes", "Visualizações", "Curtidas", "Compartilhamentos", "Retenção (%)", "Desempenho"]
        ]
        + [
            [
                t["title"],
                ", ".join(NET_LABEL.get(p, p) for p in t["platforms"]),
                t["views"],
                t["likes"],
                t["shares"],
                t["retention_pct"],
                t["score"],
            ]
            for t in data["top"]
        ],
    }


def filename(data: dict[str, Any], ext: str) -> str:
    return f"clipo-resultados-{data['period']}-{datetime.now(UTC):%Y%m%d}.{ext}"


# ---------------------------------------------------------------- CSV


def to_csv(data: dict[str, Any], workspace: str) -> bytes:
    """CSV para Excel em português: separador ";", vírgula decimal e BOM para os acentos."""
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\r\n")
    writer.writerow(["Clipo · Relatório de resultados"])
    writer.writerow(["Workspace", workspace])
    writer.writerow(["Período", PERIOD_LABEL[data["period"]]])
    if data.get("simulated"):
        writer.writerow(["Aviso", "Números gerados pelo simulador local (sem métricas reais das redes)"])
    for name, rows in _rows(data).items():
        writer.writerow([])
        writer.writerow([name.upper()])
        for row in rows:
            writer.writerow([_br(v, 1) if isinstance(v, float) else ("" if v is None else v) for v in row])
    return ("﻿" + out.getvalue()).encode("utf-8")


# ---------------------------------------------------------------- Excel


def to_xlsx(data: dict[str, Any], workspace: str) -> bytes:
    wb = Workbook()
    header_fill = PatternFill("solid", fgColor="1167FF")
    title_font = Font(bold=True, size=14, color="1167FF")
    for i, (name, rows) in enumerate(_rows(data).items()):
        ws = wb.active if i == 0 else wb.create_sheet()
        ws.title = name
        ws.append(["Clipo · Relatório de resultados"])
        ws["A1"].font = title_font
        ws.append([f"{workspace} · {PERIOD_LABEL[data['period']]}"])
        ws["A2"].font = Font(color="6B7A8C")
        if data.get("simulated"):
            ws.append(["Números gerados pelo simulador local (sem métricas reais das redes)"])
            ws["A3"].font = Font(italic=True, color="B45309")
        ws.append([])
        start = ws.max_row + 1
        for row in rows:
            ws.append(row)
        for cell in ws[start]:
            cell.fill = header_fill
            cell.font = Font(bold=True, color="FFFFFF")
            cell.alignment = Alignment(vertical="center")
        for row in ws.iter_rows(min_row=start + 1):
            for cell in row:
                if isinstance(cell.value, int):
                    cell.number_format = "#,##0"
                elif isinstance(cell.value, float):
                    cell.number_format = "#,##0.0"
        for col, _ in enumerate(rows[0], start=1):
            width = max(
                len(str(r[col - 1])) if col - 1 < len(r) and r[col - 1] is not None else 0 for r in rows
            )
            ws.column_dimensions[get_column_letter(col)].width = min(60, max(14, width + 2))
        ws.freeze_panes = ws.cell(row=start + 1, column=1)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------- PDF


def _logo(c: Canvas, x: float, y: float, size: float) -> None:
    """Símbolo do Clipo: anel em C (azul para ciano) seguido do nome."""
    c.setLineCap(1)
    c.setLineWidth(size * 0.2)
    c.setStrokeColor(BRAND)
    c.arc(x, y, x + size, y + size, startAng=40, extent=160)
    c.setStrokeColor(CYAN)
    c.arc(x, y, x + size, y + size, startAng=200, extent=120)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", size * 0.95)
    c.drawString(x + size * 1.3, y + size * 0.16, "clipo")
    c.setLineWidth(0.6)


def _frame(c: Canvas, data: dict[str, Any], workspace: str, page: int) -> None:
    w, h = A4
    c.setFillColor(CANVAS)
    c.rect(0, 0, w, h, stroke=0, fill=1)
    # Cabeçalho
    c.setFillColor(SURFACE)
    c.rect(0, h - 30 * mm, w, 30 * mm, stroke=0, fill=1)
    c.setFillColor(BRAND)
    c.rect(0, h - 30 * mm, w, 1.2 * mm, stroke=0, fill=1)
    _logo(c, 16 * mm, h - 19 * mm, 9 * mm)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 13)
    c.drawRightString(w - 16 * mm, h - 14 * mm, "Relatório de Resultados")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 9)
    c.drawRightString(w - 16 * mm, h - 20 * mm, f"{workspace}  •  {PERIOD_LABEL[data['period']]}")
    # Rodapé
    c.setFillColor(SURFACE)
    c.rect(0, 0, w, 14 * mm, stroke=0, fill=1)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8)
    c.drawString(16 * mm, 6 * mm, "clipo  •  Planeje. Edite. Publique. Evolua.")
    c.drawRightString(
        w - 16 * mm, 6 * mm, f"Gerado em {datetime.now(UTC):%d/%m/%Y %H:%M} UTC  •  Página {page}"
    )


def _kpi(
    c: Canvas, x: float, y: float, w: float, label: str, value: str, delta: float | None, unit: str = "%"
) -> None:
    c.setFillColor(SURFACE)
    c.setStrokeColor(LINE)
    c.roundRect(x, y, w, 22 * mm, 3 * mm, stroke=1, fill=1)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8)
    c.drawString(x + 4 * mm, y + 16 * mm, label)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(x + 4 * mm, y + 8 * mm, value)
    if delta is not None:
        c.setFillColor(GREEN if delta >= 0 else RED)
        c.setFont("Helvetica-Bold", 8)
        text = _pct(delta) if unit == "%" else f"{'+' if delta > 0 else ''}{_br(delta, 1)} p.p."
        c.drawString(x + 4 * mm, y + 3.5 * mm, f"{text} vs anterior")


def _section(c: Canvas, y: float, title: str) -> float:
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(16 * mm, y, title)
    c.setFillColor(BRAND)
    c.rect(16 * mm, y - 2.5 * mm, 10 * mm, 0.8 * mm, stroke=0, fill=1)
    return y - 8 * mm


def to_pdf(data: dict[str, Any], workspace: str) -> bytes:
    buf = io.BytesIO()
    c = Canvas(buf, pagesize=A4)
    c.setTitle("Clipo · Relatório de resultados")
    c.setAuthor("Clipo")
    w, h = A4
    page = 1
    _frame(c, data, workspace, page)
    y = h - 40 * mm
    if data.get("simulated"):
        c.setFillColor(HexColor("#F59E0B"))
        c.setFont("Helvetica-Oblique", 8)
        c.drawString(
            16 * mm, y + 2 * mm, "Números gerados pelo simulador local: ainda sem métricas reais das redes."
        )
        y -= 5 * mm

    # Indicadores
    k = data["kpis"]
    card_w = (w - 32 * mm - 9 * mm) / 4
    cards = [
        ("Visualizações", _br(k["views"]["value"]), k["views"]["delta_pct"]),
        (
            "Retenção média",
            "—" if k["retention"]["value"] is None else f"{_br(k['retention']['value'], 1)}%",
            k["retention"]["delta_pct"],
        ),
        ("Engajamento", _br(k["engagement"]["value"]), k["engagement"]["delta_pct"]),
        ("Novos seguidores", _br(k["followers"]["value"]), k["followers"]["delta_pct"]),
    ]
    for i, (label, value, delta) in enumerate(cards):
        unit = "p.p." if label == "Retenção média" else "%"
        _kpi(c, 16 * mm + i * (card_w + 3 * mm), y - 22 * mm, card_w, label, value, delta, unit)
    y -= 34 * mm

    # Visualizações por dia (barras)
    y = _section(c, y, "Visualizações por dia")
    series = data["series"]
    chart_h, chart_w = 45 * mm, w - 32 * mm
    top = max([r["views"] for r in series] + [1])
    bar_w = chart_w / max(1, len(series))
    c.setStrokeColor(LINE)
    c.line(16 * mm, y - chart_h, 16 * mm + chart_w, y - chart_h)
    for i, r in enumerate(series):
        bh = (r["views"] / top) * (chart_h - 6 * mm)
        c.setFillColor(BRAND if i < len(series) - 1 else CYAN)
        c.rect(16 * mm + i * bar_w + bar_w * 0.15, y - chart_h, bar_w * 0.7, bh, stroke=0, fill=1)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7)
    if series:
        c.drawString(16 * mm, y - chart_h - 4 * mm, _day(series[0]["day"]))
        c.drawRightString(16 * mm + chart_w, y - chart_h - 4 * mm, _day(series[-1]["day"]))
        c.drawString(16 * mm, y + 1 * mm, f"máx. {_br(top)} por dia")
    y -= chart_h + 14 * mm

    # Distribuição por rede
    y = _section(c, y, "Distribuição por rede")
    for r in data["platforms"] or [{"platform": "—", "views": 0, "pct": 0}]:
        c.setFillColor(INK)
        c.setFont("Helvetica", 9)
        c.drawString(16 * mm, y, NET_LABEL.get(r["platform"], r["platform"]))
        c.setFillColor(LINE)
        c.roundRect(60 * mm, y - 1 * mm, 90 * mm, 3.5 * mm, 1.5 * mm, stroke=0, fill=1)
        c.setFillColor(BRAND)
        if r["pct"]:
            c.roundRect(60 * mm, y - 1 * mm, 90 * mm * r["pct"] / 100, 3.5 * mm, 1.5 * mm, stroke=0, fill=1)
        c.setFillColor(MUTED)
        c.drawRightString(w - 16 * mm, y, f"{_br(r['pct'], 1)}%  •  {_br(r['views'])}")
        y -= 7 * mm
    y -= 6 * mm

    # Top vídeos
    y = _section(c, y, "Vídeos com melhor desempenho")
    cols = [(16, "Vídeo"), (110, "Views"), (132, "Curtidas"), (154, "Retenção"), (176, "Desemp.")]
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(MUTED)
    for x, label in cols:
        c.drawString(x * mm, y, label)
    y -= 5 * mm
    for t in data["top"] or []:
        if y < 22 * mm:
            c.showPage()
            page += 1
            _frame(c, data, workspace, page)
            y = h - 40 * mm
        c.setStrokeColor(LINE)
        c.line(16 * mm, y + 3.5 * mm, w - 16 * mm, y + 3.5 * mm)
        c.setFillColor(INK)
        c.setFont("Helvetica", 8.5)
        title = t["title"] if len(t["title"]) <= 52 else t["title"][:51] + "…"
        c.drawString(16 * mm, y, title)
        c.setFillColor(MUTED)
        c.drawString(110 * mm, y, _br(t["views"]))
        c.drawString(132 * mm, y, _br(t["likes"]))
        c.drawString(154 * mm, y, "—" if t["retention_pct"] is None else f"{_br(t['retention_pct'], 1)}%")
        c.setFillColor(CYAN)
        c.drawString(176 * mm, y, f"{t['score']}/100")
        y -= 7 * mm
    if not data["top"]:
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 9)
        c.drawString(16 * mm, y, "Sem publicações com métricas no período.")
    c.showPage()
    c.save()
    return buf.getvalue()

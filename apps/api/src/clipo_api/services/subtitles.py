"""Legendas a partir das palavras da transcrição: SRT, VTT e ASS (para gravar no vídeo, com estilo).

As palavras viram blocos curtos (bom para vídeo vertical): até `max_chars` caracteres e `max_seconds`
segundos por bloco, quebrando também nas pausas. No estilo "destaque" cada palavra acende na hora em
que é falada (karaokê do ASS).
"""

from dataclasses import dataclass
from typing import Any, Literal

Position = Literal["bottom", "middle", "top"]


@dataclass
class Cue:
    start: float
    end: float
    words: list[dict[str, Any]]

    @property
    def text(self) -> str:
        return " ".join(w["w"] for w in self.words)


def cues(
    words: list[dict[str, Any]],
    *,
    offset: float = 0,
    max_chars: int = 32,
    max_seconds: float = 3.0,
    pause: float = 0.7,
) -> list[Cue]:
    out: list[Cue] = []
    current: list[dict[str, Any]] = []
    for w in words:
        word = {"s": max(0.0, w["s"] - offset), "e": max(0.0, w["e"] - offset), "w": w["w"]}
        if current:
            length = len(" ".join(x["w"] for x in current)) + 1 + len(word["w"])
            too_long = length > max_chars or word["e"] - current[0]["s"] > max_seconds
            gap = word["s"] - current[-1]["e"] > pause
            ends_sentence = current[-1]["w"].endswith((".", "?", "!"))
            if too_long or gap or ends_sentence:
                out.append(Cue(current[0]["s"], current[-1]["e"], current))
                current = []
        current.append(word)
    if current:
        out.append(Cue(current[0]["s"], current[-1]["e"], current))
    # Cada bloco fica na tela até o próximo começar (sem piscar), com no máximo 1 s de sobra.
    for a, b in zip(out, out[1:], strict=False):
        a.end = min(b.start, a.end + 1.0)
    return out


def _ts(seconds: float, sep: str) -> str:
    ms = round(seconds * 1000)
    h, rest = divmod(ms, 3_600_000)
    m, rest = divmod(rest, 60_000)
    s, ms = divmod(rest, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(items: list[Cue]) -> str:
    return "\n".join(
        f"{i}\n{_ts(c.start, ',')} --> {_ts(c.end, ',')}\n{c.text}\n" for i, c in enumerate(items, 1)
    )


def to_vtt(items: list[Cue]) -> str:
    return "WEBVTT\n\n" + "\n".join(f"{_ts(c.start, '.')} --> {_ts(c.end, '.')}\n{c.text}\n" for c in items)


# ---------------------------------------------------------------- ASS (gravado no vídeo)

_BASE = {"font": "DejaVu Sans", "color": "#FFFFFF", "outline": "#000000"}
PRESETS: dict[str, dict[str, Any]] = {
    # size em % da altura do vídeo; highlight liga o karaokê (palavra acende quando é falada).
    "classico": {
        **_BASE,
        "size": 5.5,
        "highlight": None,
        "outline_width": 3,
        "box": False,
        "bold": True,
        "uppercase": False,
        "position": "bottom",
    },
    "destaque": {
        **_BASE,
        "size": 7.0,
        "highlight": "#FFD400",
        "outline_width": 4,
        "box": False,
        "bold": True,
        "uppercase": True,
        "position": "middle",
    },
    "minimal": {
        **_BASE,
        "size": 4.5,
        "highlight": None,
        "outline_width": 0,
        "box": True,
        "bold": False,
        "uppercase": False,
        "position": "bottom",
    },
}


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _ass_time(seconds: float) -> str:
    cs = round(seconds * 100)
    h, rest = divmod(cs, 360000)
    m, rest = divmod(rest, 6000)
    s, cs = divmod(rest, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


STYLE_FIELDS = (
    "Name",
    "Fontname",
    "Fontsize",
    "PrimaryColour",
    "SecondaryColour",
    "OutlineColour",
    "BackColour",
    "Bold",
    "Italic",
    "Underline",
    "StrikeOut",
    "ScaleX",
    "ScaleY",
    "Spacing",
    "Angle",
    "BorderStyle",
    "Outline",
    "Shadow",
    "Alignment",
    "MarginL",
    "MarginR",
    "MarginV",
    "Encoding",
)


def to_ass(items: list[Cue], style: dict[str, Any], width: int, height: int) -> str:
    size = round(height * style["size"] / 100)
    alignment = {"bottom": 2, "middle": 5, "top": 8}[style["position"]]
    margin_v = round(height * (0.12 if style["position"] != "middle" else 0))
    primary = _ass_color(style["highlight"] or style["color"])
    secondary = _ass_color(style["color"])
    border_style = 3 if style["box"] else 1
    back = _ass_color("#000000", 0x60) if style["box"] else _ass_color("#000000", 0x80)
    style_line = ",".join(
        str(v)
        for v in (
            "Clipo",
            style["font"],
            size,
            primary,
            secondary,
            _ass_color(style["outline"]),
            back,
            -1 if style["bold"] else 0,
            0,
            0,
            0,
            100,
            100,
            0,
            0,
            border_style,
            style["outline_width"],
            0,
            alignment,
            round(width * 0.06),
            round(width * 0.06),
            margin_v,
            1,
        )
    )
    header = (
        "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n"
        f"PlayResX: {width}\nPlayResY: {height}\n\n"
        "[V4+ Styles]\n"
        f"Format: {', '.join(STYLE_FIELDS)}\n"
        f"Style: {style_line}\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = []
    for c in items:

        def word(w: dict[str, Any]) -> str:
            text = _escape(w["w"])
            return text.upper() if style["uppercase"] else text

        if style["highlight"]:
            # \k: a palavra fica na cor secundária e acende na primária quando é falada.
            parts, cursor = [], c.start
            for w in c.words:
                lead = max(0, round((w["s"] - cursor) * 100))
                dur = max(1, round((w["e"] - w["s"]) * 100))
                parts.append((f"{{\\k{lead}}}" if lead else "") + f"{{\\k{dur}}}{word(w)}")
                cursor = w["e"]
            text = " ".join(parts)
        else:
            text = " ".join(word(w) for w in c.words)
        lines.append(f"Dialogue: 0,{_ass_time(c.start)},{_ass_time(c.end)},Clipo,,0,0,0,,{text}")
    return header + "\n".join(lines) + "\n"


def resolve_style(preset: str, overrides: dict[str, Any]) -> dict[str, Any]:
    return {**PRESETS[preset], **{k: v for k, v in overrides.items() if v is not None}}


def watermark_filter(text: str, opacity: int, position: str) -> str:
    """drawtext com o texto da marca d'água num canto, com a margem de 4% do vídeo.

    O texto vai entre aspas simples e sem expansão (%{...} não vira código); aspas e barras saem.
    """
    clean = "".join(ch for ch in text if ch.isprintable() and ch not in "\\'")[:40]
    x = "w*0.04" if position.endswith("left") else "w-tw-w*0.04"
    y = "h*0.04" if position.startswith("top") else "h-th-h*0.04"
    alpha = max(0.05, min(1.0, opacity / 100))
    return (
        f"drawtext=font='DejaVu Sans':expansion=none:text='{clean}':fontsize=h*0.03"
        f":fontcolor=white@{alpha:.2f}:borderw=2:bordercolor=black@{alpha * 0.6:.2f}:x={x}:y={y}"
    )

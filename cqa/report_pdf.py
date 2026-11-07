"""A4 PDF download using the same report content as the printable HTML view."""
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate

from .report import STATUS_LABEL

FONT_DIR = Path(__file__).with_name("fonts")
for face, file in (("CQA", "DejaVuSans.ttf"), ("CQA-Bold", "DejaVuSans-Bold.ttf")):
    pdfmetrics.registerFont(TTFont(face, str(FONT_DIR / file)))

INK = "#18251e"
GREEN = "#16613e"


def style(name, size, leading, *, bold=False, color=INK, **kwargs):
    return ParagraphStyle(name, fontName="CQA-Bold" if bold else "CQA", fontSize=size,
                          leading=leading, textColor=colors.HexColor(color), alignment=TA_LEFT, **kwargs)


TITLE = style("title", 19, 24, bold=True, spaceAfter=6, keepWithNext=True)
META = style("meta", 9, 13, color="#52625a", spaceAfter=6)
TOTAL = style("total", 17, 23, bold=True, color=GREEN, spaceBefore=6, spaceAfter=5)
SECTION = style("section", 13, 18, bold=True, spaceBefore=12, spaceAfter=4, keepWithNext=True)
HEADING = style("criterion", 10, 15, bold=True, spaceBefore=6, spaceAfter=2, keepWithNext=True)
BODY = style("body", 9, 13, spaceAfter=4)
LABEL = style("label", 8, 12, bold=True, color=GREEN, spaceBefore=3, keepWithNext=True)
QUOTE = style("quote", 9, 13, leftIndent=8, spaceAfter=4)
WARNING = style("warning", 10, 15, bold=True, color="#912a2a", spaceAfter=7)


def paragraph(text, fmt):
    # User text is always literal, including markup-looking transcript fragments.
    text = "".join(c for c in str(text) if c >= " " or c in "\n\t")
    return Paragraph(escape(text).replace("\n", "<br/>"), fmt)


def _frame(canvas, doc):
    width, height = A4
    canvas.saveState()
    canvas.setFont("CQA-Bold", 9)
    canvas.setFillColor(colors.HexColor(GREEN))
    canvas.drawString(doc.leftMargin, height - 14 * mm, "Freedom Broker  /  Контроль качества")
    canvas.setStrokeColor(colors.HexColor("#ccdad2"))
    canvas.line(doc.leftMargin, height - 18 * mm, width - doc.rightMargin, height - 18 * mm)
    canvas.setFont("CQA", 8)
    canvas.drawRightString(width - doc.rightMargin, 12 * mm, f"Страница {doc.page}")
    canvas.restoreState()


def render(data):
    stream = BytesIO()
    title = f'Отчёт по качеству диалога {data["id"]}'
    doc = SimpleDocTemplate(stream, pagesize=A4, title=title, author="Freedom Broker",
                            leftMargin=18*mm, rightMargin=18*mm, topMargin=22*mm, bottomMargin=19*mm)
    story = [paragraph(title, TITLE), paragraph(data["meta"], META),
             paragraph(f'Итоговый балл: {data["total"]} / 100', TOTAL)]
    if data["was"] is not None:
        story.append(paragraph(f'До апелляций: {data["was"]}', META))
    if data["gross"]:
        story.append(paragraph("ГРУБАЯ ОШИБКА: " + data["gross"], WARNING))
    for section, value in data["sections"]:
        story.append(paragraph(f"{section}: {value}", BODY))
    story.append(paragraph("Модель: " + data["model"], META))
    section = None
    for c in data["criteria"]:
        if c["section"] and section != c["section"]:
            section = c["section"]
            story.append(paragraph(section, SECTION))
        story.append(paragraph(f'{c["code"]} · {c["name"]}', HEADING))
        verdict = f'{c["verdict"]} · {STATUS_LABEL.get(c["status"], c["status"])} · {c["points"]}'
        if c["was"] is not None:
            verdict += f' · было {c["was"]}'
        story.append(paragraph(verdict, BODY))
        if c["explanation"]:
            story.append(paragraph(c["explanation"], BODY))
        for kind, label, text in c["notes"]:
            story.extend((paragraph(label, LABEL), paragraph(text, QUOTE if kind == "q" else BODY)))

    story.extend((PageBreak(), paragraph("Транскрипт", TITLE)))
    for label, text, _ in data["transcript"]:
        story.extend((paragraph(label, LABEL), paragraph(text, BODY)))
    doc.build(story, onFirstPage=_frame, onLaterPages=_frame)
    stream.seek(0)
    return stream

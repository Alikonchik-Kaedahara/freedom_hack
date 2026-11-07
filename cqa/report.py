"""Shared content for printable HTML and downloadable PDF dialog reports."""
import html
from datetime import datetime

from . import scoring
from .evaluator import display_times

SPEAKER = {"client": "Клиент", "operator": "Оператор", "bot": "Бот", "system": "Система"}
STATUS_LABEL = {"ok": "Выполнено", "part": "Частично", "fail": "Не выполнено", "na": "N/A", "flag": "Грубая ошибка", "clean": "Нарушений нет"}


def _esc(x):
    return html.escape(str(x if x is not None else ""))


def _verdict(c, ans):
    v = ans.get("answer") if ans else None
    if v is None:
        return "—"
    if v == "na":
        return "N/A"
    if c["type"] == "scale":
        mx = max((s["value"] for s in c.get("scale", [])), default=0)
        return f"{v} / {mx}"
    return "Да" if v == "yes" else "Нет"


def _fmt_date(iso):
    try:
        return datetime.fromisoformat(iso).strftime("%d.%m.%Y %H:%M")
    except (ValueError, TypeError):
        return iso or ""


HTML_STYLE = """<style>
  body { font-family: "Segoe UI", Arial, sans-serif; color: #111; margin: 0; padding: 28px 36px; font-size: 12.5px; line-height: 1.45; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #666; margin-bottom: 14px; }
  .top { display: flex; gap: 24px; align-items: flex-start; border: 1px solid #ddd; border-radius: 6px; padding: 14px 16px; margin-bottom: 14px; }
  .total { font-size: 34px; font-weight: 700; line-height: 1; }
  .total small { font-size: 13px; color: #777; font-weight: 400; }
  .was { display: block; color: #777; font-size: 11.5px; margin-top: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .chip { border: 1px solid #ccc; border-radius: 3px; padding: 1px 7px; font-size: 11.5px; }
  .gross { background: #7F1D1D; color: #fff; padding: 8px 12px; border-radius: 4px; font-weight: 600; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  td { border-top: 1px solid #e3e3e3; padding: 8px 8px; vertical-align: top; }
  tr.sec td { background: #f3f5f4; font-weight: 600; font-size: 11.5px; letter-spacing: .02em; color: #444; }
  td.code { width: 34px; font-family: Consolas, monospace; color: #666; }
  td.verdict { width: 96px; font-weight: 700; white-space: nowrap; }
  td.pts { width: 130px; color: #444; white-space: nowrap; }
  .name { font-weight: 600; }
  .expl { color: #333; margin: 2px 0 4px; }
  .stl { font-size: 11px; font-weight: 400; color: #666; }
  tr.st-fail td.verdict, tr.st-flag td.verdict { color: #B91C1C; }
  tr.st-ok td.verdict, tr.st-clean td.verdict { color: #047857; }
  tr.st-part td.verdict { color: #B45309; }
  tr.st-na td.verdict { color: #475569; }
  .q { border-left: 3px solid #cfd8d3; padding: 3px 8px; margin: 3px 0; font-size: 12px; }
  .qm { display: block; color: #777; font-size: 11px; }
  .kb, .interp, .ap { font-size: 11.5px; margin-top: 5px; padding: 5px 8px; border-radius: 4px; }
  .kb { background: #FFFBEB; border: 1px solid #FDE68A; }
  .interp { background: #F3F5F4; color: #333; }
  .ap { background: #EEF2F6; }
  .foot { margin-top: 16px; color: #777; font-size: 11px; }
  .transcript { margin-top: 18px; page-break-before: always; }
  .transcript h2 { font-size: 15px; }
  .m { margin: 4px 0; }
  .m b { display: inline-block; min-width: 150px; color: #555; font-weight: 600; }
  .m.operator b { color: #00994D; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; }
  .actions a, .actions button { font: inherit; text-decoration: none; cursor: pointer; border: 1px solid #ccd6cf; border-radius: 4px; padding: 6px 12px; background: white; color: #164431; }
  .actions a { background: #14613f; color: white; }
  .ap { white-space: pre-line; }
  @media print { .actions { display: none; } body { padding: 0; } }
</style>"""


def content(record, result, team_name="", operator_name=""):
    from . import knowledge, storage

    checklist = result["checklist"]
    final = scoring.final_answers(result)
    score = scoring.score(checklist, final)
    original = scoring.score(checklist, result.get("answers") or {})
    live = storage.get_checklist(checklist.get("id")) or {"criteria": []}
    rules = {c["id"]: c.get("interpretation") for c in live["criteria"]}
    facts = knowledge.by_id()
    times = display_times(record["transcript"])
    transcript = []
    for i, t in enumerate(record["transcript"]):
        speaker = t.get("speaker", "")
        transcript.append((f'#{i + 1} · {times[i]} · {SPEAKER.get(speaker, speaker)}', t.get("text", ""), speaker))

    criteria = []
    for c in checklist["criteria"]:
        cid = c["id"]
        a = final.get(cid) or {}
        per = score["per"][cid]
        if c["type"] == "flag":
            points = "флаг"
        elif per.get("points") is None:
            points = f'N/A · вес {c.get("weight")} перераспределён'
        else:
            points = f'{per.get("effPoints", scoring.round2(per["points"]))} / {per.get("effWeight", c.get("weight"))}'
        notes = []
        for i in scoring.evidence_of(a, c, record):
            if isinstance(i, int) and 0 <= i < len(transcript):
                label, text, _ = transcript[i]
                notes.append(("q", label, text))
        for fid in a.get("contradicts") or []:
            if fid in facts:
                notes.append(("kb", f"Противоречит справочнику {fid}", facts[fid]["fact"]))
        rule = c.get("interpretation") or rules.get(cid)
        if rule:
            notes.append(("interp", "Трактовка правила", rule))
        for ap in result.get("appeals") or []:
            if ap.get("criterionId") != cid:
                continue
            status = {"pending": "на рассмотрении", "accepted": "принята", "rejected": "отклонена"}.get(ap["status"], ap["status"])
            lines = [ap.get("comment") or ""]
            if ap.get("author"):
                lines.append(f'Подал: {ap["author"]}')
            dec = ap.get("decision") or {}
            if dec:
                to = _verdict(c, dec) if dec.get("answer") is not None else None
                change = f"оценка изменена на {to}" if to else "оценка оставлена"
                lines.append(f'Решение: {dec.get("reason", "")} — {change}')
                if dec.get("by"):
                    lines.append(f'Решил: {dec["by"]}')
            notes.append(("ap", f"Апелляция ({status})", "\n".join(lines)))
        criteria.append({"code": c.get("code", ""), "name": c["name"], "section": c.get("section"),
                         "status": per["status"], "verdict": _verdict(c, a), "points": points,
                         "was": _verdict(c, result["answers"].get(cid)) if a.get("overridden") else None,
                         "explanation": a.get("explanation") or "", "notes": notes})

    engine = result.get("engine") or {}
    model = engine.get("model") or engine.get("type") or "—"
    so = result.get("secondOpinion") or {}
    if so:
        rate = (so.get("comparison") or {}).get("rate") or 0
        model += f' · второе мнение ({(so.get("engine") or {}).get("model") or "—"}): совпадение {round(rate * 100)}%'
    channel = "Звонок" if record.get("channel") == "voice call" else "Чат"
    meta = [channel, record.get("language"), f'оператор: {operator_name or "—"}',
            f'чек-лист «{checklist["name"]}» v{checklist.get("version")}', "оценка " + _fmt_date(result.get("createdAt")), team_name]
    gross = next((final[c["id"]].get("explanation") or c["name"] for c in checklist["criteria"]
                  if c["type"] == "flag" and (final.get(c["id"]) or {}).get("answer") == "yes"), None)
    return {"id": record["conversation_id"], "meta": " · ".join(filter(None, meta)), "model": model,
            "total": score["total"] if score["total"] is not None else "—",
            "was": original["total"] if original["total"] != score["total"] else None, "gross": gross,
            "sections": [(label, "N/A" if v["pct"] is None else f'{v["pct"]}%') for label, v in score["sections"].items()],
            "criteria": criteria, "transcript": transcript}


def render(record, result, team_name="", operator_name=""):
    data = content(record, result, team_name, operator_name)
    rows = []
    last_section = None
    for c in data["criteria"]:
        if c["section"] and c["section"] != last_section:
            last_section = c["section"]
            rows.append(f'<tr class="sec"><td colspan="4">{_esc(last_section)}</td></tr>')
        notes = []
        for kind, label, text in c["notes"]:
            if kind == "q":
                notes.append(f'<div class="q"><span class="qm">{_esc(label)}</span>{_esc(text)}</div>')
            else:
                notes.append(f'<div class="{kind}"><b>{_esc(label)}:</b> {_esc(text)}</div>')
        was = f'<div class="was">было {_esc(c["was"])}</div>' if c["was"] is not None else ""
        status = c["status"]
        rows.append(f'<tr class="st-{status}"><td class="code">{_esc(c["code"])}</td><td>'
                    f'<div class="name">{_esc(c["name"])}</div><div class="expl">{_esc(c["explanation"])}</div>{"".join(notes)}</td>'
                    f'<td class="verdict">{_esc(c["verdict"])}{was}<div class="stl">{_esc(STATUS_LABEL.get(status, status))}</div></td>'
                    f'<td class="pts">{_esc(c["points"])}</td></tr>')
    sections = "".join(f'<span class="chip">{_esc(label)}: {value}</span>' for label, value in data["sections"])
    transcript = "".join(f'<div class="m {_esc(speaker)}"><b>{_esc(label)}</b> {_esc(text)}</div>'
                         for label, text, speaker in data["transcript"])
    gross = f'<div class="gross">ГРУБАЯ ОШИБКА: {_esc(data["gross"])}</div>' if data["gross"] else ""
    was = f'<span class="was">до апелляций {_esc(data["was"])}</span>' if data["was"] is not None else ""
    return f'''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Отчёт CQA · {_esc(data["id"])}</title>{HTML_STYLE}</head><body>
<div class="actions"><a href="?format=pdf" download>Скачать PDF</a><button type="button" onclick="window.print()">Печать</button></div>
<h1>Отчёт по качеству диалога {_esc(data["id"])}</h1><div class="sub">{_esc(data["meta"])}</div>{gross}
<div class="top"><div><div class="total">{data["total"]}<small> / 100</small></div>{was}</div>
<div><b>Разделы</b><div class="chips">{sections}</div><div class="foot">Модель: {_esc(data["model"])}.
N/A исключается с перераспределением веса, грубая ошибка — отдельный флаг.</div></div></div>
<table><tbody>{"".join(rows)}</tbody></table>
<div class="foot">Нумерация реплик — по исходному транскрипту, с 1. Сформировано системой CQA.</div>
<div class="transcript"><h2>Транскрипт</h2>{transcript}</div></body></html>'''

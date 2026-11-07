"""Printable report of one evaluated dialog (HTML; the browser's Print → Save as PDF makes the PDF).

What a supervisor hands to the operator after a review: the total with sections, every
criterion with its verdict, weight, the model's explanation, the quoted evidence lines,
the team's interpretation of the rule where one exists, the appeal history, and the
knowledge-base facts the answer contradicted. The page is self-contained (inline CSS,
no scripts except the print button) so it also works as an attachment.
"""
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


def render(record, result, team_name="", operator_name=""):
    from . import knowledge as kb_mod

    from . import storage

    fa = scoring.final_answers(result)
    sc = scoring.score(result["checklist"], fa)
    live = storage.get_checklist(result["checklist"].get("id")) or {"criteria": []}
    live_interp = {c["id"]: c.get("interpretation") for c in live["criteria"]}
    orig = scoring.score(result["checklist"], result.get("answers") or {})
    times = display_times(record["transcript"])
    facts = kb_mod.by_id()
    cid = record["conversation_id"]
    is_call = record.get("channel") == "voice call"

    def quote(i):
        t = record["transcript"][i] if 0 <= i < len(record["transcript"]) else None
        if not t:
            return ""
        return (f'<div class="q"><span class="qm">#{i + 1} · {_esc(times[i])} · {_esc(SPEAKER.get(t.get("speaker"), t.get("speaker")))}</span>'
                f'<span class="qt">{_esc(t.get("text"))}</span></div>')

    rows = []
    last_sec = None
    for c in result["checklist"]["criteria"]:
        if c.get("section") and c["section"] != last_sec:
            rows.append(f'<tr class="sec"><td colspan="4">{_esc(c["section"])}</td></tr>')
            last_sec = c["section"]
        a = fa.get(c["id"]) or {}
        o = (result.get("answers") or {}).get(c["id"]) or {}
        p = sc["per"].get(c["id"]) or {}
        st = p.get("status", "na")
        verdict = _verdict(c, a)
        changed = a.get("overridden")
        pts = ""
        if c["type"] == "flag":
            pts = "флаг"
        elif p.get("points") is not None:
            pts = f'{p.get("effPoints", scoring.round2(p["points"]))} / {p.get("effWeight", c.get("weight"))}'
        else:
            pts = f'N/A · вес {c.get("weight")} перераспределён'
        ev = "".join(quote(i) for i in (a.get("evidence") or [])[:4])
        contradicts = "".join(
            f'<div class="kb"><b>Противоречит справочнику {_esc(fid)}:</b> {_esc(facts[fid]["fact"])}</div>'
            for fid in a.get("contradicts") or [] if fid in facts)
        interp_text = c.get("interpretation") or live_interp.get(c["id"]) or ""
        interp = f'<div class="interp"><b>Трактовка правила:</b> {_esc(interp_text)}</div>' if interp_text else ""
        appeals = ""
        for ap in result.get("appeals") or []:
            if ap.get("criterionId") != c["id"]:
                continue
            dec = ap.get("decision") or {}
            st_label = {"pending": "на рассмотрении", "accepted": "принята", "rejected": "отклонена"}.get(ap.get("status"), ap.get("status"))
            to = _verdict(c, {"answer": dec.get("answer")}) if dec.get("answer") is not None else None
            filed = f' <span class="who">Подал: {_esc(ap["author"])}</span>' if ap.get("author") else ""
            decided = f' <span class="who">Решил: {_esc(dec["by"])}</span>' if dec.get("by") else ""
            appeals += (f'<div class="ap"><b>Апелляция ({st_label}):</b> {_esc(ap.get("comment"))}{filed}'
                        + (f'<br><b>Решение:</b> {_esc(dec.get("reason"))}' + (f' — оценка изменена на {to}' if to else ' — оценка оставлена') + decided if dec else '')
                        + '</div>')
        rows.append(
            f'<tr class="st-{st}"><td class="code">{_esc(c.get("code") or "")}</td>'
            f'<td><div class="name">{_esc(c["name"])}</div><div class="expl">{_esc(a.get("explanation"))}</div>{ev}{contradicts}{interp}{appeals}</td>'
            f'<td class="verdict">{_esc(verdict)}{"<div class=was>было " + _esc(_verdict(c, o)) + "</div>" if changed else ""}'
            f'<div class="stl">{_esc(STATUS_LABEL.get(st, st))}</div></td>'
            f'<td class="pts">{_esc(pts)}</td></tr>')

    sections = "".join(f'<span class="chip">{_esc(name)}: {("N/A" if s["pct"] is None else str(s["pct"]) + "%")}</span>'
                       for name, s in sc["sections"].items())
    gross = '<div class="gross">ГРУБАЯ ОШИБКА: ' + _esc(next((fa[c["id"]].get("explanation") for c in result["checklist"]["criteria"]
                                                               if c["type"] == "flag" and (fa.get(c["id"]) or {}).get("answer") == "yes"), "")) + '</div>' if sc["gross"] else ""
    engine = result.get("engine") or {}
    so = result.get("secondOpinion")
    so_line = ""
    if so:
        cmp = so.get("comparison") or {}
        so_line = (f' · второе мнение ({_esc((so.get("engine") or {}).get("model"))}): совпадение '
                   f'{int(round((cmp.get("rate") or 0) * 100))}%')
    was = f'<span class="was">до апелляций {orig["total"]}</span>' if orig["total"] != sc["total"] else ""

    return f'''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Отчёт CQA · {_esc(cid)}</title>
<style>
  body {{ font-family: "Segoe UI", Arial, sans-serif; color: #111; margin: 0; padding: 28px 36px; font-size: 12.5px; line-height: 1.45; }}
  h1 {{ font-size: 20px; margin: 0 0 2px; }}
  .sub {{ color: #666; margin-bottom: 14px; }}
  .top {{ display: flex; gap: 24px; align-items: flex-start; border: 1px solid #ddd; border-radius: 6px; padding: 14px 16px; margin-bottom: 14px; }}
  .total {{ font-size: 34px; font-weight: 700; line-height: 1; }}
  .total small {{ font-size: 13px; color: #777; font-weight: 400; }}
  .was {{ display: block; color: #777; font-size: 11.5px; margin-top: 4px; }}
  .chips {{ display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }}
  .chip {{ border: 1px solid #ccc; border-radius: 3px; padding: 1px 7px; font-size: 11.5px; }}
  .gross {{ background: #7F1D1D; color: #fff; padding: 8px 12px; border-radius: 4px; font-weight: 600; margin-bottom: 12px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  td {{ border-top: 1px solid #e3e3e3; padding: 8px 8px; vertical-align: top; }}
  tr.sec td {{ background: #f3f5f4; font-weight: 600; font-size: 11.5px; letter-spacing: .02em; color: #444; }}
  td.code {{ width: 34px; font-family: Consolas, monospace; color: #666; }}
  td.verdict {{ width: 96px; font-weight: 700; white-space: nowrap; }}
  td.pts {{ width: 130px; color: #444; white-space: nowrap; }}
  .name {{ font-weight: 600; }}
  .expl {{ color: #333; margin: 2px 0 4px; }}
  .stl {{ font-size: 11px; font-weight: 400; color: #666; }}
  tr.st-fail td.verdict, tr.st-flag td.verdict {{ color: #B91C1C; }}
  tr.st-ok td.verdict, tr.st-clean td.verdict {{ color: #047857; }}
  tr.st-part td.verdict {{ color: #B45309; }}
  tr.st-na td.verdict {{ color: #475569; }}
  .q {{ border-left: 3px solid #cfd8d3; padding: 3px 8px; margin: 3px 0; font-size: 12px; }}
  .qm {{ display: block; color: #777; font-size: 11px; }}
  .kb, .interp, .ap {{ font-size: 11.5px; margin-top: 5px; padding: 5px 8px; border-radius: 4px; }}
  .kb {{ background: #FFFBEB; border: 1px solid #FDE68A; }}
  .interp {{ background: #F3F5F4; color: #333; }}
  .ap {{ background: #EEF2F6; }}
  .foot {{ margin-top: 16px; color: #777; font-size: 11px; }}
  .transcript {{ margin-top: 18px; page-break-before: always; }}
  .transcript h2 {{ font-size: 15px; }}
  .m {{ margin: 4px 0; }}
  .m b {{ display: inline-block; min-width: 150px; color: #555; font-weight: 600; }}
  .m.operator b {{ color: #00994D; }}
  .print {{ position: fixed; top: 14px; right: 16px; padding: 7px 14px; background: #00994D; color: #fff; border: 0; border-radius: 4px; font-weight: 600; cursor: pointer; }}
  @media print {{ .print {{ display: none; }} body {{ padding: 0; }} }}
</style></head><body>
<button class="print" onclick="window.print()">Печать / сохранить PDF</button>
<h1>Отчёт по качеству диалога {_esc(cid)}</h1>
<div class="sub">{"Звонок" if is_call else "Чат"} · {_esc(record.get("language"))} · оператор: {_esc(operator_name or "—")} · чек-лист «{_esc(result["checklist"]["name"])}» v{_esc(result["checklist"].get("version"))} · оценка {_esc(_fmt_date(result.get("createdAt")))}{" · " + _esc(team_name) if team_name else ""}</div>
{gross}
<div class="top">
  <div><div class="total">{sc["total"] if sc["total"] is not None else "—"}<small> / 100</small></div>{was}</div>
  <div><div><b>Разделы</b></div><div class="chips">{sections}</div>
       <div class="foot" style="margin-top:8px">Модель: {_esc(engine.get("model") or engine.get("type") or "—")}{so_line}. Баллы считаются по правилам чек-листа: Да — полный вес, шкала пропорционально, N/A исключается с перераспределением веса, грубая ошибка — отдельный флаг.</div></div>
</div>
<table><tbody>{"".join(rows)}</tbody></table>
<div class="foot">Нумерация реплик — по исходному транскрипту, с 1. Сформировано системой CQA.</div>
<div class="transcript"><h2>Транскрипт</h2>
{"".join(f'<div class="m {_esc(t.get("speaker"))}"><b>#{i + 1} · {_esc(times[i])} · {_esc(SPEAKER.get(t.get("speaker"), t.get("speaker")))}</b> {_esc(t.get("text"))}</div>' for i, t in enumerate(record["transcript"]))}
</div>
</body></html>'''

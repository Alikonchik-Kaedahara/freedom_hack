"""Operator profiles: group evaluated dialogs by the operator who handled them.

The organizers' data carries no operator id, but the operator introduces themselves in the
first reply ("Здравствуйте, я Руслан", "Мен Нұрланмын", "Hi, I'm Maya"). The name is
extracted from that reply by a small set of patterns for RU / KZ / EN; when nothing
matches (no introduction, masked name in a call) the dialog goes to «Не представился».
A supervisor can override the name per dialog (stored in the result as operatorName).

This is what a quality supervisor actually opens CQA for: not one chat, but "who keeps
skipping identification" — the profile shows the average, criterion failure rates,
gross errors and the dialogs behind each number.
"""
import re

from . import scoring

UNKNOWN = "Не представился"
MASKED = "[Имя скрыто]"

# Kazakh first-person suffixes: Нұрланмын / Айбекпін / Саматпын / Ләззатпын / Дидармын / Айсұлумын
_KZ_SUFFIX = re.compile(r"(мын|мін|пын|пін|бын|бін)$")

# (keyword, name) — the keyword is matched case-insensitively, the name must be capitalised
_PATTERNS = [
    # RU
    ("ru_zovut", re.compile(r"[Мм]еня зовут\s+([А-ЯЁ][а-яё]+)", re.U)),
    ("ru_ya", re.compile(r"(?:^|[.!?,]\s*|\s)[Яя]\s+([А-ЯЁ][а-яё]+)(?=[\s,.!?]|$)", re.U)),
    ("ru_eto", re.compile(r"[Ээ]то\s+([А-ЯЁ][а-яё]+)(?:,|\s+из\b)", re.U)),
    # KZ
    ("kz_atym", re.compile(r"[Мм]енің атым\s+([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)", re.U)),
    ("kz_men", re.compile(r"(?:^|[.!?,]\s*|\s)[Мм]ен\s+([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)(?=[\s,.!?]|$)", re.U)),
    # EN
    ("en", re.compile(r"(?:I'm|I am|[Mm]y name is|[Tt]his is)\s+([A-Z][a-z]+)")),
]
_NOT_NAMES = {"Фридом", "Freedom", "Брокер", "Broker", "Компания", "Поддержка", "Оператор", "Специалист", "Менеджер",
              "Служба", "Отдел", "Support", "Agent", "Open", "Go", "In", "On", "Yes", "Да", "Нет", "Сейчас", "Понимаю"}


def extract_name(text):
    """Operator's first name from their first reply, MASKED for '[Имя скрыто]', or None."""
    if not text:
        return None
    if "[Имя скрыто]" in text or "[Name hidden]" in text:
        return MASKED
    for kind, pat in _PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        first = m.group(1).strip()
        if first in _NOT_NAMES or len(first) < 2:
            continue
        if kind == "kz_men":
            first = _KZ_SUFFIX.sub("", first)
        return first
    return None


def operator_of(record, result=None):
    """Display name for a dialog: supervisor override > extracted from the first operator reply > UNKNOWN."""
    if result and result.get("operatorName"):
        return result["operatorName"]
    for t in record.get("transcript") or []:
        if t.get("speaker") == "operator":
            return extract_name(t.get("text")) or UNKNOWN
    return UNKNOWN


def profiles(records, results):
    """Aggregate per operator over evaluated dialogs. Returns a list sorted by average score ascending."""
    by_id = {r["conversation_id"]: r for r in records}
    groups = {}
    for res in results.values():
        rec = by_id.get(res.get("conversationId"))
        if not rec:
            continue
        name = operator_of(rec, res)
        g = groups.setdefault(name, {"name": name, "dialogs": [], "totals": [], "gross": 0, "appeals": 0, "pending": 0,
                                     "languages": {}, "channels": {}, "criteria": {}})
        s = scoring.score(res["checklist"], scoring.final_answers(res))
        fa = scoring.final_answers(res)
        if s["total"] is not None:
            g["totals"].append(s["total"])
        if s["gross"]:
            g["gross"] += 1
        g["appeals"] += len(res.get("appeals") or [])
        g["pending"] += sum(1 for a in res.get("appeals") or [] if a.get("status") == "pending")
        g["languages"][rec.get("language")] = g["languages"].get(rec.get("language"), 0) + 1
        g["channels"][rec.get("channel")] = g["channels"].get(rec.get("channel"), 0) + 1
        for c in res["checklist"]["criteria"]:
            code = c.get("code") or c["id"]
            cs = g["criteria"].setdefault(code, {"code": code, "name": c["name"], "type": c["type"], "applicable": 0, "failed": 0, "partial": 0, "na": 0, "flag": 0})
            p = s["per"].get(c["id"]) or {}
            if c["type"] == "flag":
                if p.get("hit"):
                    cs["flag"] += 1
                continue
            if p.get("status") in ("ok", "fail", "part"):
                cs["applicable"] += 1
                if p["status"] == "fail":
                    cs["failed"] += 1
                elif p["status"] == "part":
                    cs["partial"] += 1
            else:
                cs["na"] += 1
        g["dialogs"].append({
            "conversationId": rec["conversation_id"], "language": rec.get("language"), "channel": rec.get("channel"),
            "total": s["total"], "gross": s["gross"], "createdAt": res.get("createdAt"),
            "failed": [c.get("code") or c["id"] for c in res["checklist"]["criteria"] if (s["per"].get(c["id"]) or {}).get("status") == "fail"],
            "grossWhy": next((fa[c["id"]].get("explanation") for c in res["checklist"]["criteria"]
                              if c["type"] == "flag" and (fa.get(c["id"]) or {}).get("answer") == "yes"), None),
        })
    out = []
    for g in groups.values():
        n = len(g["totals"])
        g["count"] = len(g["dialogs"])
        g["average"] = scoring.round2(sum(g["totals"]) / n) if n else None
        g["min"] = min(g["totals"]) if n else None
        g["max"] = max(g["totals"]) if n else None
        for cs in g["criteria"].values():
            cs["failRate"] = scoring.round2((cs["failed"] + cs["partial"] * 0.5) / cs["applicable"] * 100) if cs["applicable"] else None
        g["criteria"] = sorted(g["criteria"].values(), key=lambda x: str(x["code"]))
        g["weakest"] = sorted([c for c in g["criteria"] if c["failRate"] is not None and c["failed"]], key=lambda x: -x["failRate"])[:3]
        g["dialogs"].sort(key=lambda d: (d["total"] if d["total"] is not None else 101))
        del g["totals"]
        out.append(g)
    out.sort(key=lambda g: (g["name"] == UNKNOWN, g["average"] if g["average"] is not None else 101, g["name"]))
    return out

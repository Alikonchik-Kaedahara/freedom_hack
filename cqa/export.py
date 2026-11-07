"""Export of evaluation results in the organizers' JSON 1.0 format (CQA_Student_Guide_Appendix_Results).

results/dev/results.json  - every dialog of the DEV set (60 chats + 5 calls)
results/prod/results.json - every dialog of the control set (10 chats)

Rules implemented here, as the appendix states them:
- one object per dialog, all conversation_ids of the set, no duplicates;
- status "ok" carries all eight criteria, each exactly once, with criterion_id
  contact / discovery / identification / consultation / empathy / dialogue / closure / critical;
- value: true = «Да», false = «Нет», null = N/A (only where the format allows null),
  number = scale step before weighting;
- evidence_turns are numbered from 1 over the original transcript (our storage numbers
  replies from 0, so +1 here);
- final_score: 0..100, N/A weight redistributed, rounded half-up to 2 decimals;
  critical_flag mirrors the critical criterion and never changes the score;
- a dialog that could not be evaluated keeps its id with status "error", empty criteria,
  score null and the reason in "error".

The checklist in the UI maps its criteria to the export ids through `exportId`
(the default checklists set it; the constructor keeps it when a criterion is edited).
A criterion without exportId is not exported — the format fixes the eight codes.
"""
import json
import os
from datetime import datetime, timezone

from . import scoring, storage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS_DIR = os.path.join(ROOT, "results")
SCHEMA_VERSION = "1.0"

EXPORT_IDS = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]
# the format allows null only for these
NULLABLE = {"discovery", "identification", "consultation", "closure"}
# fallback mapping by criterion code for checklists created before exportId existed
CODE_TO_EXPORT = {"01": "contact", "02": "discovery", "03": "identification", "04": "consultation",
                  "05": "empathy", "06": "dialogue", "07": "closure", "08": "critical"}
MODE_BY_ENGINE = {"cloud": "external_api", "local": "local"}


class ExportError(Exception):
    pass


def export_id(criterion):
    return criterion.get("exportId") or CODE_TO_EXPORT.get(str(criterion.get("code") or ""))


def _value(criterion, answer, eid):
    """Our stored answer -> the format's value. Returns (value, note)."""
    ans = answer.get("answer") if answer else None
    if ans is None:
        return None, "нет допустимого ответа"
    if ans == "na":
        if eid in NULLABLE:
            return None, None
        # the format has no null here (e.g. contact on a call whose greeting is not in the recording)
        return (0 if criterion["type"] == "scale" else False), "N/A по чек-листу системы; формат выгрузки не допускает null"
    if criterion["type"] == "scale":
        return (int(ans) if float(ans) == int(ans) else float(ans)), None
    return ans == "yes", None


def _criteria_rows(result):
    """Eight criterion rows in the fixed order, or raise ExportError for an unexportable result."""
    checklist = result["checklist"]
    answers = scoring.final_answers(result)
    rows, seen = {}, set()
    for c in checklist["criteria"]:
        eid = export_id(c)
        if not eid or eid not in EXPORT_IDS:
            continue
        if eid in seen:
            raise ExportError(f"критерий {eid} встречается в чек-листе дважды")
        seen.add(eid)
        a = answers.get(c["id"]) or {}
        value, note = _value(c, a, eid)
        if a.get("answer") is None:
            raise ExportError(f"критерий {eid}: {note}")
        rationale = (a.get("explanation") or "").strip()
        if note:
            rationale = f"{note}. {rationale}".strip()
        rows[eid] = {
            "criterion_id": eid,
            "value": value,
            "rationale": rationale,
            "evidence_turns": [int(i) + 1 for i in (a.get("evidence") or [])],
        }
    missing = [eid for eid in EXPORT_IDS if eid not in rows]
    if missing:
        raise ExportError("в чек-листе нет критериев для кодов: " + ", ".join(missing))
    return [rows[eid] for eid in EXPORT_IDS]


def _mode(results):
    types = set()
    names = []
    for r in results:
        eng = r.get("engine") or {}
        t = eng.get("type")
        if t == "replay":
            src = eng.get("source") or {}
            t = src.get("type")
            name = src.get("model")
        else:
            name = eng.get("model")
        if t:
            types.add(t)
        if name and name not in names:
            names.append(name)
    modes = {MODE_BY_ENGINE.get(t, t) for t in types}
    mode = "hybrid" if len(modes) > 1 else (next(iter(modes)) if modes else "external_api")
    return mode, ", ".join(names) if names else "не указана"


def build(group_id, team_name, allow_replay=False):
    """Build the export document for a dataset group. Returns (document, report)."""
    records = storage.get_dataset(group_id)
    if not records:
        raise ExportError(f"Набор «{group_id}» не загружен")
    results = storage.get_results(group_id)
    failures = storage.get_failures(group_id)
    ok_results, out, report = [], [], {"ok": 0, "error": 0, "missing": [], "replay": [], "errors": {}}
    seen = set()
    for rec in records:
        cid = rec["conversation_id"]
        if cid in seen:
            raise ExportError(f"conversation_id {cid} повторяется в наборе")
        seen.add(cid)
        res = results.get(storage.result_key(group_id, cid))
        if res is None:
            fail = failures.get(storage.result_key(group_id, cid))
            reason = fail["error"] if fail else "Диалог не оценён."
            if not fail:
                report["missing"].append(cid)
            out.append({"conversation_id": cid, "status": "error", "criteria": [], "score": None, "error": reason})
            report["error"] += 1
            report["errors"][cid] = reason
            continue
        if (res.get("engine") or {}).get("type") == "replay":
            report["replay"].append(cid)
            if not allow_replay:
                out.append({"conversation_id": cid, "status": "error", "criteria": [], "score": None,
                            "error": "Результат воспроизведён из сохранённого ответа (replay), а не получен от модели."})
                report["error"] += 1
                report["errors"][cid] = "replay"
                continue
        try:
            criteria = _criteria_rows(res)
        except ExportError as e:
            out.append({"conversation_id": cid, "status": "error", "criteria": [], "score": None, "error": str(e)})
            report["error"] += 1
            report["errors"][cid] = str(e)
            continue
        s = scoring.score(res["checklist"], scoring.final_answers(res))
        critical = next((row["value"] for row in criteria if row["criterion_id"] == "critical"), False)
        out.append({
            "conversation_id": cid, "status": "ok", "criteria": criteria,
            "score": {"final_score": s["total"] if s["total"] is not None else 0.0, "critical_flag": bool(critical)},
        })
        ok_results.append(res)
        report["ok"] += 1
    mode, name = _mode(ok_results)
    doc = {
        "schema_version": SCHEMA_VERSION,
        "team_name": team_name,
        "model": {"mode": mode, "name": name},
        "results": out,
    }
    report["total"] = len(out)
    report["mode"] = mode
    report["modelName"] = name
    return doc, report


def write(group_id, dataset, team_name, allow_replay=False):
    """Write results/<dataset>/results.json. dataset is 'dev' or 'prod'."""
    if dataset not in ("dev", "prod"):
        raise ExportError("Набор выгрузки должен быть dev или prod")
    doc, report = build(group_id, team_name, allow_replay)
    folder = os.path.join(RESULTS_DIR, dataset)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "results.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    report["path"] = os.path.relpath(path, ROOT)
    report["writtenAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return doc, report


def check(doc, expected_count=None):
    """Validate a document against the format before pushing. Returns a list of problems."""
    problems = []
    if doc.get("schema_version") != SCHEMA_VERSION:
        problems.append("schema_version должен быть 1.0")
    if not doc.get("team_name"):
        problems.append("team_name пустой")
    model = doc.get("model") or {}
    if model.get("mode") not in ("local", "external_api", "hybrid"):
        problems.append("model.mode должен быть local, external_api или hybrid")
    results = doc.get("results")
    if not isinstance(results, list) or not results:
        return problems + ["results пустой"]
    ids = [r.get("conversation_id") for r in results]
    if len(ids) != len(set(ids)):
        problems.append("повторяющиеся conversation_id")
    if expected_count is not None and len(ids) != expected_count:
        problems.append(f"ожидается {expected_count} записей, в файле {len(ids)}")
    for r in results:
        cid = r.get("conversation_id") or "?"
        if r.get("status") == "error":
            if r.get("criteria") != [] or r.get("score") is not None or not r.get("error"):
                problems.append(f"{cid}: запись со status=error должна иметь пустые criteria, score=null и error")
            continue
        if r.get("status") != "ok":
            problems.append(f"{cid}: status должен быть ok или error")
            continue
        rows = r.get("criteria") or []
        got = [row.get("criterion_id") for row in rows]
        if got != EXPORT_IDS:
            problems.append(f"{cid}: criteria должны идти ровно по восьми кодам формата, получено {got}")
        for row in rows:
            eid, v = row.get("criterion_id"), row.get("value")
            if eid in ("contact", "empathy", "critical") and not isinstance(v, bool):
                problems.append(f"{cid}: {eid} должен быть true/false")
            if eid in ("discovery", "identification", "closure") and not (v is None or isinstance(v, bool)):
                problems.append(f"{cid}: {eid} должен быть true/false/null")
            if eid == "consultation" and not (v is None or v in (0, 5, 10, 15, 20)):
                problems.append(f"{cid}: consultation должен быть 0/5/10/15/20/null")
            if eid == "dialogue" and v not in (0, 4, 7, 10):
                problems.append(f"{cid}: dialogue должен быть 0/4/7/10")
            if not isinstance(row.get("evidence_turns"), list) or any((not isinstance(i, int)) or i < 1 for i in row.get("evidence_turns", [])):
                problems.append(f"{cid}: evidence_turns — список номеров реплик от 1")
        score = r.get("score") or {}
        fs = score.get("final_score")
        if not isinstance(fs, (int, float)) or not 0 <= fs <= 100:
            problems.append(f"{cid}: final_score должен быть числом 0..100")
        elif round(fs, 2) != fs:
            problems.append(f"{cid}: final_score должен быть округлён до двух знаков")
        crit = next((row.get("value") for row in rows if row.get("criterion_id") == "critical"), None)
        if score.get("critical_flag") != crit:
            problems.append(f"{cid}: critical_flag должен совпадать со значением critical")
    return problems

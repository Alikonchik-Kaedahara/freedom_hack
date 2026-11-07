"""Scoring rules from the organizers' checklist ("Порядок расчёта") — Python mirror of web/js/scoring.js.

1. N/A only where allowed.  2. Yes = full weight, No = 0, scale = chosen step.
3. Scale steps are converted proportionally; the top step gives the full weight.
4. N/A criteria are excluded and their weight is redistributed (max stays 100).
5. Total is rounded to 2 decimals; no applicable weighted criteria -> no total.
   Gross errors (flag criteria) are reported separately and give no points.

The UI computes the same numbers on its own (scoring.js); the server stores this
summary in every result so the API, exports and tests have a total too.
tests/test_scoring.mjs and tests/test_scoring.py run both implementations on the
same fixture and must agree.
"""
from decimal import ROUND_HALF_UP, Decimal


def round2(x):
    if x is None:
        return None
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def scale_max(c):
    return max([0] + [float(s.get("value", 0)) for s in c.get("scale", [])])


def final_answers(result):
    """Answers with accepted appeal decisions applied on top of the original ones."""
    out = {k: dict(v) for k, v in (result.get("answers") or {}).items()}
    for ap in result.get("appeals") or []:
        dec = ap.get("decision") or {}
        if ap.get("status") == "accepted" and dec.get("answer") is not None and ap.get("criterionId") in out:
            out[ap["criterionId"]] = {**out[ap["criterionId"]], "answer": dec["answer"], "overridden": True}
    return out


def score(checklist, answers):
    per, sections = {}, {}
    earned = possible = 0.0
    gross, gross_ids = False, []

    for c in checklist["criteria"]:
        a = (answers or {}).get(c["id"], {}) or {}
        ans = a.get("answer")
        if c["type"] == "flag":
            hit = ans == "yes"
            if hit:
                gross = True
                gross_ids.append(c["id"])
            per[c["id"]] = {"kind": "flag", "hit": hit, "status": "flag" if hit else "clean"}
            continue
        if ans is None:
            per[c["id"]] = {"kind": "missing", "status": "na"}
            continue
        weight = float(c.get("weight") or 0)
        if ans == "na":
            per[c["id"]] = {"kind": "na", "weight": weight, "status": "na"}
            continue
        if weight <= 0:
            per[c["id"]] = {"kind": "zero", "weight": weight, "status": "na"}
            continue
        if c["type"] == "scale":
            mx = scale_max(c)
            ratio = float(ans) / mx if mx > 0 else 0.0
        else:
            ratio = 1.0 if ans == "yes" else 0.0
        points = ratio * weight
        earned += points
        possible += weight
        per[c["id"]] = {"kind": c["type"], "weight": weight, "points": points, "ratio": ratio,
                        "status": "ok" if ratio >= 1 else "fail" if ratio <= 0 else "part"}
        sec = c.get("section") or "Без раздела"
        sections.setdefault(sec, {"earned": 0.0, "possible": 0.0})
        sections[sec]["earned"] += points
        sections[sec]["possible"] += weight

    for p in per.values():
        if p.get("points") is not None and possible > 0:
            p["effWeight"] = round2(p["weight"] / possible * 100)
            p["effPoints"] = round2(p["points"] / possible * 100)
    for s in sections.values():
        s["pct"] = round2(s["earned"] / s["possible"] * 100) if s["possible"] > 0 else None

    total = round2(earned / possible * 100) if possible > 0 else None
    return {"total": total, "gross": gross, "grossIds": gross_ids, "per": per, "sections": sections,
            "earned": earned, "possible": possible}


def disputed(result):
    """Criteria the reviewer should look at: unresolved validation issues or low model confidence."""
    out = []
    for cid, a in (result.get("answers") or {}).items():
        if a.get("needsReview") or a.get("confidence") == "low":
            out.append(cid)
    return out


def summarize(result):
    """Compact summary stored with the result: original vs final (after appeals)."""
    original = score(result["checklist"], result.get("answers"))
    final = score(result["checklist"], final_answers(result))
    pending = sum(1 for a in result.get("appeals") or [] if a.get("status") == "pending")
    return {
        "originalTotal": original["total"], "total": final["total"],
        "gross": final["gross"], "grossIds": final["grossIds"],
        "sections": {k: v["pct"] for k, v in final["sections"].items()},
        "pending": pending, "changed": original["total"] != final["total"],
        "disputed": disputed(result),
    }

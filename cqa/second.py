"""Second opinion: evaluate a dialog again and compare verdict by verdict.

Why: the organizers ask for results that are "обоснованные и воспроизводимые". A single
model answer cannot show that. A second pass — same engine (reproducibility) or a
different one (cloud vs local) — gives, per criterion, either agreement or a concrete
disagreement that goes to the reviewer as a disputed criterion. The original answers
are never changed: the second opinion is stored next to them, and the reviewer decides.

Stored on the result as:
  result["secondOpinion"] = {
      "engine": {...}, "usage": {...}, "attempts": n, "createdAt": iso,
      "answers": {cid: {answer, explanation, evidence, confidence, needsReview?}},
      "comparison": {"agree": [cid...], "disagree": [cid...], "near": [cid...], "rate": 0.875,
                     "details": {cid: {"first": v, "second": v, "status": "agree|near|disagree"}}}
  }
"near": scale criteria whose steps are adjacent (e.g. 15 vs 20) — counted as disagreement
for the reviewer, shown separately in the statistics.
"""
from .scoring import round2


def _step_index(criterion, value):
    steps = sorted((float(s["value"]) for s in criterion.get("scale", [])), reverse=True)
    try:
        return steps.index(float(value))
    except (ValueError, TypeError):
        return None


def compare(checklist, first, second):
    """Compare two answer sets of the same checklist. Returns the comparison dict."""
    agree, disagree, near, details = [], [], [], {}
    for c in checklist["criteria"]:
        a = (first.get(c["id"]) or {}).get("answer")
        b = (second.get(c["id"]) or {}).get("answer")
        if a is None or b is None:
            status = "disagree" if (a is None) != (b is None) else "agree"
        elif a == b:
            status = "agree"
        elif c["type"] == "scale" and a != "na" and b != "na":
            ia, ib = _step_index(c, a), _step_index(c, b)
            status = "near" if ia is not None and ib is not None and abs(ia - ib) == 1 else "disagree"
        else:
            status = "disagree"
        details[c["id"]] = {"first": a, "second": b, "status": status}
        {"agree": agree, "near": near, "disagree": disagree}[status].append(c["id"])
    n = len(checklist["criteria"])
    return {
        "agree": agree, "near": near, "disagree": disagree, "details": details,
        "rate": round2(len(agree) / n) if n else None,
        "strictRate": round2(len(agree) / n) if n else None,
        "lenientRate": round2((len(agree) + len(near)) / n) if n else None,
    }


def disagreed_ids(result):
    """Criteria the second opinion contradicts (near misses included) — treated as disputed."""
    so = result.get("secondOpinion") or {}
    cmp = so.get("comparison") or {}
    return list(cmp.get("disagree", [])) + list(cmp.get("near", []))


def attach(result, answers, usage, engine, meta, created_at):
    """Store a second opinion on a result (in place) and return it."""
    cmp = compare(result["checklist"], result.get("answers") or {}, answers)
    result["secondOpinion"] = {
        "engine": engine, "usage": usage, "attempts": meta.get("attempts"), "promptHash": meta.get("promptHash"),
        "createdAt": created_at, "answers": answers, "comparison": cmp,
    }
    return result


def reproducibility(results):
    """Aggregate over results that have a second opinion: agreement rates overall, per criterion, per language."""
    per_crit, per_lang = {}, {}
    n_results = 0
    agree_total = crit_total = 0
    same_engine = other_engine = 0
    for r in results:
        so = r.get("secondOpinion")
        if not so:
            continue
        n_results += 1
        first_engine = (r.get("engine") or {})
        second_engine = so.get("engine") or {}
        if first_engine.get("type") == second_engine.get("type") and first_engine.get("model") == second_engine.get("model"):
            same_engine += 1
        else:
            other_engine += 1
        cmp = so["comparison"]
        lang = r.get("language") or "?"
        pl = per_lang.setdefault(lang, {"agree": 0, "total": 0})
        for c in r["checklist"]["criteria"]:
            d = cmp["details"].get(c["id"])
            if not d:
                continue
            code = c.get("code") or c["id"]
            pc = per_crit.setdefault(code, {"code": code, "name": c["name"], "agree": 0, "near": 0, "disagree": 0, "total": 0})
            pc[d["status"]] += 1
            pc["total"] += 1
            pl["total"] += 1
            crit_total += 1
            if d["status"] == "agree":
                pl["agree"] += 1
                agree_total += 1
    for pc in per_crit.values():
        pc["rate"] = round2(pc["agree"] / pc["total"] * 100) if pc["total"] else None
    for pl in per_lang.values():
        pl["rate"] = round2(pl["agree"] / pl["total"] * 100) if pl["total"] else None
    return {
        "dialogs": n_results, "criteria": crit_total,
        "rate": round2(agree_total / crit_total * 100) if crit_total else None,
        "sameEngine": same_engine, "otherEngine": other_engine,
        "perCriterion": sorted(per_crit.values(), key=lambda x: str(x["code"])),
        "perLanguage": per_lang,
    }

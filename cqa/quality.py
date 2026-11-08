"""Quality of the evaluation itself: how the model compares with people and with itself.

Three sources for the model verification and appeals views:

1. Calibration — a manual markup of a handful of dialogs by the team (the Google-sheet
   protocol in docs/todo), uploaded as JSON or the xlsx export of that sheet. Agreement
   with the model is counted per criterion and per language, exactly how the organizers
   describe their own check ("по ответу на каждый критерий").
2. Reproducibility — second opinions (cqa/second.py): how often a second pass gives the
   same verdict, same engine or a different one.
3. Appeals — how often the reviewer overturned the model, per criterion: the live signal
   of where the rules need work.

Plus the violation patterns of the set: which criteria fail most, with example quotes —
what a quality manager reads first.
"""
import collections
import io
import json

from . import operators, scoring, second, storage

VALUE_WORDS = {"да": "yes", "yes": "yes", "true": "yes", "нет": "no", "no": "no", "false": "no",
               "n/a": "na", "na": "na", "n\\a": "na", "null": "na", "none": "na", "—": None, "-": None, "": None}


def norm_value(v):
    """A cell from the markup -> our answer format (yes / no / na / number) or None for blank."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        return int(v) if float(v) == int(v) else float(v)
    s = str(v).strip().lower()
    if s in VALUE_WORDS:
        return VALUE_WORDS[s]
    try:
        f = float(s.replace(",", "."))
        return int(f) if f == int(f) else f
    except ValueError:
        return s


# ---------- calibration storage ----------

def get_calibration():
    return storage._read("calibration", {"entries": [], "updatedAt": None})


def _pair(entry):
    return (str(entry["conversationId"]).strip(), str(entry["criterionCode"]).strip())


def _clean_entries(entries):
    clean = {}
    for row in entries:
        if not isinstance(row, dict) or not row.get("conversationId") or not row.get("criterionCode"):
            raise ValueError("В каждой строке нужны conversationId и criterionCode.")
        cid, code = _pair(row)
        value = norm_value(row.get("value"))
        if value is None:
            continue
        if not isinstance(value, (int, float)) and value not in ("yes", "no", "na"):
            raise ValueError(f"Неизвестная оценка «{value}» для {cid}, критерий {code}.")
        if (cid, code) in clean:
            raise ValueError(f"Повторяется строка {cid}, критерий {code}.")
        clean[cid, code] = {"conversationId": cid, "criterionCode": code, "value": value,
                            "evidence": row.get("evidence"), "comment": str(row.get("comment") or "").strip()}
    return clean


def calibration_group(entries, group_id=None):
    if not entries or any(not isinstance(e, dict) or not e.get("conversationId") for e in entries):
        raise ValueError("В файле нет строк с ID диалога.")
    ids = {str(entry["conversationId"]).strip() for entry in entries}
    if group_id:
        known = {r["conversation_id"] for r in storage.get_dataset(group_id)}
        missing = sorted(ids - known)
        if missing:
            raise ValueError(f"В наборе {group_id} нет диалога {missing[0]}. Выберите набор с этими диалогами.")
        return group_id
    matches = [d["groupId"] for d in storage.list_datasets()
               if ids.issubset({r["conversation_id"] for r in storage.get_dataset(d["groupId"])})]
    if len(matches) == 1:
        return matches[0]
    raise ValueError("Не удалось однозначно определить набор разметки. Выберите набор и загрузите файл ещё раз.")


def save_calibration(entries, updated_at, source="", *, group=None, submission=None):
    clean = _clean_entries(entries)
    if not clean:
        raise ValueError("В файле нет заполненных оценок.")
    doc = {"entries": list(clean.values()), "updatedAt": updated_at, "source": source}
    who = (submission or {}).get("who", "")
    if submission is not None and "who" in submission and (not isinstance(who, str) or not who.strip()):
        raise ValueError("В индивидуальной разметке нужно имя автора в поле who.")
    who = who.strip()

    def merge(root):
        if group is None:  # previously stored unscoped consensus
            root.update(doc)
        else:
            record = root.setdefault("groups", {}).setdefault(group, {})
            if who:
                reviewers = record.setdefault("reviewers", {})
                previous = reviewers.get(who.casefold(), {}).get("document", {})
                merged = {_pair(e): e for e in previous.get("entries", [])}
                merged.update({_pair(e): e for e in entries if _pair(e) in clean})
                reviewers[who.casefold()] = {"source": source, "updatedAt": updated_at,
                                             "document": {**submission, "who": who, "entries": list(merged.values())}}
            else:
                record["consensus"] = doc
            record["updatedAt"] = updated_at
        return doc

    return storage.update_calibration(merge)


def clear_calibration(group, updated_at):
    # An empty scoped record also hides this group's previous unscoped calibration.
    storage.update_calibration(lambda root: root.setdefault("groups", {}).update({
        group: {"consensus": {"entries": [], "updatedAt": updated_at, "source": ""}}
    }))


def marked_groups(saved):
    return sorted(g for g, d in saved.get("groups", {}).items()
                  if d.get("reviewers") or d.get("consensus", {}).get("entries"))


def group_calibration(group, records):
    saved = get_calibration()
    groups = saved.get("groups", {})
    available = marked_groups(saved)
    record = groups.get(group, {})
    ids = {r["conversation_id"] for r in records}
    consensus = record.get("consensus") or {
        "entries": [e for e in saved.get("entries", []) if e["conversationId"] in ids],
        "updatedAt": saved.get("updatedAt"), "source": saved.get("source"),
    }
    reviewers = record.get("reviewers", {})
    if not reviewers:
        return {**consensus, "availableGroups": available}

    votes = collections.defaultdict(dict)
    authors = []
    for imported in reviewers.values():
        doc = imported["document"]
        who = doc["who"]
        entries = _clean_entries(doc["entries"])
        authors.append({"name": who, "source": imported["source"], "entries": len(entries),
                        "dialogs": len({cid for cid, _ in entries})})
        for key, entry in entries.items():
            votes[key][who] = entry["value"]

    unanimous, conflicts, partial = {}, [], []
    for (cid, code), by_author in sorted(votes.items()):
        row = {"conversationId": cid, "criterionCode": code, "votes": by_author}
        values = set(by_author.values())
        if len(values) > 1:
            conflicts.append(row)
        elif len(by_author) < len(authors) or len(by_author) < 2:
            partial.append(row)
        else:
            unanimous[cid, code] = {**row, "value": next(iter(values))}
    # Explicit team decisions take precedence, including decisions on previously disputed rows.
    chosen = dict(unanimous)
    chosen.update({_pair(e): e for e in consensus["entries"]})
    team = {"authors": sorted(authors, key=lambda a: a["name"]), "total": sum(a["entries"] for a in authors),
            "unanimous": len(unanimous), "decisions": len(consensus["entries"]),
            "conflicts": conflicts, "partial": partial}
    return {"entries": list(chosen.values()), "updatedAt": record.get("updatedAt"),
            "source": consensus.get("source") or "Индивидуальная разметка", "team": team, "availableGroups": available}


def parse_xlsx(data):
    """The «Разметка» sheet of Калибровка_CQA.xlsx -> entries from the consensus column (L)."""
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    ws = wb["Разметка"] if "Разметка" in wb.sheetnames else wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header_idx = None
    entries = []
    for row in rows:
        if row is None:
            continue
        cells = list(row)
        if header_idx is None:
            if cells and cells[0] == "Диалог" and "Итог (консенсус)" in cells:
                header_idx = {name: i for i, name in enumerate(cells) if name}
            continue
        cid = cells[header_idx["Диалог"]] if header_idx["Диалог"] < len(cells) else None
        crit = cells[header_idx["Критерий"]] if header_idx["Критерий"] < len(cells) else None
        val = cells[header_idx["Итог (консенсус)"]] if header_idx["Итог (консенсус)"] < len(cells) else None
        if not cid or not crit:
            continue
        code = str(crit).split()[0]
        comment_i = header_idx.get("Комментарий / спорная трактовка")
        comment = cells[comment_i] if comment_i is not None and comment_i < len(cells) else None
        comment = str(comment).strip() if comment is not None else ""
        if val is None or str(val).strip() == "":
            continue
        entries.append({"conversationId": str(cid), "criterionCode": code, "value": val, "comment": comment})
    if header_idx is None:
        raise ValueError("Не найден лист «Разметка» с заголовками «Диалог», «Критерий», «Итог (консенсус)»")
    return entries


def parse_json(data):
    doc = json.loads(data.decode("utf-8-sig") if isinstance(data, bytes) else data)
    if isinstance(doc, list):
        doc = {"entries": doc}
    if not isinstance(doc, dict) or not isinstance(doc.get("entries"), list):
        raise ValueError("Ожидается список entries с полями conversationId, criterionCode, value")
    return doc


# ---------- agreement ----------

def _code_map(result):
    return {str(c.get("code") or c["id"]): c for c in result["checklist"]["criteria"]}


def _is_near(c, a, b):
    if c["type"] != "scale" or a in (None, "na") or b in (None, "na"):
        return False
    steps = sorted((float(s["value"]) for s in c.get("scale", [])), reverse=True)
    try:
        return abs(steps.index(float(a)) - steps.index(float(b))) == 1
    except (ValueError, TypeError):
        return False


def agreement(results, calibration=None, records=None):
    """Compare the team's consensus with the model's ORIGINAL answers (before appeals)."""
    calibration = calibration or get_calibration()
    entries = calibration.get("entries") or []
    by_key = {}
    for r in results.values():
        by_key[r.get("conversationId")] = r
    lang_of = {r["conversation_id"]: r.get("language") for r in (records or [])}
    per_crit, per_lang, rows = {}, {}, []
    agree = near = total = 0
    missing = set()
    for e in entries:
        res = by_key.get(e["conversationId"])
        if not res:
            missing.add(e["conversationId"])
            continue
        c = _code_map(res).get(e["criterionCode"])
        if not c:
            continue
        model = (res.get("answers") or {}).get(c["id"], {}).get("answer")
        human = e["value"]
        if human is None:
            continue
        status = "agree" if model == human else ("near" if _is_near(c, model, human) else "disagree")
        total += 1
        agree += status == "agree"
        near += status == "near"
        lang = res.get("language") or lang_of.get(e["conversationId"]) or "?"
        pc = per_crit.setdefault(e["criterionCode"], {"code": e["criterionCode"], "name": c["name"], "agree": 0, "near": 0, "disagree": 0, "total": 0, "disagreements": []})
        pc[status] += 1
        pc["total"] += 1
        if status != "agree":
            pc["disagreements"].append({"conversationId": e["conversationId"], "human": human, "model": model, "comment": e.get("comment") or ""})
        pl = per_lang.setdefault(lang, {"language": lang, "agree": 0, "near": 0, "total": 0})
        pl["total"] += 1
        pl["agree"] += status == "agree"
        pl["near"] += status == "near"
        rows.append({"conversationId": e["conversationId"], "language": lang, "code": e["criterionCode"], "human": human, "model": model, "status": status})
    for pc in per_crit.values():
        pc["rate"] = scoring.round2(pc["agree"] / pc["total"] * 100) if pc["total"] else None
    for pl in per_lang.values():
        pl["rate"] = scoring.round2(pl["agree"] / pl["total"] * 100) if pl["total"] else None
    return {
        "entries": len(entries), "compared": total, "agree": agree, "near": near,
        "rate": scoring.round2(agree / total * 100) if total else None,
        "lenientRate": scoring.round2((agree + near) / total * 100) if total else None,
        "team": calibration.get("team"), "availableGroups": calibration.get("availableGroups", []),
        "perCriterion": sorted(per_crit.values(), key=lambda x: str(x["code"])),
        "perLanguage": sorted(per_lang.values(), key=lambda x: x["language"]),
        "rows": rows, "missing": sorted(missing), "updatedAt": calibration.get("updatedAt"), "source": calibration.get("source"),
    }


# ---------- appeals ----------

def appeal_stats(results):
    per = {}
    total = accepted = rejected = pending = 0
    for r in results.values():
        codes = {c["id"]: c for c in r["checklist"]["criteria"]}
        values = {key: a.get("answer") for key, a in (r.get("answers") or {}).items()}
        for a in r.get("appeals") or []:
            c = codes.get(a.get("criterionId"))
            code = (c.get("code") if c else None) or a.get("criterionId")
            p = per.setdefault(code, {"code": code, "name": c["name"] if c else "", "total": 0, "accepted": 0, "rejected": 0, "pending": 0, "changed": 0})
            p["total"] += 1
            total += 1
            st = a.get("status")
            if st == "accepted":
                p["accepted"] += 1
                accepted += 1
                cid = a.get("criterionId")
                new_value = (a.get("decision") or {}).get("answer")
                if new_value is not None and new_value != values.get(cid):
                    p["changed"] += 1
                    values[cid] = new_value
            elif st == "rejected":
                p["rejected"] += 1
                rejected += 1
            else:
                p["pending"] += 1
                pending += 1
    for p in per.values():
        decided = p["accepted"] + p["rejected"]
        p["overturnRate"] = scoring.round2(p["accepted"] / decided * 100) if decided else None
    decided = accepted + rejected
    changed = sum(p["changed"] for p in per.values())
    return {"total": total, "accepted": accepted, "rejected": rejected, "pending": pending,
            "overturnRate": scoring.round2(accepted / decided * 100) if decided else None,
            "changed": changed, "changeRate": scoring.round2(changed / decided * 100) if decided else None,
            "perCriterion": sorted(per.values(), key=lambda x: str(x["code"]))}


# ---------- violation patterns ----------

def patterns(results, records, limit_examples=3):
    """Which criteria fail most across the set, with example dialogs and the model's explanation."""
    by_id = {r["conversation_id"]: r for r in records}
    per = {}
    n = 0
    for r in results.values():
        rec = by_id.get(r.get("conversationId"))
        if not rec:
            continue
        n += 1
        fa = scoring.final_answers(r)
        s = scoring.score(r["checklist"], fa)
        for c in r["checklist"]["criteria"]:
            code = str(c.get("code") or c["id"])
            p = per.setdefault(code, {"code": code, "name": c["name"], "type": c["type"], "failed": 0, "partial": 0, "applicable": 0, "flag": 0, "examples": []})
            st = (s["per"].get(c["id"]) or {}).get("status")
            if c["type"] == "flag":
                if st == "flag":
                    p["flag"] += 1
                    if len(p["examples"]) < limit_examples:
                        p["examples"].append(_example(rec, r, fa, c))
                continue
            if st in ("ok", "fail", "part"):
                p["applicable"] += 1
            if st == "fail":
                p["failed"] += 1
            elif st == "part":
                p["partial"] += 1
            if st in ("fail", "part") and len(p["examples"]) < limit_examples:
                p["examples"].append(_example(rec, r, fa, c))
    out = []
    for p in per.values():
        if p["type"] == "flag":
            p["share"] = scoring.round2(p["flag"] / n * 100) if n else None
        else:
            p["share"] = scoring.round2((p["failed"] + p["partial"]) / p["applicable"] * 100) if p["applicable"] else None
        out.append(p)
    out.sort(key=lambda x: (-(x["share"] or 0), str(x["code"])))
    return {"dialogs": n, "criteria": out}


def _example(rec, r, fa, c):
    a = fa.get(c["id"]) or {}
    ev = a.get("evidence") or []
    valid = [i for i in ev if isinstance(i, int) and 0 <= i < len(rec["transcript"])]
    turn = next((i for i in valid if rec["transcript"][i].get("speaker") == "operator"), valid[0] if valid else None)
    quote = rec["transcript"][turn]["text"] if turn is not None else ""
    return {"conversationId": rec["conversation_id"], "criterionId": c["id"], "language": rec.get("language"),
            "quote": quote[:220], "explanation": a.get("explanation") or "", "turn": turn + 1 if turn is not None else None}


# ---------- the whole screen ----------

def overview(group_id, section=None, operator=None):
    results = storage.get_results(group_id)
    if section == "appeals":
        return appeal_stats(results)
    records = storage.get_dataset(group_id)
    if section == "patterns":
        if operator is not None:
            records = [rec for rec in records if operators.operator_of(rec, results.get(storage.result_key(group_id, rec["conversation_id"]))) == operator]
        return patterns(results, records)
    verification = {
        "group": group_id, "evaluated": len(results), "records": len(records),
        "calibration": agreement(results, calibration=group_calibration(group_id, records), records=records),
        "reproducibility": second.reproducibility(list(results.values())),
    }
    if section == "model":
        return verification
    return {**verification, "appeals": appeal_stats(results), "patterns": patterns(results, records)}

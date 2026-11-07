"""Server-side validation of what the API receives.

The UI already checks most of this, but a request can come from anywhere (curl, a
Dynamics 365 web resource, a test), so the server never trusts the client: a bad
checklist or a malformed transcript must answer 400 with a readable reason, not
be stored or crash a worker.
"""
CRITERION_TYPES = ("binary", "scale", "flag")
CHANNELS = ("agent chat", "voice call")
LANGUAGES = ("RU", "KZ", "EN")
ROLES = ("client", "operator", "bot", "system")
WEIGHT_TOLERANCE = 0.01


class ValidationError(ValueError):
    pass


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v else None  # NaN guard


# ---------- checklist ----------

def validate_checklist(item):
    """Return the normalized checklist or raise ValidationError with a message for the user."""
    if not isinstance(item, dict):
        raise ValidationError("Чек-лист должен быть объектом JSON")
    name = str(item.get("name") or "").strip()
    if not name:
        raise ValidationError("У чек-листа нет названия")
    channel = item.get("channel")
    if channel not in CHANNELS:
        raise ValidationError(f"Канал чек-листа должен быть одним из: {', '.join(CHANNELS)}")
    criteria = item.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        raise ValidationError("В чек-листе нет критериев")

    seen = set()
    weighted_sum = 0.0
    for i, c in enumerate(criteria, 1):
        if not isinstance(c, dict):
            raise ValidationError(f"Критерий №{i}: неверный формат")
        cid = str(c.get("id") or "").strip()
        label = c.get("code") or cid or f"№{i}"
        if not cid:
            raise ValidationError(f"Критерий {label}: нет идентификатора")
        if cid in seen:
            raise ValidationError(f"Критерий {label}: идентификатор «{cid}» повторяется")
        seen.add(cid)
        if not str(c.get("name") or "").strip():
            raise ValidationError(f"Критерий {label}: нет названия")
        ctype = c.get("type")
        if ctype not in CRITERION_TYPES:
            raise ValidationError(f"Критерий {label}: тип должен быть одним из: {', '.join(CRITERION_TYPES)}")
        weight = _num(c.get("weight", 0))
        if weight is None or weight < 0:
            raise ValidationError(f"Критерий {label}: вес должен быть числом не меньше 0")
        c["weight"] = weight if weight != int(weight) else int(weight)
        c["naAllowed"] = bool(c.get("naAllowed")) and ctype != "flag"
        if ctype == "flag":
            c["weight"] = 0
        else:
            weighted_sum += weight
        if ctype == "scale":
            steps = c.get("scale")
            if not isinstance(steps, list) or len(steps) < 2:
                raise ValidationError(f"Критерий {label}: у шкалы должно быть минимум две ступени")
            values = []
            for s in steps:
                v = _num((s or {}).get("value")) if isinstance(s, dict) else None
                if v is None or v < 0:
                    raise ValidationError(f"Критерий {label}: ступени шкалы должны быть числами не меньше 0")
                values.append(v)
            if len(set(values)) != len(values):
                raise ValidationError(f"Критерий {label}: ступени шкалы повторяются")
            if max(values) <= 0:
                raise ValidationError(f"Критерий {label}: верхняя ступень шкалы должна быть больше 0")
            c["scale"] = sorted(({"value": _num(s["value"]) if _num(s["value"]) != int(_num(s["value"])) else int(_num(s["value"])),
                                   "label": str(s.get("label") or "")} for s in steps),
                                key=lambda s: -s["value"])
        elif ctype == "binary" and weight <= 0:
            raise ValidationError(f"Критерий {label}: у критерия «Да/Нет» должен быть вес больше 0")

    if abs(weighted_sum - 100) > WEIGHT_TOLERANCE:
        raise ValidationError(f"Сумма весов критериев должна быть 100, сейчас {weighted_sum:g}")
    item["name"] = name
    return item


# ---------- transcripts ----------

def _records_from_payload(payload):
    """Accept the organizers' response, a bare list of records, or a single record."""
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), dict) and isinstance(payload["data"].get("records"), list):
            return payload["data"]["records"]
        if isinstance(payload.get("records"), list):
            return payload["records"]
        if "transcript" in payload:
            return [payload]
        raise ValidationError("В файле нет диалогов: ожидается список records или объект с полем transcript")
    if isinstance(payload, list):
        return payload
    raise ValidationError("Неверный формат файла: ожидается JSON-объект или список диалогов")


def validate_records(payload):
    """Return a list of normalized records or raise ValidationError (first problems listed)."""
    records = _records_from_payload(payload)
    if not records:
        raise ValidationError("В файле нет ни одного диалога")
    out, errors, seen = [], [], set()
    for i, r in enumerate(records, 1):
        if not isinstance(r, dict):
            errors.append(f"диалог №{i}: не объект")
            continue
        cid = str(r.get("conversation_id") or "").strip()
        if not cid:
            errors.append(f"диалог №{i}: нет conversation_id")
            continue
        if cid in seen:
            errors.append(f"{cid}: conversation_id повторяется")
            continue
        seen.add(cid)
        channel = r.get("channel") or "agent chat"
        if channel not in CHANNELS:
            errors.append(f"{cid}: channel должен быть «agent chat» или «voice call»")
            continue
        language = str(r.get("language") or "RU").strip().upper()
        if language not in LANGUAGES:
            errors.append(f"{cid}: language должен быть RU, KZ или EN")
            continue
        transcript = r.get("transcript")
        if not isinstance(transcript, list) or not transcript:
            errors.append(f"{cid}: transcript должен быть непустым списком реплик")
            continue
        clean = []
        bad = None
        for j, t in enumerate(transcript):
            if not isinstance(t, dict) or not isinstance(t.get("text"), str):
                bad = f"{cid}: реплика #{j} без текста"
                break
            speaker = t.get("speaker")
            if speaker not in ROLES:
                bad = f"{cid}: реплика #{j}: speaker должен быть одним из {', '.join(ROLES)}"
                break
            clean.append({"timestamp": str(t.get("timestamp") or ""), "speaker": speaker, "text": t["text"]})
        if bad:
            errors.append(bad)
            continue
        audio = r.get("audio_url")
        out.append({"conversation_id": cid, "channel": channel, "language": language,
                    "transcript": clean, "audio_url": audio if isinstance(audio, str) and audio else None})
    if errors:
        head = errors[:5]
        more = f" … и ещё {len(errors) - 5}" if len(errors) > 5 else ""
        raise ValidationError("Ошибки в файле: " + "; ".join(head) + more)
    return out


def validate_group_id(group_id):
    g = str(group_id or "").strip()
    if not g or len(g) > 64:
        raise ValidationError("Укажите group_id (до 64 символов)")
    return g

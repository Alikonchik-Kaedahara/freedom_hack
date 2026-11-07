"""LLM evaluation of one conversation against a checklist.

Three engines:
  cloud  - Claude via the Anthropic SDK, structured JSON output
  local  - Ollama (/api/chat with a JSON schema in `format`)
  replay - answers saved earlier (demo/sample, demo/snapshot or storage); no model call

The model only returns verdicts, explanations, evidence message numbers and a
confidence level. Points, weight redistribution and totals are computed in code
(web/js/scoring.js and cqa/scoring.py), so appeals and checklist edits recalculate
without another model call.

"LLM proposes, code verifies": every model answer goes through `validate()`.
If a verdict is not allowed, an explanation is empty, evidence is missing or points
at the wrong replies, the model gets the list of problems and answers again (up to
MAX_ATTEMPTS). Problems that survive all attempts do not fail the dialog: the
criterion is stored with needsReview=true and the list of issues, so the reviewer
decides instead of the model guessing.
"""
import hashlib
import json
from datetime import datetime

import requests

from .defaults import PRICING

MAX_ATTEMPTS = 3
CONFIDENCE = ["high", "medium", "low"]
ROLES = {"client", "operator", "bot", "system"}

SYSTEM_PROMPT = """Ты — эксперт отдела контроля качества контакт-центра Freedom Broker (брокерская компания). \
Ты оцениваешь работу ОПЕРАТОРА в одном диалоге с клиентом по чек-листу.

Правила оценки:
1. Оценивай только реплики с ролью operator. Реплики bot (AI-ассистент) и system (системные события) — контекст. \
Приветствие бота не засчитывается оператору. Системное событие вроде «Личность клиента подтверждена» — доказательство идентификации.
2. Диалоги идут на русском, казахском и английском, клиент может смешивать языки. Язык клиента определяй по его репликам.
3. «Первый ответ» оператора — первая реплика с ролью operator.
4. N/A ставь только если он разрешён для критерия и выполнено его условие. «Нет» — действие было нужно, \
но оператор его пропустил или выполнил неправильно. Общий вопрос о тарифах или продуктах не требует идентификации.
5. Для шкального критерия выбирай одну из перечисленных ступеней. Верхняя ступень — только если нет замечаний.
6. evidence — номера реплик [#N], на которых основан вывод. Если действие пропущено — номера реплик, где оно ожидалось \
(проверенный участок разговора). Для N/A — реплики, показывающие, что условие неприменимости выполнено. \
Evidence обязателен для каждого вердикта (кроме «нет» по критерию-флагу грубой ошибки). «Да» подтверждай репликой оператора \
или системным событием, не репликой бота.
7. explanation — одно-два коротких предложения на русском: что сделал или не сделал оператор и где. \
Пример: «После ответа на вопрос оператор закрыл чат без прощания. Основание — последняя реплика оператора и сообщение о закрытии чата.»
8. confidence — насколько ты уверен: high — есть прямое подтверждение в репликах; medium — вывод требует интерпретации; \
low — данных мало или они противоречивы. При low напиши в explanation, чего не хватает. Не выдумывай: если не уверен, ставь low.
9. Будь последовательным: одинаковые ситуации получают одинаковые оценки."""

CALL_NOTE = """Это телефонный звонок. Транскрипт получен автоматическим распознаванием речи: возможны ошибки распознавания \
и скрытые данные ([Имя скрыто], [Персональные данные скрыты]) — это не ошибки оператора. Оценивай устную речь: \
логичность, понятность объяснений, корректность формулировок, паузы и удержание."""

FIX_NOTE = """Твой предыдущий ответ не прошёл проверку. Исправь перечисленные проблемы и верни ПОЛНЫЙ JSON заново \
(все критерии, тот же формат):
{problems}

Напоминание: evidence — только существующие номера реплик [#N] из транскрипта; для «да» нужна реплика оператора или \
системное событие; реплики бота не считаются действием оператора."""


class EvaluationError(Exception):
    pass


# ---------- prompt building ----------

def _verdicts(c):
    if c["type"] == "scale":
        values = [str(s["value"]) for s in sorted(c.get("scale", []), key=lambda s: -s["value"])]
    else:
        values = ["yes", "no"]
    if c.get("naAllowed") and c["type"] != "flag":
        values.append("na")
    return values


def render_checklist(checklist):
    lines = []
    for c in checklist["criteria"]:
        if c["type"] == "scale":
            kind = f"шкала, вес {c['weight']}"
        elif c["type"] == "flag":
            kind = "Да/Нет, без баллов — флаг грубой ошибки"
        else:
            kind = f"Да/Нет, вес {c['weight']}"
        lines.append(f"### {c['id']} · {c.get('code', '')} {c['name']} ({kind})")
        if c.get("description"):
            lines.append(f"Правило: {c['description']}")
        if c["type"] == "scale":
            for s in sorted(c.get("scale", []), key=lambda s: -s["value"]):
                lines.append(f"- {s['value']}: {s.get('label', '')}")
        if c.get("naAllowed") and c["type"] != "flag":
            lines.append(f"N/A допустим, если: {c.get('naRule') or 'критерий неприменим к диалогу'}")
        else:
            lines.append("N/A не допускается.")
        lines.append(f"Допустимые значения verdict: {', '.join(_verdicts(c))}")
        lines.append("")
    return "\n".join(lines)


def _seconds(ts):
    try:
        return datetime.fromisoformat(ts).timestamp()
    except (ValueError, TypeError):
        return None


def display_times(transcript):
    """Chats keep MM:SS. Calls (ISO 8601) become MM:SS from the start of the call."""
    if not transcript:
        return []
    t0 = _seconds(transcript[0].get("timestamp"))
    if t0 is None:
        return [t.get("timestamp", "") for t in transcript]
    out = []
    for t in transcript:
        s = _seconds(t.get("timestamp"))
        d = max(0, int(round((s or t0) - t0)))
        out.append(f"{d // 60:02d}:{d % 60:02d}")
    return out


def render_transcript(record):
    times = display_times(record["transcript"])
    return "\n".join(
        f"[#{i}] [{times[i]}] {t.get('speaker', '?')}: {t.get('text', '')}"
        for i, t in enumerate(record["transcript"])
    )


def build_schema(checklist):
    props = {}
    for c in checklist["criteria"]:
        props[c["id"]] = {
            "type": "object",
            "properties": {
                "evidence": {"type": "array", "items": {"type": "integer"}},
                "explanation": {"type": "string"},
                "verdict": {"type": "string", "enum": _verdicts(c)},
                "confidence": {"type": "string", "enum": CONFIDENCE},
            },
            "required": ["evidence", "explanation", "verdict", "confidence"],
            "additionalProperties": False,
        }
    return {
        "type": "object",
        "properties": props,
        "required": list(props.keys()),
        "additionalProperties": False,
    }


def build_prompt(record, checklist):
    system = SYSTEM_PROMPT
    if record.get("channel") == "voice call":
        system += "\n\n" + CALL_NOTE
    system += "\n\nЧЕК-ЛИСТ\n\n" + render_checklist(checklist)
    user = (
        f"Диалог {record['conversation_id']} · канал: {record.get('channel')} · язык набора: {record.get('language')}\n\n"
        f"{render_transcript(record)}\n\n"
        "Оцени оператора по каждому критерию чек-листа и верни JSON."
    )
    return system, user


def prompt_hash(system):
    """Short fingerprint of the prompt + checklist, stored with every result (provenance)."""
    return hashlib.sha256(system.encode("utf-8")).hexdigest()[:12]


# ---------- validation: LLM proposes, code verifies ----------

def validate(raw, checklist, record):
    """Normalize a raw model answer and list every problem found.

    Returns (answers, problems). `answers` is the normalized per-criterion dict
    (always complete, even when a problem is found). `problems` is a list of
    {criterionId, code, message}; an empty list means the answer is accepted.
    """
    transcript = record.get("transcript") or []
    n = len(transcript)
    speakers = [str(t.get("speaker", "")) for t in transcript]
    has_non_bot = any(s != "bot" for s in speakers)
    answers, problems = {}, {}

    def problem(c, code, message):
        problems.setdefault(c["id"], []).append({"criterionId": c["id"], "code": code, "message": message})

    for c in checklist["criteria"]:
        label = f"{c.get('code') or c['id']} {c['name']}"
        item = raw.get(c["id"]) if isinstance(raw, dict) else None
        if not isinstance(item, dict):
            item = {}
            problem(c, "missing", f"Критерий {label}: ответ отсутствует.")
        verdict = str(item.get("verdict", "")).strip().lower()
        allowed = _verdicts(c)
        if verdict in allowed:
            if verdict == "na":
                answer = "na"
            elif c["type"] == "scale":
                answer = int(float(verdict))
            else:
                answer = verdict
        else:
            answer = None
            if item:
                problem(c, "invalid_verdict",
                        f"Критерий {label}: verdict {verdict!r} недопустим, разрешены: {', '.join(allowed)}.")

        raw_ev = item.get("evidence") if isinstance(item.get("evidence"), list) else []
        evidence, out_of_range = [], []
        for i in raw_ev:
            try:
                idx = int(i)
            except (TypeError, ValueError):
                out_of_range.append(i)
                continue
            (evidence if 0 <= idx < n else out_of_range).append(idx)
        evidence = sorted(set(evidence))
        if out_of_range:
            problem(c, "evidence_out_of_range",
                    f"Критерий {label}: в evidence нет реплик {out_of_range} — в транскрипте номера 0…{n - 1}.")

        explanation = str(item.get("explanation") or "").strip()
        if item and not explanation:
            problem(c, "empty_explanation", f"Критерий {label}: explanation пустой.")

        confidence = str(item.get("confidence") or "medium").strip().lower()
        if confidence not in CONFIDENCE:
            confidence = "medium"

        needs_evidence = answer is not None and not (c["type"] == "flag" and answer == "no")
        if needs_evidence and not evidence:
            what = "реплики, где действие ожидалось" if answer in ("no", 0) else (
                "реплики, показывающие условие неприменимости" if answer == "na" else "реплики-доказательства")
            problem(c, "no_evidence", f"Критерий {label}: evidence пустой, укажи {what}.")
        elif evidence and has_non_bot and all(speakers[i] == "bot" for i in evidence):
            problem(c, "bot_only_evidence",
                    f"Критерий {label}: evidence ссылается только на реплики бота; действия бота оператору не засчитываются.")
        elif answer == "yes" and evidence and not any(speakers[i] in ("operator", "system") for i in evidence):
            problem(c, "no_operator_evidence",
                    f"Критерий {label}: для «да» нужна хотя бы одна реплика оператора или системное событие в evidence.")

        answers[c["id"]] = {
            "answer": answer, "explanation": explanation, "evidence": evidence, "confidence": confidence,
        }

    flat = [p for plist in problems.values() for p in plist]
    return answers, flat


def _mark_unresolved(answers, problems):
    """Problems that survived all attempts become needsReview flags, not a failed dialog."""
    for p in problems:
        a = answers.get(p["criterionId"])
        if a is None:
            continue
        a["needsReview"] = True
        a.setdefault("issues", []).append(p["message"])
    return answers


# ---------- engines ----------

def _call_cloud(settings, system, messages, schema):
    import anthropic  # imported lazily so the other engines work without it

    cfg = settings.get("cloud", {})
    key = cfg.get("apiKey") or None
    if not key:
        import os
        key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise EvaluationError("Не задан ключ Claude API. Укажите его в разделе «Модель».")
    model = cfg.get("model") or "claude-opus-5-5"
    client = anthropic.Anthropic(api_key=key, base_url=cfg.get("baseUrl") or "https://api.anthropic.com",
                                 max_retries=3, timeout=600)
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=16000,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=messages,
            output_config={"effort": cfg.get("effort") or "medium",
                           "format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.AuthenticationError:
        raise EvaluationError("Ключ Claude API не принят.")
    except anthropic.RateLimitError:
        raise EvaluationError("Превышен лимит запросов Claude API, повторите позже.")
    except anthropic.APIStatusError as e:
        raise EvaluationError(f"Claude API: {e.status_code} {e.message}")
    except anthropic.APIConnectionError:
        raise EvaluationError("Нет соединения с Claude API.")

    if resp.stop_reason == "refusal":
        raise EvaluationError("Модель отказалась оценивать диалог.")
    if resp.stop_reason == "max_tokens":
        raise EvaluationError("Ответ модели обрезан по лимиту токенов.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    u = resp.usage
    inp = (u.input_tokens or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0) + \
          (getattr(u, "cache_creation_input_tokens", 0) or 0)
    price_in, price_out = PRICING.get(model, (0, 0))
    cost = (
        (u.input_tokens or 0) * price_in
        + (getattr(u, "cache_creation_input_tokens", 0) or 0) * price_in * 1.25
        + (getattr(u, "cache_read_input_tokens", 0) or 0) * price_in * 0.1
        + (u.output_tokens or 0) * price_out
    ) / 1_000_000
    usage = {"inputTokens": inp, "outputTokens": u.output_tokens or 0, "costUsd": round(cost, 5)}
    return text, usage, {"type": "cloud", "model": model}


def _call_local(settings, system, messages, schema):
    cfg = settings.get("local", {})
    url = (cfg.get("url") or "http://localhost:11434").rstrip("/")
    model = cfg.get("model") or "qwen2.5:14b"
    try:
        r = requests.post(f"{url}/api/chat", json={
            "model": model,
            "messages": [{"role": "system", "content": system}] + messages,
            "format": schema,
            "stream": False,
            "options": {"temperature": 0, "num_ctx": 16384},
        }, timeout=900)
    except requests.RequestException:
        raise EvaluationError(f"Локальная модель недоступна по адресу {url}.")
    if r.status_code != 200:
        raise EvaluationError(f"Локальная модель вернула ошибку {r.status_code}: {r.text[:200]}")
    body = r.json()
    usage = {"inputTokens": body.get("prompt_eval_count", 0), "outputTokens": body.get("eval_count", 0), "costUsd": 0}
    return body.get("message", {}).get("content", ""), usage, {"type": "local", "model": model}


def _call_replay(record, checklist):
    """Saved answers instead of a model: demo without a key, deterministic and free.

    Criteria that have no saved answer are left out of the JSON, so validation
    marks them needsReview — replay never invents a verdict.
    """
    from . import replay

    saved = replay.find_answers(record["conversation_id"], checklist)
    if saved is None:
        raise EvaluationError(
            f"Для диалога {record['conversation_id']} нет сохранённого ответа (replay). "
            "Оцените его облачной или локальной моделью, затем сохраните снимок: python manage.py snapshot.")
    usage = {"inputTokens": 0, "outputTokens": 0, "costUsd": 0}
    return json.dumps(saved, ensure_ascii=False), usage, {"type": "replay", "model": "replay"}


def check_engine(settings):
    """Quick readiness check for the settings screen. No model call is made."""
    engine = settings.get("engine")
    if engine == "local":
        url = (settings.get("local", {}).get("url") or "http://localhost:11434").rstrip("/")
        try:
            r = requests.get(f"{url}/api/tags", timeout=3)
            models = [m.get("name") for m in r.json().get("models", [])]
            want = settings.get("local", {}).get("model")
            if want and want not in models and f"{want}:latest" not in models:
                return {"ok": False, "message": f"Модель {want} не найдена в Ollama", "models": models}
            return {"ok": True, "message": "Ollama подключена", "models": models}
        except Exception:
            return {"ok": False, "message": f"Ollama не отвечает по адресу {url}", "models": []}
    if engine == "replay":
        from . import replay
        n = replay.count_saved()
        if not n:
            return {"ok": False, "message": "Нет сохранённых ответов: загрузите demo/sample или выполните python manage.py snapshot", "saved": 0}
        return {"ok": True, "message": f"Сохранённых ответов: {n}", "saved": n}
    import os
    has_key = bool(settings.get("cloud", {}).get("apiKey") or os.environ.get("ANTHROPIC_API_KEY"))
    return {"ok": has_key, "message": "Ключ API задан" if has_key else "Нужен ключ Claude API"}


# ---------- main entry ----------

def _format_problems(problems):
    return "\n".join(f"- {p['message']}" for p in problems)


def evaluate(record, checklist, settings, max_attempts=MAX_ATTEMPTS):
    """Evaluate one dialog. Returns (answers, usage, engine, meta).

    meta: attempts made, prompt hash and problems that stayed unresolved
    (those criteria carry needsReview=true inside `answers`).
    """
    system, user = build_prompt(record, checklist)
    schema = build_schema(checklist)
    engine_name = settings.get("engine") or "cloud"
    messages = [{"role": "user", "content": user}]
    usage_total = {"inputTokens": 0, "outputTokens": 0, "costUsd": 0}
    answers, problems, engine, text = None, [], None, ""
    attempts = 0

    for attempt in range(1, max_attempts + 1):
        attempts = attempt
        if engine_name == "replay":
            text, usage, engine = _call_replay(record, checklist)
        elif engine_name == "local":
            text, usage, engine = _call_local(settings, system, messages, schema)
        else:
            text, usage, engine = _call_cloud(settings, system, messages, schema)
        for k in usage_total:
            usage_total[k] += usage.get(k, 0) or 0
        try:
            raw = json.loads(text)
        except json.JSONDecodeError:
            raw = None
        if not isinstance(raw, dict):
            problems = [{"criterionId": None, "code": "not_json", "message": "Ответ не является JSON-объектом."}]
            if engine_name == "replay" or attempt == max_attempts:
                raise EvaluationError("Модель вернула ответ не в формате JSON.")
            messages += [{"role": "assistant", "content": text or "{}"},
                         {"role": "user", "content": FIX_NOTE.format(problems=_format_problems(problems))}]
            continue
        answers, problems = validate(raw, checklist, record)
        if not problems or engine_name == "replay":
            break
        if attempt < max_attempts:
            messages += [{"role": "assistant", "content": text},
                         {"role": "user", "content": FIX_NOTE.format(problems=_format_problems(problems))}]

    answers = _mark_unresolved(answers, problems)
    usage_total["costUsd"] = round(usage_total["costUsd"], 5)
    meta = {"attempts": attempts, "promptHash": prompt_hash(system),
            "unresolved": [p for p in problems if p.get("criterionId")]}
    return answers, usage_total, engine, meta

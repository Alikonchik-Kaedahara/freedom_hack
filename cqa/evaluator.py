"""LLM evaluation of one conversation against a checklist.

Two engines:
  cloud - Claude via the Anthropic SDK, structured JSON output
  local - Ollama (/api/chat with a JSON schema in `format`)

The model only returns verdicts, explanations and evidence message numbers.
Points, weight redistribution and totals are computed in the UI (web/js/scoring.js),
so appeals and checklist edits recalculate without another model call.
"""
import json
from datetime import datetime

import requests

from .defaults import PRICING

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
(проверенный участок разговора). Для N/A — реплики, показывающие, что условие неприменимости выполнено.
7. explanation — одно-два коротких предложения на русском: что сделал или не сделал оператор и где. \
Пример: «После ответа на вопрос оператор закрыл чат без прощания. Основание — последняя реплика оператора и сообщение о закрытии чата.»
8. Будь последовательным: одинаковые ситуации получают одинаковые оценки."""

CALL_NOTE = """Это телефонный звонок. Транскрипт получен автоматическим распознаванием речи: возможны ошибки распознавания \
и скрытые данные ([Имя скрыто], [Персональные данные скрыты]) — это не ошибки оператора. Оценивай устную речь: \
логичность, понятность объяснений, корректность формулировок, паузы и удержание."""


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
            },
            "required": ["evidence", "explanation", "verdict"],
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


# ---------- engines ----------

def _call_cloud(settings, system, user, schema):
    import anthropic  # imported lazily so the local engine works without it

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
            messages=[{"role": "user", "content": user}],
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


def _call_local(settings, system, user, schema):
    cfg = settings.get("local", {})
    url = (cfg.get("url") or "http://localhost:11434").rstrip("/")
    model = cfg.get("model") or "qwen2.5:14b"
    try:
        r = requests.post(f"{url}/api/chat", json={
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
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


def check_engine(settings):
    """Quick readiness check for the settings screen. No model call is made."""
    if settings.get("engine") == "local":
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
    import os
    has_key = bool(settings.get("cloud", {}).get("apiKey") or os.environ.get("ANTHROPIC_API_KEY"))
    return {"ok": has_key, "message": "Ключ API задан" if has_key else "Нужен ключ Claude API"}


# ---------- main entry ----------

def _normalize(raw, checklist, n_messages):
    answers = {}
    for c in checklist["criteria"]:
        item = raw.get(c["id"]) or {}
        verdict = str(item.get("verdict", "")).strip().lower()
        allowed = _verdicts(c)
        if verdict not in allowed:
            raise EvaluationError(f"Некорректный ответ модели по критерию {c.get('code') or c['id']}: {verdict!r}")
        if verdict == "na":
            answer = "na"
        elif c["type"] == "scale":
            answer = int(float(verdict))
        else:
            answer = verdict
        evidence = sorted({int(i) for i in item.get("evidence", []) if isinstance(i, (int, float)) and 0 <= int(i) < n_messages})
        answers[c["id"]] = {"answer": answer, "explanation": (item.get("explanation") or "").strip(), "evidence": evidence}
    return answers


def evaluate(record, checklist, settings):
    system, user = build_prompt(record, checklist)
    schema = build_schema(checklist)
    if settings.get("engine") == "local":
        text, usage, engine = _call_local(settings, system, user, schema)
    else:
        text, usage, engine = _call_cloud(settings, system, user, schema)
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        raise EvaluationError("Модель вернула ответ не в формате JSON.")
    answers = _normalize(raw, checklist, len(record["transcript"]))
    return answers, usage, engine

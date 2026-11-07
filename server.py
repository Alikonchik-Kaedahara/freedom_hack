"""CQA prototype server.

Serves the web UI from ./web and a small JSON API:
  datasets (import from the organizers' API or a transcript file), checklists,
  settings, evaluation jobs, appeals and call audio.

Run:  python server.py            ->  http://localhost:8000
      python server.py --demo     ->  restore demo/snapshot (or load demo/sample) and use the replay engine
Env:  CQA_DATA_API   GET link of the organizers' API (see .env.example; a .env file next to server.py is read)
      ANTHROPIC_API_KEY, PORT
"""
import html
import json
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests
from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory

from cqa import export, knowledge, operators, quality, replay, scoring, second, storage
from cqa.evaluator import EvaluationError, check_engine, evaluate, local_relay_enabled
from cqa.validation import ValidationError, validate_checklist, validate_group_id, validate_records

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
AUDIO_DIR = os.path.join(storage.ROOT, "audio")
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def load_dotenv(path=os.path.join(ROOT, ".env")):
    """Minimal .env reader: KEY=VALUE lines, existing environment wins."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass


load_dotenv()
DATA_API = os.environ.get("CQA_DATA_API", "").strip()

app = Flask(__name__, static_folder=None)
app.json.ensure_ascii = False
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def bad(message, code=400):
    return jsonify({"error": message}), code


def body_json():
    """JSON body or None when it is missing/malformed (the caller answers 400)."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


@app.errorhandler(404)
def not_found(_e):
    if request.path.startswith("/api/"):
        return bad("Не найдено", 404)
    return "Not found", 404


@app.errorhandler(413)
def too_large(_e):
    return bad(f"Файл больше {MAX_UPLOAD_BYTES // (1024 * 1024)} МБ", 413)


# ---------- static ----------

@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        abort(404)
    return send_from_directory(WEB, path)


@app.after_request
def no_stale_ui(resp):
    # The interface is plain ES modules: browsers would otherwise keep an old app.js for days after a deploy.
    if resp.mimetype in ("text/html", "text/css", "application/javascript", "text/javascript"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ---------- datasets ----------

@app.get("/api/datasets")
def datasets():
    return jsonify(storage.list_datasets())


@app.post("/api/datasets/import")
def import_dataset():
    body = body_json()
    if body is None:
        return bad("Ожидается JSON с полем groupId")
    try:
        group_id = validate_group_id(body.get("groupId"))
    except ValidationError as e:
        return bad(str(e))
    if group_id.upper() == replay.SAMPLE_GROUP:
        meta = replay.load_sample(group_id, now())
        if not meta:
            return bad("Файл demo/sample/dataset.json не найден", 404)
        storage.save_settings({"activeGroup": group_id})
        return jsonify(meta)
    if not DATA_API:
        return bad("Не задан адрес API организаторов: укажите CQA_DATA_API в .env (см. .env.example) "
                   "или загрузите транскрипты файлом", 412)
    try:
        r = requests.get(DATA_API, params={"group_id": group_id}, timeout=90)
        payload = r.json()
    except (requests.RequestException, ValueError):
        return bad("API организаторов не ответило. Попробуйте ещё раз.", 502)
    if not isinstance(payload, dict) or not payload.get("isSuccess"):
        err = payload.get("error") if isinstance(payload, dict) else None
        return bad(err or "API вернуло ошибку", 502)
    try:
        records = validate_records(payload)
    except ValidationError as e:
        return bad(f"API вернуло данные в неожиданном формате: {e}", 502)
    meta = storage.save_dataset(group_id, records, now())
    storage.save_settings({"activeGroup": group_id})
    return jsonify(meta)


@app.post("/api/datasets/upload")
def upload_dataset():
    """Transcripts from a file: the organizers' JSON, a list of records or one record."""
    group_id = request.form.get("groupId") or request.args.get("groupId")
    if "file" in request.files:
        f = request.files["file"]
        try:
            payload = json.loads(f.read().decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return bad("Файл должен быть в формате JSON (UTF-8)")
        if not group_id:
            group_id = os.path.splitext(os.path.basename(f.filename or ""))[0] or "UPLOAD"
    else:
        body = request.get_json(silent=True)
        if body is None:
            return bad("Ожидается файл JSON (поле file) или JSON-тело с диалогами")
        payload = body.get("records", body) if isinstance(body, dict) and "groupId" in body else body
        group_id = group_id or (body.get("groupId") if isinstance(body, dict) else None) or "UPLOAD"
    try:
        group_id = validate_group_id(group_id)
        records = validate_records(payload)
    except ValidationError as e:
        return bad(str(e))
    meta = storage.upsert_dataset(group_id, records, now())
    storage.save_settings({"activeGroup": group_id})
    return jsonify(meta)


@app.get("/api/datasets/<group_id>")
def dataset(group_id):
    return jsonify(storage.get_dataset(group_id))


# ---------- checklists ----------

@app.get("/api/checklists")
def checklists():
    return jsonify(storage.get_checklists())


@app.put("/api/checklists/<checklist_id>")
def save_checklist(checklist_id):
    item = body_json()
    if item is None:
        return bad("Ожидается JSON чек-листа")
    item["id"] = checklist_id
    item["updatedAt"] = now()
    try:
        item = validate_checklist(item)
    except ValidationError as e:
        return bad(str(e))
    return jsonify(storage.save_checklist(item))


@app.delete("/api/checklists/<checklist_id>")
def delete_checklist(checklist_id):
    active = storage.get_settings().get("active", {})
    if checklist_id in active.values():
        return bad("Нельзя удалить основной чек-лист")
    storage.delete_checklist(checklist_id)
    return jsonify({"ok": True})


# ---------- settings ----------

def public_settings(s):
    s = dict(s)
    cloud = dict(s.get("cloud", {}))
    cloud["hasKey"] = bool(cloud.get("apiKey") or os.environ.get("ANTHROPIC_API_KEY"))
    cloud["apiKey"] = ""
    s["cloud"] = cloud
    local = dict(s.get("local", {}))
    local["relay"] = local_relay_enabled()  # server-side relay in use; its URL and token are never returned
    s["local"] = local
    s["dataApi"] = bool(DATA_API)
    s["teamName"] = team_name(s)
    return s


def team_name(settings=None):
    settings = settings if settings is not None else storage.get_settings()
    return (settings.get("teamName") or os.environ.get("CQA_TEAM_NAME") or "").strip() or "freedom_hack"


@app.get("/api/settings")
def get_settings():
    return jsonify(public_settings(storage.get_settings()))


@app.put("/api/settings")
def put_settings():
    patch = body_json()
    if patch is None:
        return bad("Ожидается JSON с настройками")
    if "engine" in patch and patch["engine"] not in ("cloud", "local", "replay"):
        return bad("Движок должен быть cloud, local или replay")
    if "cloud" in patch and isinstance(patch["cloud"], dict) and not patch["cloud"].get("apiKey"):
        patch["cloud"].pop("apiKey", None)
    if isinstance(patch.get("local"), dict):
        patch["local"].pop("relay", None)  # computed from the environment, not stored
    return jsonify(public_settings(storage.save_settings(patch)))


@app.get("/api/engine/status")
def engine_status():
    return jsonify(check_engine(storage.get_settings()))


# ---------- results & appeals ----------

def _with_operators(results, group_id):
    """Add the operator's name to each result (from the first operator reply, or the supervisor's override)."""
    if not group_id:
        return results
    records = {r["conversation_id"]: r for r in storage.get_dataset(group_id)}
    for res in results.values():
        rec = records.get(res.get("conversationId"))
        if rec:
            res["operator"] = operators.operator_of(rec, res)
    return results


@app.get("/api/results")
def results():
    group_id = request.args.get("group")
    return jsonify(_with_operators(storage.get_results(group_id), group_id))


@app.get("/api/results/<path:key>")
def result(key):
    res = storage.get_result(key)
    return jsonify(res) if res else bad("Оценка не найдена", 404)


def _with_score(result):
    result["score"] = scoring.summarize(result)
    return result


def _person(value):
    """Name of whoever filed or decided an appeal: one line, at most 80 characters, or None."""
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())[:80]
    return name or None


@app.post("/api/results/<path:key>/appeals")
def create_appeal(key):
    body = body_json()
    if body is None:
        return bad("Ожидается JSON с полями criterionId и comment")
    crit, comment = body.get("criterionId"), (body.get("comment") or "").strip()
    if not crit or not comment:
        return bad("Выберите критерий и добавьте комментарий")

    def add(result):
        if not any(c["id"] == crit for c in result["checklist"]["criteria"]):
            raise ValueError("Такого критерия нет в чек-листе этой оценки")
        if any(a["criterionId"] == crit and a["status"] == "pending" for a in result.get("appeals", [])):
            raise ValueError("По этому критерию уже есть апелляция на рассмотрении")
        result.setdefault("appeals", []).append({
            "id": uuid.uuid4().hex[:8], "criterionId": crit, "comment": comment,
            "status": "pending", "createdAt": now(), "author": _person(body.get("author")),
        })
        return _with_score(result)

    try:
        res = storage.update_result(key, add)
    except ValueError as e:
        return bad(str(e))
    return jsonify(res) if res else bad("Оценка не найдена", 404)


def _allowed_answers(c):
    if c["type"] == "scale":
        vals = [int(s["value"]) if float(s["value"]) == int(s["value"]) else float(s["value"]) for s in c.get("scale", [])]
    else:
        vals = ["yes", "no"]
    if c.get("naAllowed") and c["type"] != "flag":
        vals.append("na")
    return vals


@app.post("/api/results/<path:key>/appeals/<appeal_id>/decision")
def decide_appeal(key, appeal_id):
    body = body_json()
    if body is None:
        return bad("Ожидается JSON с полями status и reason")
    status, reason = body.get("status"), (body.get("reason") or "").strip()
    if status not in ("accepted", "rejected"):
        return bad("Неизвестное решение")
    if not reason:
        return bad("Укажите причину решения")

    def decide(result):
        appeal = next((a for a in result.get("appeals", []) if a["id"] == appeal_id), None)
        if not appeal:
            raise ValueError("Апелляция не найдена")
        if appeal["status"] != "pending":
            raise ValueError("Апелляция уже рассмотрена")
        answer = None
        if status == "accepted":
            c = next((c for c in result["checklist"]["criteria"] if c["id"] == appeal["criterionId"]), None)
            answer = body.get("answer")
            if isinstance(answer, str) and answer.strip().lstrip("-").replace(".", "", 1).isdigit():
                answer = float(answer) if "." in answer else int(answer)
            if c and answer not in _allowed_answers(c):
                raise ValueError("Недопустимое значение оценки для этого критерия")
        appeal["status"] = status
        appeal["decision"] = {"reason": reason, "decidedAt": now(), "answer": answer, "by": _person(body.get("by"))}
        return _with_score(result)

    try:
        res = storage.update_result(key, decide)
    except ValueError as e:
        return bad(str(e))
    return jsonify(res) if res else bad("Оценка не найдена", 404)


# ---------- evaluation jobs ----------

JOBS = {}
_jobs_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=4)


def _checklist_for(record, settings, override_id):
    if override_id:
        return storage.get_checklist(override_id)
    cid = settings.get("active", {}).get(record.get("channel"))
    return storage.get_checklist(cid) if cid else None


def _run_one(job_id, group_id, cid, override_id):
    job = JOBS[job_id]
    settings = storage.get_settings()
    record = storage.get_record(group_id, cid)
    with _jobs_lock:
        job["current"].append(cid)
    try:
        if not record:
            raise EvaluationError("Диалог не найден")
        checklist = _checklist_for(record, settings, override_id)
        if not checklist:
            raise EvaluationError("Нет чек-листа для этого канала")
        started = time.time()
        answers, usage, engine, meta = evaluate(record, checklist, settings)
        result = {
            "key": storage.result_key(group_id, cid), "groupId": group_id, "conversationId": cid,
            "language": record.get("language"), "channel": record.get("channel"),
            "checklist": checklist, "answers": answers, "appeals": [],
            "engine": engine, "usage": usage, "durationMs": int((time.time() - started) * 1000),
            "attempts": meta["attempts"], "promptHash": meta["promptHash"], "unresolved": meta["unresolved"],
            "createdAt": now(),
        }
        storage.put_result(_with_score(result))
        storage.clear_failure(result["key"])
        with _jobs_lock:
            job["done"] += 1
            if meta["unresolved"]:
                job["needsReview"] += 1
    except EvaluationError as e:
        storage.put_failure(storage.result_key(group_id, cid), group_id, cid, str(e), now())
        with _jobs_lock:
            job["failed"] += 1
            job["errors"].append({"conversationId": cid, "message": str(e)})
    except Exception as e:  # keep the batch going
        storage.put_failure(storage.result_key(group_id, cid), group_id, cid, f"Ошибка: {e}", now())
        with _jobs_lock:
            job["failed"] += 1
            job["errors"].append({"conversationId": cid, "message": f"Ошибка: {e}"})
    finally:
        with _jobs_lock:
            job["current"].remove(cid)
            if job["done"] + job["failed"] >= job["total"]:
                job["status"] = "finished"
                job["finishedAt"] = now()


@app.post("/api/evaluate")
def start_evaluation():
    body = body_json()
    if body is None:
        return bad("Ожидается JSON с полями groupId и conversationIds")
    group_id = body.get("groupId")
    ids = body.get("conversationIds")
    if not group_id or not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
        return bad("Нет диалогов для оценки")
    records = storage.get_dataset(group_id)
    if not records:
        return bad(f"Набор «{group_id}» не загружен", 404)
    known = {r["conversation_id"] for r in records}
    unknown = [i for i in ids if i not in known]
    if unknown:
        return bad(f"Диалоги не найдены в наборе: {', '.join(unknown[:5])}" + (" …" if len(unknown) > 5 else ""))
    override = body.get("checklistId")
    if override and not storage.get_checklist(override):
        return bad("Чек-лист не найден", 404)
    settings = storage.get_settings()
    status = check_engine(settings)
    if not status["ok"]:
        return bad(status["message"], 412)
    ids = list(dict.fromkeys(ids))
    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {"id": job_id, "total": len(ids), "done": 0, "failed": 0, "needsReview": 0, "errors": [],
                    "current": [], "status": "running", "startedAt": now(), "groupId": group_id, "ids": ids}
    workers = 1 if settings.get("engine") == "local" else 4
    sem = threading.Semaphore(workers)

    def run(cid):
        with sem:
            _run_one(job_id, group_id, cid, override)

    for cid in ids:
        _pool.submit(run, cid)
    return jsonify(JOBS[job_id])


def _engine_settings(settings, engine_override):
    """Settings for a second pass: same engine by default, or the one asked for (cloud / local)."""
    if not engine_override:
        return settings
    s = dict(settings)
    s["engine"] = engine_override
    return s


def _run_second(job_id, group_id, cid, engine_override):
    """Second opinion: evaluate again, store next to the original, flag disagreements."""
    job = JOBS[job_id]
    settings = _engine_settings(storage.get_settings(), engine_override)
    record = storage.get_record(group_id, cid)
    key = storage.result_key(group_id, cid)
    with _jobs_lock:
        job["current"].append(cid)
    try:
        if not record:
            raise EvaluationError("Диалог не найден")
        current = storage.get_result(key)
        if not current:
            raise EvaluationError("Сначала нужна первая оценка")
        answers, usage, engine, meta = evaluate(record, current["checklist"], settings)

        def attach(result):
            second.attach(result, answers, usage, engine, meta, now())
            return _with_score(result)

        updated = storage.update_result(key, attach)
        cmp = updated["secondOpinion"]["comparison"]
        with _jobs_lock:
            job["done"] += 1
            if cmp["disagree"] or cmp["near"]:
                job["needsReview"] += 1
    except EvaluationError as e:
        with _jobs_lock:
            job["failed"] += 1
            job["errors"].append({"conversationId": cid, "message": str(e)})
    except Exception as e:  # keep the batch going
        with _jobs_lock:
            job["failed"] += 1
            job["errors"].append({"conversationId": cid, "message": f"Ошибка: {e}"})
    finally:
        with _jobs_lock:
            job["current"].remove(cid)
            if job["done"] + job["failed"] >= job["total"]:
                job["status"] = "finished"
                job["finishedAt"] = now()


@app.post("/api/second-opinion")
def start_second_opinion():
    """Run a second evaluation for already-evaluated dialogs. Body: {groupId, conversationIds, engine?}."""
    body = body_json()
    if body is None:
        return bad("Ожидается JSON с полями groupId и conversationIds")
    group_id = body.get("groupId")
    ids = body.get("conversationIds")
    if not group_id or not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
        return bad("Нет диалогов для второго мнения")
    engine_override = body.get("engine")
    if engine_override not in (None, "", "cloud", "local"):
        return bad("Движок второго мнения: cloud или local")
    engine_override = engine_override or None
    results = storage.get_results(group_id)
    missing = [i for i in ids if storage.result_key(group_id, i) not in results]
    if missing:
        return bad(f"Сначала оцените диалоги: {', '.join(missing[:5])}" + (" …" if len(missing) > 5 else ""))
    settings = _engine_settings(storage.get_settings(), engine_override)
    if settings.get("engine") == "replay":
        return bad("Для второго мнения нужна реальная модель (cloud или local), replay только воспроизводит сохранённый ответ", 412)
    status = check_engine(settings)
    if not status["ok"]:
        return bad(status["message"], 412)
    ids = list(dict.fromkeys(ids))
    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {"id": job_id, "kind": "second", "engine": settings.get("engine"), "total": len(ids), "done": 0, "failed": 0,
                    "needsReview": 0, "errors": [], "current": [], "status": "running", "startedAt": now(),
                    "groupId": group_id, "ids": ids}
    workers = 1 if settings.get("engine") == "local" else 4
    sem = threading.Semaphore(workers)

    def run(cid):
        with sem:
            _run_second(job_id, group_id, cid, engine_override)

    for cid in ids:
        _pool.submit(run, cid)
    return jsonify(JOBS[job_id])


@app.get("/api/jobs/<job_id>")
def job(job_id):
    j = JOBS.get(job_id)
    return jsonify(j) if j else bad("Задача не найдена", 404)


@app.get("/api/jobs")
def jobs():
    return jsonify([j for j in JOBS.values() if j["status"] == "running"])


# ---------- quality of the evaluation (calibration, reproducibility, appeals, patterns) ----------

@app.get("/api/quality")
def quality_overview():
    group_id = request.args.get("group")
    if not group_id:
        return bad("Укажите набор: ?group=DEV")
    return jsonify(quality.overview(group_id))


@app.post("/api/quality/calibration")
def upload_calibration():
    """The team's manual markup: Калибровка_CQA.xlsx (sheet «Разметка») or JSON {entries: [...]}."""
    try:
        if "file" in request.files:
            f = request.files["file"]
            data = f.read()
            name = (f.filename or "").lower()
            entries = quality.parse_xlsx(data) if name.endswith(".xlsx") else quality.parse_json(data)
            source = f.filename or "upload"
        else:
            body = body_json()
            if body is None or not isinstance(body.get("entries"), list):
                return bad("Ожидается файл .xlsx/.json или JSON с полем entries")
            entries, source = body["entries"], "api"
    except (ValueError, KeyError) as e:
        return bad(f"Не удалось прочитать разметку: {e}")
    except Exception as e:  # malformed workbook
        return bad(f"Не удалось прочитать файл: {e}")
    doc = quality.save_calibration(entries, now(), source)
    return jsonify({"entries": len(doc["entries"]), "updatedAt": doc["updatedAt"], "source": doc["source"]})


@app.delete("/api/quality/calibration")
def clear_calibration():
    quality.save_calibration([], now(), "")
    return jsonify({"ok": True})


# ---------- operators ----------

@app.get("/api/operators")
def operators_list():
    group_id = request.args.get("group")
    if not group_id:
        return bad("Укажите набор: ?group=DEV")
    return jsonify(operators.profiles(storage.get_dataset(group_id), storage.get_results(group_id)))


@app.put("/api/results/<path:key>/operator")
def set_operator(key):
    """Supervisor override of the operator name for one dialog (empty = back to automatic)."""
    body = body_json()
    if body is None:
        return bad("Ожидается JSON с полем name")
    name = str(body.get("name") or "").strip()[:60]

    def patch(result):
        if name:
            result["operatorName"] = name
        else:
            result.pop("operatorName", None)
        return result

    res = storage.update_result(key, patch)
    return jsonify(res) if res else bad("Оценка не найдена", 404)


# ---------- knowledge base ----------

@app.get("/api/knowledge")
def knowledge_get():
    kb = knowledge.get()
    group_id = request.args.get("group")
    hits = knowledge.usage(storage.get_results(group_id), kb) if group_id else {}
    return jsonify({**kb, "usage": hits, "edited": bool(storage._read("knowledge", None))})


@app.put("/api/knowledge")
def knowledge_put():
    body = body_json()
    if body is None:
        return bad("Ожидается JSON справочника")
    try:
        return jsonify(knowledge.save(body))
    except ValueError as e:
        return bad(str(e))


@app.post("/api/knowledge/reset")
def knowledge_reset():
    return jsonify(knowledge.reset())


# ---------- printable report ----------

@app.get("/report/<group_id>/<path:conversation_id>")
def report(group_id, conversation_id):
    """Self-contained HTML of one evaluated dialog for printing / Save as PDF."""
    from cqa import report as report_mod

    record = storage.get_record(group_id, conversation_id)
    result = storage.get_result(storage.result_key(group_id, conversation_id))
    if not record or not result:
        abort(404)
    html_text = report_mod.render(record, result, team_name(), operators.operator_of(record, result))
    return Response(html_text, mimetype="text/html; charset=utf-8")


# ---------- export in the organizers' format ----------

@app.get("/api/export/<dataset>")
def export_results(dataset):
    """Write results/<dataset>/results.json for a group and return the report (dataset: dev | prod)."""
    group_id = request.args.get("group")
    if not group_id:
        return bad("Укажите набор: ?group=DEV")
    allow_replay = request.args.get("allowReplay") in ("1", "true")
    try:
        doc, report = export.write(group_id, dataset, team_name(), allow_replay)
    except export.ExportError as e:
        return bad(str(e))
    report["problems"] = export.check(doc)
    return jsonify(report)


@app.get("/api/export/<dataset>/download")
def download_results(dataset):
    if dataset not in ("dev", "prod"):
        abort(404)
    path = os.path.join(export.RESULTS_DIR, dataset, "results.json")
    if not os.path.exists(path):
        return bad("Файл ещё не выгружен", 404)
    return send_file(path, mimetype="application/json", as_attachment=True, download_name=f"results-{dataset}.json")


@app.get("/api/failures")
def failures():
    return jsonify(storage.get_failures(request.args.get("group")))


# ---------- audio ----------

_audio_lock = threading.Lock()


@app.get("/api/audio/<group_id>/<conversation_id>")
def audio(group_id, conversation_id):
    record = storage.get_record(group_id, conversation_id)
    if not record or not record.get("audio_url"):
        abort(404)
    os.makedirs(AUDIO_DIR, exist_ok=True)
    path = os.path.join(AUDIO_DIR, f"{storage._safe(group_id)}_{storage._safe(conversation_id)}.mp3")
    with _audio_lock:
        if not os.path.exists(path):
            try:
                page = requests.get(record["audio_url"], timeout=60)
                src = page.url
                if "audio" not in page.headers.get("content-type", ""):
                    m = re.search(r'<source[^>]+src="([^"]+)"', page.text)
                    if not m:
                        abort(502)
                    src = html.unescape(m.group(1))
                    page = requests.get(src, timeout=180)
                page.raise_for_status()
                with open(path + ".tmp", "wb") as f:
                    f.write(page.content)
                os.replace(path + ".tmp", path)
            except requests.RequestException:
                abort(502)
    return send_file(path, mimetype="audio/mpeg", conditional=True)


# ---------- demo mode ----------

def prepare_demo():
    """Demo without a key: restore the snapshot, load the sample if nothing is loaded, switch to replay."""
    restored = replay.restore_snapshot()
    if not storage.list_datasets():
        replay.load_sample(imported_at=now())
    if not (storage.get_settings().get("cloud", {}).get("apiKey") or os.environ.get("ANTHROPIC_API_KEY")):
        storage.save_settings({"engine": "replay"})
    return restored


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    # Local run. In hosting the app is served by gunicorn (see Procfile).
    if "--demo" in sys.argv:
        restored = prepare_demo()
        print("CQA demo: " + (f"снимок восстановлен ({', '.join(restored)})" if restored else "снимка нет, загружен demo/sample"))
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"CQA: http://localhost:{port}")
    app.run(host=host, port=port, threaded=True, debug=False)

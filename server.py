"""CQA prototype server.

Serves the web UI from ./web and a small JSON API:
  datasets (import from the organizers' API), checklists, settings,
  evaluation jobs, appeals and call audio.

Run:  python server.py   ->  http://localhost:8000
"""
import html
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from cqa import storage
from cqa.evaluator import EvaluationError, check_engine, evaluate

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
AUDIO_DIR = os.path.join(storage.ROOT, "audio")

DATA_API = os.environ.get(
    "CQA_DATA_API",
    "https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com:443/powerautomate/automations/"
    "direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke"
    "?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=5Sog2MThgCRTlk3HObv70LRmRk6u7IOwzlwMpe804qo",
)

app = Flask(__name__, static_folder=None)
app.json.ensure_ascii = False


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def bad(message, code=400):
    return jsonify({"error": message}), code


# ---------- static ----------

@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        abort(404)
    return send_from_directory(WEB, path)


# ---------- datasets ----------

@app.get("/api/datasets")
def datasets():
    return jsonify(storage.list_datasets())


@app.post("/api/datasets/import")
def import_dataset():
    group_id = (request.json or {}).get("groupId", "").strip()
    if not group_id:
        return bad("Укажите group_id")
    try:
        r = requests.get(DATA_API, params={"group_id": group_id}, timeout=90)
        body = r.json()
    except (requests.RequestException, ValueError):
        return bad("API организаторов не ответило. Попробуйте ещё раз.", 502)
    if not body.get("isSuccess"):
        return bad(body.get("error") or "API вернуло ошибку", 502)
    records = (body.get("data") or {}).get("records") or []
    if not records:
        return bad(f"Для group_id «{group_id}» диалоги не найдены", 404)
    meta = storage.save_dataset(group_id, records, now())
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
    item = request.json or {}
    item["id"] = checklist_id
    item["updatedAt"] = now()
    if not item.get("criteria"):
        return bad("В чек-листе нет критериев")
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
    return s


@app.get("/api/settings")
def get_settings():
    return jsonify(public_settings(storage.get_settings()))


@app.put("/api/settings")
def put_settings():
    patch = request.json or {}
    if "cloud" in patch and not patch["cloud"].get("apiKey"):
        patch["cloud"].pop("apiKey", None)
    return jsonify(public_settings(storage.save_settings(patch)))


@app.get("/api/engine/status")
def engine_status():
    return jsonify(check_engine(storage.get_settings()))


# ---------- results & appeals ----------

@app.get("/api/results")
def results():
    group_id = request.args.get("group")
    return jsonify(storage.get_results(group_id))


@app.post("/api/results/<path:key>/appeals")
def create_appeal(key):
    body = request.json or {}
    crit, comment = body.get("criterionId"), (body.get("comment") or "").strip()
    if not crit or not comment:
        return bad("Выберите критерий и добавьте комментарий")

    def add(result):
        if any(a["criterionId"] == crit and a["status"] == "pending" for a in result.get("appeals", [])):
            raise ValueError("По этому критерию уже есть апелляция на рассмотрении")
        result.setdefault("appeals", []).append({
            "id": uuid.uuid4().hex[:8], "criterionId": crit, "comment": comment,
            "status": "pending", "createdAt": now(),
        })
        return result

    try:
        res = storage.update_result(key, add)
    except ValueError as e:
        return bad(str(e))
    return jsonify(res) if res else bad("Оценка не найдена", 404)


@app.post("/api/results/<path:key>/appeals/<appeal_id>/decision")
def decide_appeal(key, appeal_id):
    body = request.json or {}
    status, reason = body.get("status"), (body.get("reason") or "").strip()
    if status not in ("accepted", "rejected"):
        return bad("Неизвестное решение")
    if not reason:
        return bad("Укажите причину решения")

    def decide(result):
        for a in result.get("appeals", []):
            if a["id"] == appeal_id:
                a["status"] = status
                a["decision"] = {"reason": reason, "decidedAt": now(),
                                 "answer": body.get("answer") if status == "accepted" else None}
        return result

    res = storage.update_result(key, decide)
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
        answers, usage, engine = evaluate(record, checklist, settings)
        storage.put_result({
            "key": storage.result_key(group_id, cid), "groupId": group_id, "conversationId": cid,
            "checklist": checklist, "answers": answers, "appeals": [],
            "engine": engine, "usage": usage, "durationMs": int((time.time() - started) * 1000),
            "createdAt": now(),
        })
        with _jobs_lock:
            job["done"] += 1
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


@app.post("/api/evaluate")
def start_evaluation():
    body = request.json or {}
    group_id = body.get("groupId")
    ids = body.get("conversationIds") or []
    if not group_id or not ids:
        return bad("Нет диалогов для оценки")
    settings = storage.get_settings()
    status = check_engine(settings)
    if not status["ok"]:
        return bad(status["message"], 412)
    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {"id": job_id, "total": len(ids), "done": 0, "failed": 0, "errors": [], "current": [],
                    "status": "running", "startedAt": now(), "groupId": group_id, "ids": ids}
    workers = 1 if settings.get("engine") == "local" else 4
    sem = threading.Semaphore(workers)

    def run(cid):
        with sem:
            _run_one(job_id, group_id, cid, body.get("checklistId"))

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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"CQA: http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)

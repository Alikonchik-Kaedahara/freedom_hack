"""Replay: evaluation answers saved earlier, so the demo runs without a model or a key.

Sources, in order of priority:
  1. storage/results.json      - the latest evaluation of the same dialog with the same checklist id
  2. demo/snapshot/results.json - a snapshot of storage made with `python manage.py snapshot`
  3. demo/sample/answers.json   - curated answers for the synthetic sample dialogs

Answers are matched by conversation_id and checklist id (the version is ignored, so a
re-saved checklist with the same criteria still replays). Criteria without a saved
answer are simply absent from the replayed JSON: validation then marks them
needsReview instead of inventing a verdict.
"""
import json
import os
import shutil

from . import storage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_DIR = os.path.join(ROOT, "demo")
SNAPSHOT_DIR = os.path.join(DEMO_DIR, "snapshot")
SAMPLE_DIR = os.path.join(DEMO_DIR, "sample")
SAMPLE_GROUP = "SAMPLE"


def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _to_raw(answers):
    """Stored normalized answers -> the raw shape the model returns (verdict/evidence/explanation/confidence)."""
    raw = {}
    for cid, a in (answers or {}).items():
        ans = a.get("answer")
        if ans is None:
            continue
        verdict = "na" if ans == "na" else str(ans)
        raw[cid] = {
            "verdict": verdict,
            "evidence": list(a.get("evidence") or []),
            "explanation": a.get("explanation") or "",
            "confidence": a.get("confidence") or "medium",
        }
    return raw


def _from_results(results, conversation_id, checklist_id):
    best = None
    for r in (results or {}).values():
        if r.get("conversationId") != conversation_id:
            continue
        if (r.get("checklist") or {}).get("id") != checklist_id:
            continue
        if (r.get("engine") or {}).get("type") == "replay":
            continue  # never replay a replay: keep the original model as the source
        if best is None or (r.get("createdAt") or "") > (best.get("createdAt") or ""):
            best = r
    if not best:
        return None, None
    return _to_raw(best.get("answers")), (best.get("engine") or {})


def find_answers(conversation_id, checklist):
    """Return (raw answers, source engine) or (None, None). Source is the engine that produced
    the saved result ({"type": "cloud", "model": ...}); sample answers have source {"type": "sample"}."""
    checklist_id = checklist.get("id")
    found, source = _from_results(storage.get_results(), conversation_id, checklist_id)
    if found is None:
        found, source = _from_results(_read_json(os.path.join(SNAPSHOT_DIR, "results.json"), {}), conversation_id, checklist_id)
    if found is None:
        sample = _read_json(os.path.join(SAMPLE_DIR, "answers.json"), {})
        by_checklist = sample.get(conversation_id) or {}
        if checklist_id in by_checklist:
            found, source = dict(by_checklist[checklist_id]), {"type": "sample", "model": "demo/sample/answers.json"}
    if found is None:
        return None, None
    known = {c["id"] for c in checklist.get("criteria", [])}
    return {k: v for k, v in found.items() if k in known}, source


def count_saved():
    n = len(storage.get_results())
    n += len(_read_json(os.path.join(SNAPSHOT_DIR, "results.json"), {}))
    n += sum(len(v) for v in _read_json(os.path.join(SAMPLE_DIR, "answers.json"), {}).values())
    return n


# ---------- snapshot / restore / sample ----------

SNAPSHOT_FILES = ("datasets.json", "results.json", "checklists.json", "checklist_versions.json")


def export_snapshot():
    """Copy datasets, results and checklists from storage/ into demo/snapshot/ (API keys are never copied)."""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    copied = []
    for name in os.listdir(storage.ROOT):
        if name in SNAPSHOT_FILES or (name.startswith("dataset_") and name.endswith(".json")):
            shutil.copy2(os.path.join(storage.ROOT, name), os.path.join(SNAPSHOT_DIR, name))
            copied.append(name)
    settings = storage.get_settings()
    settings.get("cloud", {}).pop("apiKey", None)
    with open(os.path.join(SNAPSHOT_DIR, "settings.json"), "w", encoding="utf-8") as f:
        json.dump({"active": settings.get("active"), "activeGroup": settings.get("activeGroup")}, f, ensure_ascii=False, indent=1)
    return copied


def restore_snapshot(force=False):
    """Copy demo/snapshot/ into storage/. Without force, existing storage files are kept."""
    if not os.path.isdir(SNAPSHOT_DIR):
        return []
    os.makedirs(storage.ROOT, exist_ok=True)
    restored = []
    for name in os.listdir(SNAPSHOT_DIR):
        if not name.endswith(".json") or name == "settings.json":
            continue
        dst = os.path.join(storage.ROOT, name)
        if os.path.exists(dst) and not force:
            continue
        shutil.copy2(os.path.join(SNAPSHOT_DIR, name), dst)
        restored.append(name)
    snap_settings = _read_json(os.path.join(SNAPSHOT_DIR, "settings.json"), {})
    patch = {k: v for k, v in snap_settings.items() if v}
    if patch:
        storage.save_settings(patch)
    return restored


def load_sample(group_id=SAMPLE_GROUP, imported_at=None):
    """Import demo/sample/dataset.json as a dataset group (synthetic dialogs for the demo and tests)."""
    from datetime import datetime, timezone

    records = _read_json(os.path.join(SAMPLE_DIR, "dataset.json"), [])
    if not records:
        return None
    stamp = imported_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta = storage.save_dataset(group_id, records, stamp)
    if not storage.get_settings().get("activeGroup"):
        storage.save_settings({"activeGroup": group_id})
    return meta

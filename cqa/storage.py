"""Small JSON-file storage. One file per collection, writes are atomic."""
import copy
import json
import os
import threading
import uuid

from .defaults import DEFAULT_CHECKLISTS, DEFAULT_SETTINGS, INTERPRETATIONS

ROOT = os.environ.get("CQA_STORAGE_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "storage")
_lock = threading.RLock()


def _path(name):
    return os.path.join(ROOT, name + ".json")


def _read(name, default):
    with _lock:
        try:
            with open(_path(name), encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return copy.deepcopy(default)


def _write(name, data):
    with _lock:
        os.makedirs(ROOT, exist_ok=True)
        tmp = _path(name) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, _path(name))


def update_calibration(change):
    """Merge uploads while holding the same lock as the atomic file replacement."""
    with _lock:
        doc = _read("calibration", {})
        result = change(doc)
        _write("calibration", doc)
        return result


# ---------- datasets ----------

def list_datasets():
    meta = _read("datasets", {})
    return sorted(meta.values(), key=lambda d: d.get("importedAt", ""))


def save_dataset(group_id, records, imported_at):
    with _lock:
        _write("dataset_" + _safe(group_id), records)
        meta = _read("datasets", {})
        meta[group_id] = {
            "groupId": group_id, "total": len(records), "importedAt": imported_at,
            "chats": sum(1 for r in records if r.get("channel") != "voice call"),
            "calls": sum(1 for r in records if r.get("channel") == "voice call"),
            "languages": _count(records, "language"),
        }
        _write("datasets", meta)
        return meta[group_id]


def upsert_dataset(group_id, records, imported_at):
    """Add records to a group (uploaded files): same conversation_id replaces, new ones are appended."""
    with _lock:
        existing = get_dataset(group_id)
        by_id = {r["conversation_id"]: r for r in existing}
        for r in records:
            by_id[r["conversation_id"]] = r
        merged = [by_id[r["conversation_id"]] for r in existing] + [r for r in records if r["conversation_id"] not in {e["conversation_id"] for e in existing}]
        meta = save_dataset(group_id, merged, imported_at)
        meta["added"] = len(records)
        return meta


def get_dataset(group_id):
    return _read("dataset_" + _safe(group_id), [])


def get_record(group_id, conversation_id):
    for r in get_dataset(group_id):
        if r["conversation_id"] == conversation_id:
            return r
    return None


# ---------- checklists ----------

def get_checklists():
    checklists = _read("checklists", DEFAULT_CHECKLISTS)
    # Checklists saved before the field existed get the team's readings of the built-in rules
    # (only where the key is absent: a field the user cleared on purpose stays empty).
    for cl in checklists:
        for c in cl.get("criteria") or []:
            if "interpretation" not in c:
                c["interpretation"] = INTERPRETATIONS.get(c["id"], "") if cl.get("id") in ("chat-base", "call-base") else ""
    return checklists


def get_checklist(checklist_id):
    for c in get_checklists():
        if c["id"] == checklist_id:
            return c
    return None


def save_checklist(item):
    with _lock:
        items = get_checklists()
        versions = _read("checklist_versions", {})
        existing = next((c for c in items if c["id"] == item["id"]), None)
        if existing:
            versions.setdefault(item["id"], []).append(existing)
            item["version"] = int(existing.get("version", 1)) + 1
            items = [item if c["id"] == item["id"] else c for c in items]
        else:
            item["version"] = 1
            items.append(item)
        _write("checklists", items)
        _write("checklist_versions", versions)
        return item


def delete_checklist(checklist_id):
    with _lock:
        _write("checklists", [c for c in get_checklists() if c["id"] != checklist_id])


# ---------- settings ----------

def get_settings():
    s = copy.deepcopy(DEFAULT_SETTINGS)
    stored = _read("settings", {})
    for k, v in stored.items():
        if isinstance(v, dict) and isinstance(s.get(k), dict):
            s[k].update(v)
        else:
            s[k] = v
    return s


def save_settings(patch):
    with _lock:
        s = get_settings()
        for k, v in patch.items():
            if isinstance(v, dict) and isinstance(s.get(k), dict):
                s[k].update(v)
            else:
                s[k] = v
        _write("settings", s)
        return s


# ---------- results ----------

def result_key(group_id, conversation_id):
    return f"{group_id}:{conversation_id}"


def get_results(group_id=None):
    data = _read("results", {})
    if group_id is None:
        return data
    return {k: v for k, v in data.items() if v.get("groupId") == group_id}


def get_result(key):
    return _read("results", {}).get(key)


def put_result(result):
    """Store a new evaluation. The previous one moves into history."""
    with _lock:
        data = _read("results", {})
        prev = data.get(result["key"])
        history = []
        if prev:
            history = prev.pop("history", [])
            result["reviewLog"] = prev.pop("reviewLog", [])
            history.append(prev)
        result["reviewVersion"] = uuid.uuid4().hex
        result["history"] = history[-5:]
        data[result["key"]] = result
        _write("results", data)
        return result


def update_result(key, fn):
    with _lock:
        data = _read("results", {})
        if key not in data:
            return None
        data[key] = fn(data[key])
        _write("results", data)
        return data[key]


# ---------- failed evaluations ----------
# Kept separately from results so the export can report status="error" with the reason
# (the organizers' format requires every dialog of a set, failures included).

def put_failure(key, group_id, conversation_id, message, at):
    with _lock:
        data = _read("failures", {})
        data[key] = {"key": key, "groupId": group_id, "conversationId": conversation_id, "error": message, "at": at}
        _write("failures", data)


def clear_failure(key):
    with _lock:
        data = _read("failures", {})
        if key in data:
            del data[key]
            _write("failures", data)


def get_failures(group_id=None):
    data = _read("failures", {})
    if group_id is None:
        return data
    return {k: v for k, v in data.items() if v.get("groupId") == group_id}


# ---------- helpers ----------

def _safe(s):
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in s)


def _count(records, field):
    out = {}
    for r in records:
        out[r.get(field)] = out.get(r.get(field), 0) + 1
    return out

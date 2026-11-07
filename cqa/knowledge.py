"""Knowledge base: reference facts the model checks the operator's advice against.

The organizers have a knowledge base and answer scripts; we do not. What we have is the
DEV set, where the same facts recur across RU / KZ / EN chats (paths in the app, the
1042-S form, D-account rules). demo/knowledge.json holds 17 such facts, each with the
dialogs it was taken from. A supervisor edits the list in the UI (stored in storage/);
the model receives the facts with the consultation criterion and, when an operator's
statement contradicts one, returns `contradicts: ["kb-07"]` for that criterion. The card
shows the fact next to the verdict. The verdict itself still comes from the rule and
the scale — the knowledge base explains, it does not score.

In production this file is replaced by the company's own base and scripts.
"""
import json
import os

from . import storage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(ROOT, "demo", "knowledge.json")


def _default():
    try:
        with open(DEFAULT_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"title": "Справочник фактов", "note": "", "facts": []}


def get():
    """Current knowledge base: the edited copy from storage, or the bundled default."""
    stored = storage._read("knowledge", None)
    if stored and isinstance(stored.get("facts"), list):
        return stored
    return _default()


def save(data):
    """Validate and store an edited knowledge base. Returns the stored document."""
    if not isinstance(data, dict) or not isinstance(data.get("facts"), list):
        raise ValueError("Ожидается объект с полем facts")
    facts, seen = [], set()
    for i, f in enumerate(data["facts"], 1):
        if not isinstance(f, dict):
            raise ValueError(f"Факт №{i}: неверный формат")
        text = str(f.get("fact") or "").strip()
        if not text:
            continue
        fid = str(f.get("id") or "").strip() or f"kb-{i:02d}"
        if fid in seen:
            raise ValueError(f"Идентификатор факта «{fid}» повторяется")
        seen.add(fid)
        facts.append({"id": fid, "topic": str(f.get("topic") or "").strip(), "fact": text,
                      "source": str(f.get("source") or "").strip()})
    doc = {"title": str(data.get("title") or "Справочник фактов").strip(), "note": str(data.get("note") or "").strip(),
           "facts": facts}
    storage._write("knowledge", doc)
    return doc


def reset():
    """Drop the edited copy and go back to the bundled default."""
    path = os.path.join(storage.ROOT, "knowledge.json")
    if os.path.exists(path):
        os.remove(path)
    return _default()


def render_for_prompt(kb=None):
    """Facts as a block for the system prompt, or '' when the base is empty."""
    kb = kb or get()
    facts = kb.get("facts") or []
    if not facts:
        return ""
    lines = ["СПРАВОЧНИК ФАКТОВ (эталон для критерия корректности консультации)",
             "Если утверждение оператора противоречит факту из справочника, укажи идентификаторы этих фактов в поле "
             "contradicts у критерия консультации и опиши противоречие в explanation. Если противоречий нет — пустой список. "
             "Справочник не заменяет правило: ступень шкалы выбирай по правилу критерия.", ""]
    for f in facts:
        topic = f" [{f['topic']}]" if f.get("topic") else ""
        lines.append(f"- {f['id']}{topic}: {f['fact']}")
    return "\n".join(lines)


def by_id(kb=None):
    kb = kb or get()
    return {f["id"]: f for f in kb.get("facts") or []}


def usage(results, kb=None):
    """Which facts were contradicted in which dialogs — for the knowledge screen."""
    index = by_id(kb)
    hits = {}
    for r in results.values():
        for cid, a in (r.get("answers") or {}).items():
            for fid in a.get("contradicts") or []:
                if fid not in index:
                    continue
                h = hits.setdefault(fid, {"id": fid, "dialogs": []})
                h["dialogs"].append({"conversationId": r.get("conversationId"), "explanation": a.get("explanation")})
    return hits

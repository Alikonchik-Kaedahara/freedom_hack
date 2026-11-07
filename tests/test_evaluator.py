"""Prompt/schema building, answer validation, retries and the replay engine."""
import copy
import json
import os

import pytest

from cqa import evaluator, replay, storage
from cqa.defaults import DEFAULT_CHECKLISTS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAT = DEFAULT_CHECKLISTS[0]

RECORD = {
    "conversation_id": "t-1", "channel": "agent chat", "language": "RU", "audio_url": None,
    "transcript": [
        {"timestamp": "00:00", "speaker": "bot", "text": "Здравствуйте! Я бот."},
        {"timestamp": "00:05", "speaker": "client", "text": "Какая комиссия на акции США?"},
        {"timestamp": "00:20", "speaker": "operator", "text": "Здравствуйте! Меня зовут Айгерим. Уточните тариф, пожалуйста."},
        {"timestamp": "00:40", "speaker": "client", "text": "Единый."},
        {"timestamp": "01:00", "speaker": "operator", "text": "На тарифе Единый комиссия 0,2%. Хорошего дня!"},
        {"timestamp": "01:05", "speaker": "system", "text": "Чат закрыт оператором."},
    ],
}


def good_raw(checklist=CHAT):
    raw = {}
    for c in checklist["criteria"]:
        if c["type"] == "scale":
            verdict = str(max(s["value"] for s in c["scale"]))
        elif c["type"] == "flag":
            verdict = "no"
        else:
            verdict = "yes"
        raw[c["id"]] = {"verdict": verdict, "evidence": [2, 4], "explanation": "ok", "confidence": "high"}
    raw["c3"] = {"verdict": "na", "evidence": [1], "explanation": "общий вопрос", "confidence": "high"}
    raw["c8"]["evidence"] = []
    return raw


# ---------- prompt & schema ----------

def test_schema_is_built_from_checklist():
    schema = evaluator.build_schema(CHAT)
    assert set(schema["required"]) == {c["id"] for c in CHAT["criteria"]}
    c4 = schema["properties"]["c4"]["properties"]
    assert c4["verdict"]["enum"] == ["20", "15", "10", "5", "0", "na"]
    assert c4["confidence"]["enum"] == ["high", "medium", "low"]
    assert "confidence" in schema["properties"]["c1"]["required"]
    assert schema["properties"]["c1"]["properties"]["verdict"]["enum"] == ["yes", "no"]
    assert schema["properties"]["c8"]["properties"]["verdict"]["enum"] == ["yes", "no"]


def test_prompt_contains_every_criterion_and_numbered_replies():
    system, user = evaluator.build_prompt(RECORD, CHAT)
    for c in CHAT["criteria"]:
        assert c["name"] in system
    assert "[#0] [00:00] bot:" in user
    assert "[#5] [01:05] system:" in user
    # a new criterion added through the UI reaches the model without any code change
    cl = copy.deepcopy(CHAT)
    cl["criteria"].append({"id": "c9", "code": "09", "name": "Кросс-продажа", "type": "binary", "weight": 10,
                           "naAllowed": True, "description": "Да — предложил продукт", "naRule": "повода не было"})
    system2, _ = evaluator.build_prompt(RECORD, cl)
    assert "Кросс-продажа" in system2 and "c9" in evaluator.build_schema(cl)["required"]
    assert evaluator.prompt_hash(system) != evaluator.prompt_hash(system2)


def test_display_times_for_calls():
    t = [{"timestamp": "2026-11-01T10:15:02+05:00"}, {"timestamp": "2026-11-01T10:16:40+05:00"}]
    assert evaluator.display_times(t) == ["00:00", "01:38"]
    assert evaluator.display_times([{"timestamp": "00:07"}]) == ["00:07"]


# ---------- validation ----------

def test_valid_answer_has_no_problems():
    answers, problems = evaluator.validate(good_raw(), CHAT, RECORD)
    assert problems == []
    assert answers["c4"]["answer"] == 20 and answers["c3"]["answer"] == "na" and answers["c1"]["answer"] == "yes"
    assert answers["c1"]["confidence"] == "high"


@pytest.mark.parametrize("mutate, cid, code", [
    (lambda r: r["c1"].update(evidence=[0]), "c1", "bot_only_evidence"),
    (lambda r: r["c1"].update(evidence=[1]), "c1", "no_operator_evidence"),
    (lambda r: r["c2"].update(evidence=[99]), "c2", "evidence_out_of_range"),
    (lambda r: r["c7"].update(evidence=[]), "c7", "no_evidence"),
    (lambda r: r["c3"].update(evidence=[]), "c3", "no_evidence"),
    (lambda r: r["c4"].update(verdict="12"), "c4", "invalid_verdict"),
    (lambda r: r["c1"].update(verdict="maybe"), "c1", "invalid_verdict"),
    (lambda r: r["c5"].update(explanation=""), "c5", "empty_explanation"),
    (lambda r: r.pop("c6"), "c6", "missing"),
])
def test_validation_catches_bad_answers(mutate, cid, code):
    raw = good_raw()
    mutate(raw)
    answers, problems = evaluator.validate(raw, CHAT, RECORD)
    assert any(p["criterionId"] == cid and p["code"] == code for p in problems), problems
    assert set(answers) == {c["id"] for c in CHAT["criteria"]}, "answers stay complete even with problems"


def test_flag_no_needs_no_evidence_and_unknown_confidence_defaults():
    raw = good_raw()
    raw["c8"] = {"verdict": "no", "evidence": [], "explanation": "нет нарушений", "confidence": "whatever"}
    answers, problems = evaluator.validate(raw, CHAT, RECORD)
    assert problems == []
    assert answers["c8"]["confidence"] == "medium"


# ---------- retries ----------

def test_retry_fixes_problems_and_counts_usage(monkeypatch):
    calls = []
    bad = good_raw()
    bad["c1"]["evidence"] = [0]           # bot-only evidence
    bad["c4"]["verdict"] = "12"           # not a scale step
    fixed = good_raw()

    def fake_cloud(settings, system, messages, schema):
        calls.append(messages)
        text = json.dumps(bad if len(calls) == 1 else fixed)
        return text, {"inputTokens": 100, "outputTokens": 10, "costUsd": 0.01}, {"type": "cloud", "model": "fake"}

    monkeypatch.setattr(evaluator, "_call_cloud", fake_cloud)
    answers, usage, engine, meta = evaluator.evaluate(RECORD, CHAT, {"engine": "cloud"})
    assert meta["attempts"] == 2 and meta["unresolved"] == []
    assert usage == {"inputTokens": 200, "outputTokens": 20, "costUsd": 0.02}
    assert not any(a.get("needsReview") for a in answers.values())
    # the second request carries the previous answer and the list of problems
    assert calls[1][1]["role"] == "assistant" and calls[1][2]["role"] == "user"
    assert "01" in calls[1][2]["content"] and "verdict '12'" in calls[1][2]["content"]


def test_unresolved_problems_become_needs_review_not_failure(monkeypatch):
    bad = good_raw()
    bad["c2"]["evidence"] = []
    bad["c4"]["verdict"] = "12"
    attempts = []

    def always_bad(settings, system, messages, schema):
        attempts.append(1)
        return json.dumps(bad), {"inputTokens": 1, "outputTokens": 1, "costUsd": 0}, {"type": "cloud", "model": "fake"}

    monkeypatch.setattr(evaluator, "_call_cloud", always_bad)
    answers, usage, engine, meta = evaluator.evaluate(RECORD, CHAT, {"engine": "cloud"})
    assert len(attempts) == evaluator.MAX_ATTEMPTS == meta["attempts"]
    assert answers["c2"]["needsReview"] is True and answers["c2"]["answer"] == "yes"
    assert answers["c4"]["needsReview"] is True and answers["c4"]["answer"] is None
    assert {p["criterionId"] for p in meta["unresolved"]} == {"c2", "c4"}
    assert not answers["c1"].get("needsReview")


def test_non_json_answer_raises_after_retries(monkeypatch):
    monkeypatch.setattr(evaluator, "_call_cloud",
                        lambda *a: ("not json", {"inputTokens": 0, "outputTokens": 0, "costUsd": 0}, {"type": "cloud", "model": "fake"}))
    with pytest.raises(evaluator.EvaluationError):
        evaluator.evaluate(RECORD, CHAT, {"engine": "cloud"})


# ---------- replay ----------

def test_replay_uses_sample_answers_and_flags_unknown_criteria(fresh_storage):
    records = {r["conversation_id"]: r for r in json.load(open(os.path.join(replay.SAMPLE_DIR, "dataset.json"), encoding="utf-8"))}
    rec = records["sample-ru-001"]
    answers, usage, engine, meta = evaluator.evaluate(rec, CHAT, {"engine": "replay"})
    assert engine["type"] == "replay" and usage["costUsd"] == 0 and meta["unresolved"] == []
    assert answers["c3"]["answer"] == "na" and answers["c4"]["answer"] == 20

    cl = copy.deepcopy(CHAT)
    cl["criteria"].append({"id": "c9", "code": "09", "name": "Новый", "type": "binary", "weight": 10, "naAllowed": False})
    answers, _, _, meta = evaluator.evaluate(rec, cl, {"engine": "replay"})
    assert answers["c9"]["needsReview"] is True and answers["c9"]["answer"] is None
    assert meta["unresolved"][0]["criterionId"] == "c9"


def test_replay_without_saved_answer_raises(fresh_storage):
    with pytest.raises(evaluator.EvaluationError):
        evaluator.evaluate(RECORD, CHAT, {"engine": "replay"})


def test_replay_prefers_previous_result_from_storage(fresh_storage):
    saved = {"key": "G:t-1", "groupId": "G", "conversationId": "t-1", "checklist": CHAT, "appeals": [],
             "answers": {c["id"]: {"answer": "na" if c.get("naAllowed") else ("no" if c["type"] != "scale" else 0),
                                   "evidence": [1], "explanation": "x", "confidence": "medium"} for c in CHAT["criteria"]},
             "createdAt": "2026-11-07T00:00:00+00:00"}
    storage.put_result(saved)
    answers, _, engine, _ = evaluator.evaluate(RECORD, CHAT, {"engine": "replay"})
    assert engine["type"] == "replay" and answers["c2"]["answer"] == "na" and answers["c1"]["answer"] == "no"

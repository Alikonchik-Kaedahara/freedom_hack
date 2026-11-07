"""results/<dev|prod>/results.json in the organizers' JSON 1.0 format (CQA_Student_Guide_Appendix_Results)."""
import copy
import json
import os

import pytest

from conftest import wait_job

from cqa import evaluator, export, replay, storage


@pytest.fixture
def results_dir(tmp_path, monkeypatch):
    d = tmp_path / "results"
    monkeypatch.setattr(export, "RESULTS_DIR", str(d))
    return d


@pytest.fixture
def fake_cloud(monkeypatch):
    """A 'cloud' engine that answers from demo/sample/answers.json: real-looking results without a key."""
    answers = json.load(open(os.path.join(replay.SAMPLE_DIR, "answers.json"), encoding="utf-8"))

    def call(settings, system, messages, schema):
        cid = messages[0]["content"].split("Диалог ")[1].split(" ")[0]
        checklist_id = "call-base" if "voice call" in messages[0]["content"].split("\n")[0] else "chat-base"
        text = json.dumps(answers[cid][checklist_id], ensure_ascii=False)
        return text, {"inputTokens": 1000, "outputTokens": 300, "costUsd": 0.01}, {"type": "cloud", "model": "claude-test"}

    monkeypatch.setattr(evaluator, "_call_cloud", call)


def evaluated_sample(client, engine="cloud"):
    assert client.post("/api/datasets/import", json={"groupId": "SAMPLE"}).status_code == 200
    patch = {"engine": engine}
    if engine == "cloud":
        patch["cloud"] = {"apiKey": "test-key"}
    assert client.put("/api/settings", json=patch).status_code == 200
    ids = [x["conversation_id"] for x in client.get("/api/datasets/SAMPLE").get_json()]
    r = client.post("/api/evaluate", json={"groupId": "SAMPLE", "conversationIds": ids})
    assert r.status_code == 200, r.get_json()
    job = wait_job(client, r.get_json()["id"])
    assert job["failed"] == 0, job["errors"]
    return ids


def test_export_matches_format(client, results_dir, fake_cloud):
    evaluated_sample(client)
    doc, report = export.build("SAMPLE", "Команда")
    assert doc["schema_version"] == "1.0" and doc["team_name"] == "Команда"
    assert doc["model"] == {"mode": "external_api", "name": "claude-test"}
    assert report["total"] == 5 and report["ok"] == 5 and report["error"] == 0
    by_id = {r["conversation_id"]: r for r in doc["results"]}

    r1 = by_id["sample-ru-001"]
    assert r1["status"] == "ok"
    assert [c["criterion_id"] for c in r1["criteria"]] == export.EXPORT_IDS
    rows = {c["criterion_id"]: c for c in r1["criteria"]}
    assert rows["contact"]["value"] is True
    assert rows["identification"]["value"] is None, "N/A -> null"
    assert rows["consultation"]["value"] == 20 and rows["dialogue"]["value"] == 10
    assert rows["critical"]["value"] is False
    assert rows["contact"]["evidence_turns"] == [4], "numbering starts at 1 (stored index 3)"
    assert r1["score"] == {"final_score": 100.0, "critical_flag": False}

    r4 = by_id["sample-en-004"]
    assert r4["score"] == {"final_score": 87.5, "critical_flag": True}
    assert {c["criterion_id"]: c["value"] for c in r4["criteria"]}["critical"] is True
    assert {c["criterion_id"]: c["evidence_turns"] for c in r4["criteria"]}["critical"] == [8]

    r2 = by_id["sample-ru-002"]
    assert r2["score"]["final_score"] == 40.5
    assert all(c["rationale"] for c in r2["criteria"])
    assert export.check(doc) == []


def test_export_uses_final_answers_after_appeal(client, results_dir, fake_cloud):
    evaluated_sample(client)
    key = "SAMPLE:sample-ru-002"
    ap = client.post(f"/api/results/{key}/appeals", json={"criterionId": "c5", "comment": "x"}).get_json()["appeals"][0]["id"]
    client.post(f"/api/results/{key}/appeals/{ap}/decision", json={"status": "accepted", "answer": "yes", "reason": "ok"})
    doc, _ = export.build("SAMPLE", "T")
    r2 = next(r for r in doc["results"] if r["conversation_id"] == "sample-ru-002")
    assert {c["criterion_id"]: c["value"] for c in r2["criteria"]}["empathy"] is True
    assert r2["score"]["final_score"] == 55.5


def test_replay_results_are_not_exportable_by_default(client, results_dir):
    evaluated_sample(client, engine="replay")
    doc, report = export.build("SAMPLE", "T")
    assert report["ok"] == 0 and report["error"] == 5 and len(report["replay"]) == 5
    assert all(r["status"] == "error" and "replay" in r["error"] for r in doc["results"])
    # with --allow-replay the sample source is exported, but the format check flags the model mode
    doc2, report2 = export.build("SAMPLE", "T", allow_replay=True)
    assert report2["ok"] == 5 and doc2["model"]["mode"] == "sample"
    assert any("model.mode" in p for p in export.check(doc2))


def test_missing_failed_and_unreviewed_dialogs_become_error_records(client, results_dir, fake_cloud):
    ids = evaluated_sample(client)
    # one dialog never evaluated, one failed, one with an unresolved criterion
    results = storage.get_results()
    results.pop("SAMPLE:sample-kz-003")
    results["SAMPLE:sample-ru-001"]["answers"]["c4"]["answer"] = None
    results["SAMPLE:sample-ru-001"]["answers"]["c4"]["needsReview"] = True
    storage._write("results", results)
    storage.put_failure("SAMPLE:sample-call-005", "SAMPLE", "sample-call-005", "Модель не ответила", "2026-11-08T00:00:00+00:00")
    results.pop("SAMPLE:sample-call-005")
    storage._write("results", results)

    doc, report = export.build("SAMPLE", "T")
    by_id = {r["conversation_id"]: r for r in doc["results"]}
    assert len(doc["results"]) == 5, "every dialog of the set stays in the file"
    assert by_id["sample-kz-003"]["status"] == "error" and by_id["sample-kz-003"]["error"] == "Диалог не оценён."
    assert by_id["sample-call-005"]["error"] == "Модель не ответила"
    assert by_id["sample-ru-001"]["status"] == "error" and "consultation" in by_id["sample-ru-001"]["error"]
    assert by_id["sample-ru-001"]["criteria"] == [] and by_id["sample-ru-001"]["score"] is None
    assert report["missing"] == ["sample-kz-003"] and report["ok"] == 2
    assert export.check(doc) == []


def test_write_and_api_endpoint(client, results_dir, fake_cloud):
    evaluated_sample(client)
    r = client.get("/api/export/dev?group=SAMPLE")
    assert r.status_code == 200, r.get_json()
    report = r.get_json()
    assert report["ok"] == 5 and report["problems"] == []
    path = results_dir / "dev" / "results.json"
    assert path.exists()
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert len(doc["results"]) == 5 and doc["team_name"] == "freedom_hack"
    assert client.get("/api/export/dev/download").status_code == 200
    assert client.get("/api/export/prod/download").status_code == 404
    assert client.get("/api/export/dev").status_code == 400
    assert client.get("/api/export/weird?group=SAMPLE").status_code == 400
    assert client.get("/api/export/dev?group=NOPE").status_code == 400
    # team name from settings is used
    assert client.put("/api/settings", json={"teamName": "Pulse"}).status_code == 200
    assert client.get("/api/export/dev?group=SAMPLE").get_json()["ok"] == 5
    assert json.loads(path.read_text(encoding="utf-8"))["team_name"] == "Pulse"


def test_na_where_format_forbids_null_falls_back_to_false(client, results_dir, fake_cloud):
    evaluated_sample(client)
    results = storage.get_results()
    call = results["SAMPLE:sample-call-005"]
    call["checklist"]["criteria"][0]["naAllowed"] = True
    call["answers"]["c1"]["answer"] = "na"
    storage._write("results", results)
    doc, _ = export.build("SAMPLE", "T")
    r5 = next(r for r in doc["results"] if r["conversation_id"] == "sample-call-005")
    contact = next(c for c in r5["criteria"] if c["criterion_id"] == "contact")
    assert contact["value"] is False and contact["rationale"].startswith("N/A по чек-листу системы")
    assert r5["score"]["final_score"] == 100.0, "the score still excludes the N/A criterion"
    assert export.check(doc) == []


def test_check_catches_format_problems():
    doc = {"schema_version": "1.0", "team_name": "T", "model": {"mode": "cloud", "name": "x"},
           "results": [
               {"conversation_id": "a", "status": "ok",
                "criteria": [{"criterion_id": "contact", "value": "yes", "rationale": "", "evidence_turns": [0]}],
                "score": {"final_score": 101, "critical_flag": False}},
               {"conversation_id": "a", "status": "error", "criteria": [{"x": 1}], "score": None, "error": ""},
           ]}
    problems = export.check(doc, expected_count=10)
    text = "\n".join(problems)
    assert "model.mode" in text and "повторяющиеся" in text and "ожидается 10" in text
    assert "восьми кодам" in text and "true/false" in text and "evidence_turns" in text
    assert "0..100" in text and "status=error" in text


def test_update_defaults_bumps_versions_and_keeps_export_ids(fresh_storage):
    import manage
    manage.main(["manage.py", "update-defaults"])
    chat = storage.get_checklist("chat-base")
    assert chat["version"] == 2
    assert [c["exportId"] for c in chat["criteria"]] == list(export.EXPORT_IDS)
    assert "омниканальная" in chat["criteria"][2]["description"]


def test_checklist_validation_knows_export_ids(client):
    cl = copy.deepcopy(storage.get_checklist("chat-base"))
    cl["criteria"][0]["exportId"] = "weird"
    assert client.put("/api/checklists/chat-base", json=cl).status_code == 400
    cl["criteria"][0]["exportId"] = "closure"  # duplicate of c7
    assert client.put("/api/checklists/chat-base", json=cl).status_code == 400
    cl["criteria"][0]["exportId"] = "contact"
    assert client.put("/api/checklists/chat-base", json=cl).status_code == 200

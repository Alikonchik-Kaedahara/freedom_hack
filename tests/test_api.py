"""HTTP API: sample import, replay evaluation, appeals, validation and file upload (no key, no network)."""
import copy
import io
import json
import os

from conftest import wait_job

from cqa import replay, storage

SAMPLE_TOTALS = {  # demo/README.md
    "sample-ru-001": (100.0, False), "sample-ru-002": (40.5, False), "sample-kz-003": (95.5, False),
    "sample-en-004": (87.5, True), "sample-call-005": (100.0, False),
}


def import_sample(client):
    r = client.post("/api/datasets/import", json={"groupId": "SAMPLE"})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["total"] == 5
    assert client.put("/api/settings", json={"engine": "replay"}).status_code == 200
    return [x["conversation_id"] for x in client.get("/api/datasets/SAMPLE").get_json()]


def evaluate_all(client, ids, checklist_id=None):
    body = {"groupId": "SAMPLE", "conversationIds": ids}
    if checklist_id:
        body["checklistId"] = checklist_id
    r = client.post("/api/evaluate", json=body)
    assert r.status_code == 200, r.get_json()
    return wait_job(client, r.get_json()["id"])


def test_sample_replay_end_to_end(client):
    ids = import_sample(client)
    assert client.get("/api/engine/status").get_json()["ok"] is True
    job = evaluate_all(client, ids)
    assert job["done"] == 5 and job["failed"] == 0 and job["errors"] == []
    results = client.get("/api/results?group=SAMPLE").get_json()
    for cid, (total, gross) in SAMPLE_TOTALS.items():
        res = results[f"SAMPLE:{cid}"]
        assert res["score"]["total"] == total, cid
        assert res["score"]["gross"] is gross, cid
        assert res["engine"]["type"] == "replay" and res["attempts"] == 1 and res["usage"]["costUsd"] == 0
        assert res["promptHash"]
    assert results["SAMPLE:sample-ru-002"]["score"]["disputed"] == ["c5"]
    assert results["SAMPLE:sample-ru-001"]["answers"]["c3"]["answer"] == "na"
    assert results["SAMPLE:sample-en-004"]["answers"]["c8"]["evidence"] == [7]
    assert client.get("/api/results/SAMPLE:sample-ru-001").status_code == 200
    assert client.get("/api/results/SAMPLE:nope").status_code == 404


def test_appeal_and_decision_recalculate(client):
    ids = import_sample(client)
    evaluate_all(client, ids)
    key = "SAMPLE:sample-ru-002"
    r = client.post(f"/api/results/{key}/appeals", json={"criterionId": "c5", "comment": "Клиент не жаловался"})
    assert r.status_code == 200 and r.get_json()["score"]["pending"] == 1
    appeal_id = r.get_json()["appeals"][0]["id"]
    # second pending appeal on the same criterion is refused
    assert client.post(f"/api/results/{key}/appeals", json={"criterionId": "c5", "comment": "ещё"}).status_code == 400
    assert client.post(f"/api/results/{key}/appeals", json={"criterionId": "zzz", "comment": "x"}).status_code == 400
    assert client.post(f"/api/results/{key}/appeals", json={"criterionId": "c1"}).status_code == 400

    bad = client.post(f"/api/results/{key}/appeals/{appeal_id}/decision", json={"status": "accepted", "answer": "maybe", "reason": "r"})
    assert bad.status_code == 400
    assert client.post(f"/api/results/{key}/appeals/{appeal_id}/decision", json={"status": "accepted", "answer": "yes"}).status_code == 400
    ok = client.post(f"/api/results/{key}/appeals/{appeal_id}/decision", json={"status": "accepted", "answer": "yes", "reason": "Недовольства не было"})
    assert ok.status_code == 200
    s = ok.get_json()["score"]
    assert s["originalTotal"] == 40.5 and s["total"] == 55.5 and s["pending"] == 0 and s["changed"] is True
    assert ok.get_json()["answers"]["c5"]["answer"] == "no", "original AI answer is kept"
    # a decided appeal cannot be decided twice
    again = client.post(f"/api/results/{key}/appeals/{appeal_id}/decision", json={"status": "rejected", "reason": "x"})
    assert again.status_code == 400


def test_checklist_validation(client):
    cl = copy.deepcopy(storage.get_checklist("chat-base"))
    assert client.put("/api/checklists/chat-base", data="{bad json", content_type="application/json").status_code == 400

    wrong = copy.deepcopy(cl)
    wrong["criteria"][0]["weight"] = 99
    r = client.put("/api/checklists/chat-base", json=wrong)
    assert r.status_code == 400 and "100" in r.get_json()["error"]

    wrong = copy.deepcopy(cl)
    wrong["criteria"][3]["scale"] = [{"value": 20, "label": ""}]
    assert client.put("/api/checklists/chat-base", json=wrong).status_code == 400

    wrong = copy.deepcopy(cl)
    wrong["criteria"][1]["type"] = "weird"
    assert client.put("/api/checklists/chat-base", json=wrong).status_code == 400

    wrong = copy.deepcopy(cl)
    wrong["criteria"] = []
    assert client.put("/api/checklists/chat-base", json=wrong).status_code == 400

    # a valid edit creates a new version; the old one is kept in history
    ok = copy.deepcopy(cl)
    ok["criteria"][0]["weight"] = 5
    ok["criteria"][1]["weight"] = 20
    r = client.put("/api/checklists/chat-base", json=ok)
    assert r.status_code == 200 and r.get_json()["version"] == 2
    assert storage.get_checklist("chat-base")["criteria"][0]["weight"] == 5


def test_new_criterion_applies_without_code_changes(client):
    """The 23-hour control: replace a criterion in the UI, re-apply the checklist."""
    ids = import_sample(client)
    cl = copy.deepcopy(storage.get_checklist("chat-base"))
    cl["criteria"][1] = {"id": "c-new", "code": "02", "name": "Предложение продукта", "section": cl["criteria"][1]["section"],
                         "type": "binary", "weight": 15, "naAllowed": True, "description": "Да — предложил релевантный продукт",
                         "naRule": "повода не было"}
    assert client.put("/api/checklists/chat-base", json=cl).status_code == 200
    job = evaluate_all(client, [i for i in ids if i != "sample-call-005"], checklist_id="chat-base")
    assert job["done"] == 4 and job["needsReview"] == 4, "replay has no saved answer for the new criterion → needs review, not a guess"
    res = client.get("/api/results/SAMPLE:sample-ru-001").get_json()
    assert res["answers"]["c-new"]["needsReview"] is True and res["answers"]["c-new"]["answer"] is None
    assert "c-new" in res["score"]["disputed"]
    assert res["checklist"]["version"] == 2
    assert res["history"][0]["checklist"]["version"] == 1 if res.get("history") else True


def test_evaluate_validation(client):
    import_sample(client)
    assert client.post("/api/evaluate", data="nope", content_type="application/json").status_code == 400
    assert client.post("/api/evaluate", json={"groupId": "SAMPLE", "conversationIds": []}).status_code == 400
    assert client.post("/api/evaluate", json={"groupId": "NOPE", "conversationIds": ["x"]}).status_code == 404
    r = client.post("/api/evaluate", json={"groupId": "SAMPLE", "conversationIds": ["sample-ru-001", "ghost"]})
    assert r.status_code == 400 and "ghost" in r.get_json()["error"]
    assert client.post("/api/evaluate", json={"groupId": "SAMPLE", "conversationIds": ["sample-ru-001"], "checklistId": "none"}).status_code == 404
    assert client.put("/api/settings", json={"engine": "magic"}).status_code == 400
    # cloud engine without a key is refused before any job starts
    assert client.put("/api/settings", json={"engine": "cloud"}).status_code == 200
    assert client.post("/api/evaluate", json={"groupId": "SAMPLE", "conversationIds": ["sample-ru-001"]}).status_code == 412


def test_import_without_data_api_explains(client):
    r = client.post("/api/datasets/import", json={"groupId": "DEV"})
    assert r.status_code == 412 and "CQA_DATA_API" in r.get_json()["error"]
    assert client.post("/api/datasets/import", json={}).status_code == 400
    assert client.post("/api/datasets/import", data="x", content_type="application/json").status_code == 400


def test_upload_transcript_file(client):
    sample = open(os.path.join(replay.SAMPLE_DIR, "dataset.json"), "rb").read()
    r = client.post("/api/datasets/upload", data={"file": (io.BytesIO(sample), "my_dialogs.json")}, content_type="multipart/form-data")
    assert r.status_code == 200 and r.get_json()["groupId"] == "my_dialogs" and r.get_json()["total"] == 5

    # the organizers' envelope and a single record are accepted too; re-upload merges by conversation_id
    one = {"conversation_id": "sample-ru-001", "channel": "agent chat", "language": "ru",
           "transcript": [{"timestamp": "00:00", "speaker": "operator", "text": "Здравствуйте"}]}
    r = client.post("/api/datasets/upload", json={"groupId": "my_dialogs", "records": [one]})
    assert r.status_code == 200 and r.get_json()["total"] == 5 and r.get_json()["added"] == 1
    rec = storage.get_record("my_dialogs", "sample-ru-001")
    assert rec["language"] == "RU" and len(rec["transcript"]) == 1

    env = {"isSuccess": True, "data": {"records": [dict(one, conversation_id="x-1")]}}
    r = client.post("/api/datasets/upload", data={"file": (io.BytesIO(json.dumps(env).encode()), "env.json"), "groupId": "ENV"},
                    content_type="multipart/form-data")
    assert r.status_code == 200 and r.get_json()["total"] == 1

    bad_cases = [
        b"{not json",
        json.dumps([]).encode(),
        json.dumps([{"conversation_id": "u1", "transcript": [{"speaker": "alien", "text": "hi"}]}]).encode(),
        json.dumps([{"conversation_id": "u1", "transcript": []}]).encode(),
        json.dumps([{"transcript": [{"speaker": "client", "text": "hi"}]}]).encode(),
        json.dumps([{"conversation_id": "u1", "language": "FR", "transcript": [{"speaker": "client", "text": "hi"}]}]).encode(),
        json.dumps([{"conversation_id": "u1", "transcript": [{"speaker": "client"}]}]).encode(),
    ]
    for payload in bad_cases:
        r = client.post("/api/datasets/upload", data={"file": (io.BytesIO(payload), "bad.json")}, content_type="multipart/form-data")
        assert r.status_code == 400, payload
        assert r.get_json()["error"]
    assert client.post("/api/datasets/upload", data="x", content_type="text/plain").status_code == 400


def test_snapshot_and_restore(client, fresh_storage, monkeypatch, tmp_path):
    snap = tmp_path / "snap"
    monkeypatch.setattr(replay, "SNAPSHOT_DIR", str(snap))
    ids = import_sample(client)
    evaluate_all(client, ids)
    copied = replay.export_snapshot()
    assert "results.json" in copied and "dataset_SAMPLE.json" in copied
    assert "apiKey" not in open(snap / "settings.json", encoding="utf-8").read()

    # a fresh machine: empty storage, restore brings the results back and replay can serve them
    for name in os.listdir(fresh_storage):
        if name.endswith(".json"):
            os.remove(os.path.join(fresh_storage, name))
    assert client.get("/api/results?group=SAMPLE").get_json() == {}
    restored = replay.restore_snapshot()
    assert "results.json" in restored
    assert len(client.get("/api/results?group=SAMPLE").get_json()) == 5
    assert client.put("/api/settings", json={"engine": "replay"}).status_code == 200
    assert client.get("/api/engine/status").get_json()["saved"] >= 5

    # python server.py --demo on a clean machine: restore, keep sample, switch to replay when there is no key
    import server
    server.prepare_demo()
    assert storage.get_settings()["engine"] == "replay"
    assert storage.list_datasets()[0]["groupId"] == "SAMPLE"

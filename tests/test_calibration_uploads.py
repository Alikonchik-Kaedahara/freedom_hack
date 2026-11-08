import io
import json
from concurrent.futures import ThreadPoolExecutor

from cqa import quality, storage


def record(cid):
    return {"conversation_id": cid, "channel": "agent chat", "language": "RU", "transcript": []}


def entry(cid, code, value):
    return {"conversationId": cid, "criterionCode": code, "value": value, "evidence": "1", "comment": "Проверено"}


def upload(client, who, entries, group="DEV"):
    submission = {"who": who, "createdAt": "time", "source": "razmetka.html", "entries": entries}
    return client.post("/api/quality/calibration", query_string={"group": group}, data={
        "file": (io.BytesIO(json.dumps(submission).encode()), f"razmetka_{who}.json"),
    })


def test_three_individual_files_coexist_and_round_trip(client):
    storage.save_dataset("DEV", [record("d1"), record("d2")], "time")
    storage.save_dataset("FBroker", [record("p1")], "time")
    files = {}
    for name, value in [("Томирис", 7), ("Алихан", 4), ("Ерлан", 7)]:
        rows = [entry("d1", "01", "Да"), entry("d1", "06", value)]
        if name == "Ерлан":
            rows.append(entry("d2", "05", "Нет"))
        files[name] = rows
        assert upload(client, name, rows).status_code == 200

    get = "/api/quality/calibration"
    def stats(group="DEV"):
        return client.get("/api/quality", query_string={"group": group, "section": "model"}).json["calibration"]
    c = stats()
    assert c["entries"] == 1 and c["team"]["unanimous"] == 1 and c["team"]["total"] == 7
    assert c["team"]["conflicts"] == [{"conversationId": "d1", "criterionCode": "06",
                                       "votes": {"Томирис": 7, "Алихан": 4, "Ерлан": 7}}]
    assert c["team"]["partial"][0]["votes"] == {"Ерлан": "no"}
    assert stats("FBroker")["entries"] == 0
    assert upload(client, "Ерлан", files["Ерлан"], group="FBroker").status_code == 400
    assert upload(client, "Ерлан", files["Ерлан"]).status_code == 200
    for who, rows in files.items():
        doc = client.get(get, query_string={"group": "DEV", "who": who}).json
        assert doc == {"who": who, "createdAt": "time", "source": "razmetka.html", "entries": rows}
    assert upload(client, "Ерлан", []).status_code == 400
    assert stats()["team"]["total"] == 7
    assert client.post(get, query_string={"group": "DEV"}, json={"entries": [entry("d1", "06", 4)]}).status_code == 200
    assert stats()["entries"] == 2 and stats()["team"]["total"] == 7
    client.delete(get, query_string={"group": "FBroker"})
    assert stats()["team"]["total"] == 7


def test_concurrent_partial_uploads_and_legacy_consensus(fresh_storage):
    records = [record("d1")]
    storage.save_dataset("DEV", records, "time")
    quality.save_calibration([entry("d1", "06", 4)], "first", "legacy.xlsx")
    def save(i):
        rows = [entry("d1", format(i, "02"), "Да")]
        quality.save_calibration(rows, "now", "upload", group="DEV", submission={"who": "A", "entries": rows})
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(save, [1, 2, 3, 5]))
    c = quality.group_calibration("DEV", records)
    assert c["team"]["total"] == 4 and c["entries"][0]["value"] == 4
    quality.clear_calibration("DEV", "now")
    assert quality.group_calibration("DEV", records)["entries"] == []

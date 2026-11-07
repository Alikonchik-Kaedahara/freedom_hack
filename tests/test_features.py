"""Second opinion, quality of evaluation, operator profiles, knowledge base, printable report."""
import copy
import io
import json
import os

import pytest

from conftest import wait_job

from cqa import evaluator, knowledge, operators, quality, replay, report, scoring, second, storage
from cqa.defaults import DEFAULT_CHECKLISTS, INTERPRETATIONS

CHAT = DEFAULT_CHECKLISTS[0]
NOW = "2026-11-08T10:00:00+00:00"


def sample_records():
    return json.load(open(os.path.join(replay.SAMPLE_DIR, "dataset.json"), encoding="utf-8"))


def sample_answers(cid, checklist_id="chat-base"):
    """Normalized answers for a sample dialog from the curated replay file."""
    raw = json.load(open(os.path.join(replay.SAMPLE_DIR, "answers.json"), encoding="utf-8"))[cid][checklist_id]
    rec = next(r for r in sample_records() if r["conversation_id"] == cid)
    checklist = next(c for c in DEFAULT_CHECKLISTS if c["id"] == checklist_id)
    answers, problems = evaluator.validate(raw, checklist, rec)
    assert not problems, problems
    return rec, checklist, answers


def make_result(cid, checklist_id="chat-base", group="SAMPLE"):
    rec, checklist, answers = sample_answers(cid, checklist_id)
    return rec, {"key": f"{group}:{cid}", "groupId": group, "conversationId": cid, "language": rec["language"], "channel": rec["channel"],
                 "checklist": copy.deepcopy(checklist), "answers": answers, "appeals": [],
                 "engine": {"type": "cloud", "model": "m1"}, "createdAt": NOW}


# ---------- second opinion ----------

def test_compare_agree_near_disagree():
    rec, res = make_result("sample-ru-001")
    first = res["answers"]
    other = copy.deepcopy(first)
    other["c4"]["answer"] = 15 if first["c4"]["answer"] == 20 else 20   # adjacent step on the scale
    other["c7"]["answer"] = "no" if first["c7"]["answer"] == "yes" else "yes"
    cmp = second.compare(res["checklist"], first, other)
    assert cmp["near"] == ["c4"] and cmp["disagree"] == ["c7"]
    assert len(cmp["agree"]) == 6
    assert cmp["rate"] == 0.75 and cmp["lenientRate"] == 0.88
    assert cmp["details"]["c7"]["status"] == "disagree"
    # a far jump on the scale is a disagreement, not "near"
    other["c4"]["answer"] = 0
    assert "c4" in second.compare(res["checklist"], first, other)["disagree"]
    # a missing answer on one side counts as a disagreement
    del other["c1"]
    assert "c1" in second.compare(res["checklist"], first, other)["disagree"]


def test_attach_marks_disputed_and_keeps_original():
    rec, res = make_result("sample-ru-001")
    original = copy.deepcopy(res["answers"])
    other = copy.deepcopy(res["answers"])
    other["c7"]["answer"] = "no"
    second.attach(res, other, {"costUsd": 0.01}, {"type": "local", "model": "qwen"}, {"attempts": 1, "promptHash": "x"}, NOW)
    assert res["answers"] == original, "the first answers are never changed"
    assert second.disagreed_ids(res) == ["c7"]
    assert "c7" in scoring.disputed(res)
    summary = scoring.summarize(res)
    assert summary["secondOpinion"]["disagree"] == ["c7"] and summary["secondOpinion"]["engine"]["model"] == "qwen"
    assert "c7" in summary["disputed"]


def test_reproducibility_aggregates_by_criterion_language_and_engine():
    results = []
    for cid, same in (("sample-ru-001", True), ("sample-ru-002", False), ("sample-kz-003", True)):
        rec, res = make_result(cid)
        other = copy.deepcopy(res["answers"])
        if cid == "sample-ru-002":
            other["c1"]["answer"] = "no" if other["c1"]["answer"] == "yes" else "yes"
        engine = {"type": "cloud", "model": "m1"} if same else {"type": "local", "model": "q"}
        second.attach(res, other, {}, engine, {}, NOW)
        results.append(res)
    r = second.reproducibility(results)
    assert r["dialogs"] == 3 and r["criteria"] == 24
    assert r["sameEngine"] == 2 and r["otherEngine"] == 1
    assert r["rate"] == scoring.round2(23 / 24 * 100)
    c1 = next(p for p in r["perCriterion"] if p["code"] == "01")
    assert c1["disagree"] == 1 and c1["total"] == 3
    assert r["perLanguage"]["KZ"]["rate"] == 100.0 and r["perLanguage"]["RU"]["agree"] == 15
    assert second.reproducibility([])["rate"] is None


# ---------- quality: calibration, appeals, patterns ----------

def test_norm_value_reads_the_sheet_cells():
    assert quality.norm_value("Да") == "yes" and quality.norm_value("нет") == "no" and quality.norm_value("N/A") == "na"
    assert quality.norm_value(15) == 15 and quality.norm_value("15") == 15 and quality.norm_value(7.5) == 7.5
    assert quality.norm_value("") is None and quality.norm_value(None) is None and quality.norm_value(True) == "yes"


def test_agreement_compares_consensus_with_original_answers(fresh_storage):
    rec, res = make_result("sample-ru-001")
    rec2, res2 = make_result("sample-ru-002")
    # an accepted appeal must not change the comparison: the team is compared with what the model said
    res["appeals"].append({"id": "a1", "criterionId": "c1", "status": "accepted", "decision": {"answer": "no"}})
    entries = [
        {"conversationId": "sample-ru-001", "criterionCode": "01", "value": "Да"},
        {"conversationId": "sample-ru-001", "criterionCode": "04", "value": 15, "comment": "ответ неполный"},  # model: 20 -> near
        {"conversationId": "sample-ru-002", "criterionCode": "01", "value": "Да"},                              # model: no -> disagree
        {"conversationId": "sample-ru-002", "criterionCode": "08", "value": "Нет"},
        {"conversationId": "sample-xx-999", "criterionCode": "01", "value": "Да"},                              # not evaluated
        {"conversationId": "sample-ru-001", "criterionCode": "02", "value": ""},                                # blank cell is skipped
    ]
    cal = quality.save_calibration(entries, NOW, "test")
    assert len(cal["entries"]) == 5 and quality.get_calibration()["source"] == "test"
    a = quality.agreement({res["key"]: res, res2["key"]: res2}, records=[rec, rec2])
    assert a["compared"] == 4 and a["agree"] == 2 and a["near"] == 1
    assert a["rate"] == 50.0 and a["lenientRate"] == 75.0
    assert a["missing"] == ["sample-xx-999"]
    per = {p["code"]: p for p in a["perCriterion"]}
    assert per["01"]["agree"] == 1 and per["01"]["disagreements"][0]["model"] == "no"
    assert per["04"]["near"] == 1 and per["04"]["disagreements"][0]["comment"] == "ответ неполный"
    assert a["perLanguage"][0]["language"] == "RU" and a["perLanguage"][0]["total"] == 4


def test_parse_xlsx_reads_the_team_sheet():
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Разметка"
    ws.append(["Калибровка — как заполнять"])
    ws.append([])
    ws.append(["Диалог", "Язык", "Критерий", "Томирис", "Алихан", "Ерлан", "Итог (консенсус)", "Комментарий / спорная трактовка"])
    ws.append(["p1-ru-001", "RU", "01 Установление контакта", "Да", "Да", "Да", "Да", ""])
    ws.append(["p1-ru-001", "RU", "04 Корректная консультация", 20, 15, 15, 15, "неполный ответ"])
    ws.append(["p1-ru-001", "RU", "05 Эмпатия", "Да", "Нет", None, None, ""])   # no consensus yet
    ws.append([None, None, None])
    buf = io.BytesIO()
    wb.save(buf)
    entries = quality.parse_xlsx(buf.getvalue())
    assert entries == [
        {"conversationId": "p1-ru-001", "criterionCode": "01", "value": "Да", "comment": ""},
        {"conversationId": "p1-ru-001", "criterionCode": "04", "value": 15, "comment": "неполный ответ"},
    ]
    wb2 = Workbook()
    wb2.active.append(["что-то другое"])
    buf2 = io.BytesIO()
    wb2.save(buf2)
    with pytest.raises(ValueError):
        quality.parse_xlsx(buf2.getvalue())


def test_appeal_stats_and_patterns():
    rec, res = make_result("sample-ru-002")
    rec2, res2 = make_result("sample-en-004")
    res["appeals"] = [{"id": "1", "criterionId": "c5", "status": "accepted", "decision": {"answer": "yes"}},
                      {"id": "2", "criterionId": "c1", "status": "rejected", "decision": {"answer": None}},
                      {"id": "3", "criterionId": "c5", "status": "pending"}]
    st = quality.appeal_stats({res["key"]: res, res2["key"]: res2})
    assert st == {"total": 3, "accepted": 1, "rejected": 1, "pending": 1, "overturnRate": 50.0,
                  "perCriterion": [{"code": "01", "name": CHAT["criteria"][0]["name"], "total": 1, "accepted": 0, "rejected": 1, "pending": 0, "overturnRate": 0.0},
                                   {"code": "05", "name": CHAT["criteria"][4]["name"], "total": 2, "accepted": 1, "rejected": 0, "pending": 1, "overturnRate": 100.0}]}
    p = quality.patterns({res["key"]: res, res2["key"]: res2}, [rec, rec2])
    assert p["dialogs"] == 2
    by_code = {c["code"]: c for c in p["criteria"]}
    assert by_code["08"]["type"] == "flag" and by_code["08"]["flag"] == 1 and by_code["08"]["share"] == 50.0
    assert by_code["08"]["examples"][0]["conversationId"] == "sample-en-004"
    assert by_code["08"]["examples"][0]["turn"] == 8, "evidence turns are reported 1-based"
    # the accepted appeal on c5 counts: the pattern is built from the final answers
    assert by_code["05"]["failed"] == 0
    # sorted by share, worst first
    shares = [c["share"] or 0 for c in p["criteria"]]
    assert shares == sorted(shares, reverse=True)
    for c in p["criteria"]:
        assert len(c["examples"]) <= 3


# ---------- operators ----------

@pytest.mark.parametrize("text,name", [
    ("Здравствуйте! Меня зовут Айгерим. Чем могу помочь?", "Айгерим"),
    ("Добрый день, я Руслан, помогу вам.", "Руслан"),
    ("Здравствуйте, это Марк из поддержки.", "Марк"),
    ("Сәлеметсіз бе! Мен Нұрланмын. Көмектесейін.", "Нұрлан"),
    ("Сәлеметсіз бе, менің атым Айсұлу.", "Айсұлу"),
    ("Hi, I'm Maya. How can I help?", "Maya"),
    ("Hello! My name is Daniel, happy to help.", "Daniel"),
    ("Здравствуйте, я [Имя скрыто]. Слушаю вас.", operators.MASKED),
    ("Здравствуйте! Чем могу помочь?", None),
    ("Я понимаю ваше беспокойство. Сейчас проверю.", None),
    ("", None),
])
def test_extract_name(text, name):
    assert operators.extract_name(text) == name


def test_operator_of_prefers_override():
    rec = {"transcript": [{"speaker": "bot", "text": "Привет"}, {"speaker": "operator", "text": "Здравствуйте, я Лера."}]}
    assert operators.operator_of(rec) == "Лера"
    assert operators.operator_of(rec, {"operatorName": "Валерия"}) == "Валерия"
    assert operators.operator_of({"transcript": [{"speaker": "client", "text": "Алло"}]}) == operators.UNKNOWN


def test_profiles_aggregate_dialogs_per_operator():
    recs, results = [], {}
    for cid in ("sample-ru-001", "sample-ru-002", "sample-en-004"):
        rec, res = make_result(cid)
        recs.append(rec)
        results[res["key"]] = res
    results["SAMPLE:sample-ru-002"]["operatorName"] = operators.operator_of(recs[0], results["SAMPLE:sample-ru-001"])  # same person twice
    profiles = operators.profiles(recs, results)
    names = [p["name"] for p in profiles]
    assert names[0] != operators.UNKNOWN and all(p["average"] <= q["average"] for p, q in zip(profiles, profiles[1:]) if p["name"] != operators.UNKNOWN and q["name"] != operators.UNKNOWN)
    both = next(p for p in profiles if p["count"] == 2)
    assert both["average"] == scoring.round2((100.0 + 40.5) / 2) and both["min"] == 40.5 and both["max"] == 100.0
    assert both["dialogs"][0]["conversationId"] == "sample-ru-002", "weakest dialog first"
    assert both["languages"] == {"RU": 2} and both["channels"] == {"agent chat": 2}
    c1 = next(c for c in both["criteria"] if c["code"] == "01")
    assert c1["type"] == "binary" and c1["applicable"] == 2 and c1["failed"] == 1 and c1["failRate"] == 50.0
    assert both["weakest"][0]["failRate"] >= both["weakest"][-1]["failRate"]
    en = next(p for p in profiles if "sample-en-004" in [d["conversationId"] for d in p["dialogs"]])
    assert en["gross"] == 1 and en["dialogs"][0]["gross"] is True and en["dialogs"][0]["grossWhy"]
    assert operators.profiles(recs, {}) == []


# ---------- knowledge base ----------

def test_knowledge_default_save_reset(fresh_storage):
    kb = knowledge.get()
    assert len(kb["facts"]) >= 10 and all(f["id"].startswith("kb-") for f in kb["facts"])
    assert "kb-01" in knowledge.render_for_prompt(kb) and "contradicts" in knowledge.render_for_prompt(kb)
    saved = knowledge.save({"title": "Т", "facts": [{"id": "x-1", "fact": "Факт один", "topic": "Тема"}, {"fact": "  "}, {"fact": "Факт два"}]})
    assert [f["id"] for f in saved["facts"]] == ["x-1", "kb-03"], "blank facts dropped, ids filled in"
    assert knowledge.get()["title"] == "Т"
    with pytest.raises(ValueError):
        knowledge.save({"facts": [{"id": "d", "fact": "a"}, {"id": "d", "fact": "b"}]})
    with pytest.raises(ValueError):
        knowledge.save({"facts": "nope"})
    assert knowledge.render_for_prompt({"facts": []}) == ""
    assert knowledge.reset()["facts"] == kb["facts"]
    assert knowledge.get()["facts"] == kb["facts"]


def test_schema_and_validation_carry_contradictions():
    schema = evaluator.build_schema(CHAT, with_knowledge=True)
    c4 = schema["properties"]["c4"]
    assert "contradicts" in c4["properties"] and "contradicts" in c4["required"]
    assert "contradicts" not in schema["properties"]["c1"]["properties"]
    assert "contradicts" not in evaluator.build_schema(CHAT)["properties"]["c4"]["properties"]
    rec, checklist, answers = sample_answers("sample-ru-001")
    raw = json.load(open(os.path.join(replay.SAMPLE_DIR, "answers.json"), encoding="utf-8"))["sample-ru-001"]["chat-base"]
    raw = copy.deepcopy(raw)
    raw["c4"]["contradicts"] = ["kb-02", "kb-nope", 7]
    answers, problems = evaluator.validate(raw, checklist, rec, known_facts={"kb-02", "kb-03"})
    assert not problems and answers["c4"]["contradicts"] == ["kb-02"], "unknown ids are dropped, no retry"
    answers, _ = evaluator.validate(raw, checklist, rec)
    assert answers["c4"]["contradicts"] == ["7", "kb-02", "kb-nope"], "without a known list ids are kept as given"
    assert "contradicts" not in answers["c1"]
    hits = knowledge.usage({"k": {"conversationId": "sample-ru-001", "answers": answers}}, {"facts": [{"id": "kb-02", "fact": "f"}]})
    assert hits == {"kb-02": {"id": "kb-02", "dialogs": [{"conversationId": "sample-ru-001", "explanation": answers["c4"]["explanation"]}]}}


def test_prompt_includes_facts_only_with_knowledge():
    rec, checklist, _ = sample_answers("sample-ru-001")
    base = evaluator.build_prompt(rec, checklist)
    with_kb = evaluator.build_prompt(rec, checklist, knowledge.render_for_prompt())
    assert "СПРАВОЧНИК ФАКТОВ" not in str(base) and "СПРАВОЧНИК ФАКТОВ" in str(with_kb)


def test_interpretations_live_in_defaults():
    for cl in DEFAULT_CHECKLISTS:
        for c in cl["criteria"]:
            assert c["interpretation"] == INTERPRETATIONS[c["id"]] and c["interpretation"]


# ---------- printable report ----------

def test_report_renders_everything(fresh_storage):
    rec, res = make_result("sample-en-004")
    res["answers"]["c4"]["contradicts"] = ["kb-01"]
    res["appeals"] = [{"id": "1", "criterionId": "c5", "status": "accepted", "comment": "Шаблонная вежливость",
                       "decision": {"answer": "no", "reason": "Согласен"}}]
    other = copy.deepcopy(res["answers"])
    other["c7"]["answer"] = "no" if other["c7"]["answer"] == "yes" else "yes"
    second.attach(res, other, {}, {"type": "local", "model": "qwen"}, {}, NOW)
    html = report.render(rec, res, "Команда", "Alex")
    assert html.startswith("<!doctype html>") and "sample-en-004" in html
    assert "ГРУБАЯ ОШИБКА" in html
    assert "Противоречит справочнику kb-01" in html and knowledge.by_id()["kb-01"]["fact"][:20] in html
    assert "Трактовка правила" in html and INTERPRETATIONS["c1"][:30] in html
    assert "Апелляция (принята)" in html and "Согласен" in html
    assert "второе мнение (qwen)" in html
    assert "до апелляций" in html, "original total shown when an appeal changed it"
    assert "Транскрипт" in html and "<script" not in html.replace('onclick="window.print()"', "")
    assert "&lt;" not in html or "<b>" in html  # escaping happens, markup stays


# ---------- HTTP ----------

def fake_cloud(monkeypatch, flip=None):
    """A 'cloud' engine answering from demo/sample/answers.json; `flip` toggles one binary verdict."""
    answers = json.load(open(os.path.join(replay.SAMPLE_DIR, "answers.json"), encoding="utf-8"))

    def call(settings, system, messages, schema):
        cid = messages[0]["content"].split("Диалог ")[1].split(" ")[0]
        checklist_id = "call-base" if "voice call" in messages[0]["content"].split("\n")[0] else "chat-base"
        raw = copy.deepcopy(answers[cid][checklist_id])
        if flip and flip in raw:
            raw[flip]["verdict"] = "no" if raw[flip]["verdict"] == "yes" else "yes"
        if "contradicts" in schema["properties"].get("c4", {}).get("properties", {}):
            raw["c4"]["contradicts"] = ["kb-17"] if cid == "sample-ru-002" else []
        model = settings.get("cloud", {}).get("model") or "claude-test"
        return json.dumps(raw, ensure_ascii=False), {"inputTokens": 1000, "outputTokens": 300, "costUsd": 0.01}, {"type": "cloud", "model": model}

    monkeypatch.setattr(evaluator, "_call_cloud", call)


def evaluated_sample(client):
    assert client.post("/api/datasets/import", json={"groupId": "SAMPLE"}).status_code == 200
    assert client.put("/api/settings", json={"engine": "cloud", "cloud": {"apiKey": "test-key", "model": "claude-test"}}).status_code == 200
    ids = [x["conversation_id"] for x in client.get("/api/datasets/SAMPLE").get_json()]
    r = client.post("/api/evaluate", json={"groupId": "SAMPLE", "conversationIds": ids})
    assert r.status_code == 200, r.get_json()
    job = wait_job(client, r.get_json()["id"])
    assert job["failed"] == 0, job["errors"]
    return ids


def test_second_opinion_endpoint(client, monkeypatch):
    fake_cloud(monkeypatch)
    ids = evaluated_sample(client)
    fake_cloud(monkeypatch, flip="c7")
    r = client.post("/api/second-opinion", json={"groupId": "SAMPLE", "conversationIds": ["sample-ru-001", "sample-xx"]})
    assert r.status_code == 400 and "sample-xx" in r.get_json()["error"]
    r = client.post("/api/second-opinion", json={"groupId": "SAMPLE", "conversationIds": ["sample-ru-001"]})
    assert r.status_code == 200 and r.get_json()["kind"] == "second"
    job = wait_job(client, r.get_json()["id"])
    assert job["done"] == 1 and job["failed"] == 0
    res = client.get("/api/results/SAMPLE:sample-ru-001").get_json()
    assert res["secondOpinion"]["comparison"]["disagree"] == ["c7"]
    assert res["score"]["disputed"] == ["c7"] and res["score"]["total"] == 100.0, "the original score stands"
    assert res["score"]["secondOpinion"]["rate"] == 0.88
    q = client.get("/api/quality?group=SAMPLE").get_json()
    assert q["reproducibility"]["dialogs"] == 1 and q["reproducibility"]["sameEngine"] == 1
    # replay cannot give a second opinion
    assert client.put("/api/settings", json={"engine": "replay"}).status_code == 200
    assert client.post("/api/second-opinion", json={"groupId": "SAMPLE", "conversationIds": ["sample-ru-001"]}).status_code == 412


def test_quality_calibration_operators_knowledge_report_endpoints(client, monkeypatch):
    fake_cloud(monkeypatch)
    evaluated_sample(client)
    # knowledge base was used: the fake model contradicted kb-17 in sample-ru-002
    res = client.get("/api/results/SAMPLE:sample-ru-002").get_json()
    assert res["answers"]["c4"]["contradicts"] == ["kb-17"]
    kb = client.get("/api/knowledge?group=SAMPLE").get_json()
    assert kb["edited"] is False and kb["usage"]["kb-17"]["dialogs"][0]["conversationId"] == "sample-ru-002"
    r = client.put("/api/knowledge", json={"title": "Мой", "facts": [{"id": "kb-17", "fact": "Советов не даём"}]})
    assert r.status_code == 200 and r.get_json()["facts"][0]["id"] == "kb-17"
    assert client.get("/api/knowledge").get_json()["edited"] is True
    assert client.put("/api/knowledge", json={"facts": [{"id": "a", "fact": "1"}, {"id": "a", "fact": "2"}]}).status_code == 400
    assert len(client.post("/api/knowledge/reset").get_json()["facts"]) > 10

    # calibration: JSON then xlsx, then cleared
    entries = [{"conversationId": "sample-ru-001", "criterionCode": "01", "value": "Да"},
               {"conversationId": "sample-ru-002", "criterionCode": "01", "value": "Да"}]
    r = client.post("/api/quality/calibration", json={"entries": entries})
    assert r.status_code == 200 and r.get_json()["entries"] == 2
    q = client.get("/api/quality?group=SAMPLE").get_json()
    assert q["calibration"]["compared"] == 2 and q["calibration"]["agree"] == 1 and q["calibration"]["rate"] == 50.0
    assert q["patterns"]["dialogs"] == 5 and q["appeals"]["total"] == 0 and q["evaluated"] == 5
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Разметка"
    ws.append(["Диалог", "Критерий", "Итог (консенсус)"])
    ws.append(["sample-ru-001", "01 Контакт", "Да"])
    buf = io.BytesIO()
    wb.save(buf)
    r = client.post("/api/quality/calibration", data={"file": (io.BytesIO(buf.getvalue()), "Калибровка.xlsx")}, content_type="multipart/form-data")
    assert r.status_code == 200 and r.get_json()["entries"] == 1 and r.get_json()["source"] == "Калибровка.xlsx"
    r = client.post("/api/quality/calibration", data={"file": (io.BytesIO(b"not json"), "x.json")}, content_type="multipart/form-data")
    assert r.status_code == 400
    assert client.delete("/api/quality/calibration").status_code == 200
    assert client.get("/api/quality?group=SAMPLE").get_json()["calibration"]["entries"] == 0
    assert client.get("/api/quality").status_code == 400

    # operators
    ops = client.get("/api/operators?group=SAMPLE").get_json()
    assert sum(p["count"] for p in ops) == 5
    r = client.put("/api/results/SAMPLE:sample-ru-001/operator", json={"name": "Тест Тестов"})
    assert r.status_code == 200 and r.get_json()["operatorName"] == "Тест Тестов"
    assert any(p["name"] == "Тест Тестов" for p in client.get("/api/operators?group=SAMPLE").get_json())
    assert client.put("/api/results/SAMPLE:sample-ru-001/operator", json={"name": ""}).get_json().get("operatorName") is None
    assert client.put("/api/results/SAMPLE:nope/operator", json={"name": "x"}).status_code == 404

    # report
    r = client.get("/report/SAMPLE/sample-en-004")
    assert r.status_code == 200 and r.mimetype == "text/html"
    body = r.get_data(as_text=True)
    assert "ГРУБАЯ ОШИБКА" in body and "Отчёт по качеству диалога sample-en-004" in body
    assert client.get("/report/SAMPLE/nope").status_code == 404


def test_old_checklists_get_default_interpretations_on_read(fresh_storage):
    old = copy.deepcopy(DEFAULT_CHECKLISTS)
    for cl in old:
        for c in cl["criteria"]:
            c.pop("interpretation", None)
    old[0]["criteria"][0]["interpretation"] = ""          # cleared on purpose: stays empty
    old.append({"id": "custom", "name": "Свой", "channel": "agent chat", "version": 1,
                "criteria": [{"id": "c1", "code": "01", "name": "x", "type": "binary", "weight": 100}]})
    storage._write("checklists", old)
    got = {cl["id"]: cl for cl in storage.get_checklists()}
    assert got["chat-base"]["criteria"][0]["interpretation"] == ""
    assert got["chat-base"]["criteria"][1]["interpretation"] == INTERPRETATIONS["c2"]
    assert got["call-base"]["criteria"][6]["interpretation"] == INTERPRETATIONS["c7"]
    assert got["custom"]["criteria"][0]["interpretation"] == "", "only the built-in rules have team readings"


# ---------- Codex review: evidence for a clean flag, exact half-up rounding, arithmetic in check ----------

def test_clean_flag_gets_checked_operator_turns():
    rec, checklist, answers = sample_answers("sample-ru-001")
    raw = copy.deepcopy(json.load(open(os.path.join(replay.SAMPLE_DIR, "answers.json"), encoding="utf-8"))["sample-ru-001"]["chat-base"])
    raw["c8"] = {"verdict": "no", "evidence": [], "explanation": "Грубых нарушений нет.", "confidence": "high"}
    answers, problems = evaluator.validate(raw, checklist, rec)
    assert not problems
    operator_turns = [i for i, t in enumerate(rec["transcript"]) if t["speaker"] == "operator"]
    assert answers["c8"]["evidence"] == operator_turns and operator_turns
    # stored results from before the rule still export and render with the checked replies
    stored = {"answer": "no", "evidence": [], "explanation": "x"}
    assert scoring.evidence_of(stored, checklist["criteria"][7], rec) == operator_turns
    assert scoring.evidence_of({"answer": "yes", "evidence": [3]}, checklist["criteria"][7], rec) == [3]
    assert scoring.evidence_of({"answer": "no", "evidence": []}, checklist["criteria"][0], rec) == [], "only the flag gets the fallback"


def test_exported_critical_false_has_evidence_turns(client, monkeypatch):
    from cqa import export
    fake_cloud(monkeypatch)
    evaluated_sample(client)
    doc, report = export.build("SAMPLE", "Команда")
    for r in doc["results"]:
        for row in r["criteria"]:
            assert row["evidence_turns"], f'{r["conversation_id"]}: {row["criterion_id"]} without evidence'
    assert export.check(doc) == []


def test_check_catches_wrong_total_and_missing_evidence():
    from cqa import export
    rows = [{"criterion_id": e, "value": v, "rationale": "r", "evidence_turns": [1]} for e, v in
            [("contact", True), ("discovery", False), ("identification", None), ("consultation", 5), ("empathy", False), ("dialogue", 7), ("closure", False), ("critical", True)]]
    assert export.recompute_total(rows) == 31.88, "25.5 / 80 × 100 = 31.875 rounds half-up"
    doc = {"schema_version": "1.0", "team_name": "T", "model": {"mode": "external_api", "name": "m"},
           "results": [{"conversation_id": "x", "status": "ok", "criteria": rows, "score": {"final_score": 31.87, "critical_flag": True}}]}
    problems = export.check(doc)
    assert any("не сходится" in p for p in problems), problems
    doc["results"][0]["score"]["final_score"] = 31.88
    assert export.check(doc) == []
    rows[7]["evidence_turns"] = []
    assert any("evidence_turns пустой" in p for p in export.check(doc))

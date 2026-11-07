"""cqa/scoring.py against the shared fixture (the same file drives tests/scoring.test.mjs)."""
import json
import os

import pytest

from cqa import scoring

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "scoring_cases.json")
with open(FIXTURE, encoding="utf-8") as f:
    DATA = json.load(f)


@pytest.mark.parametrize("case", DATA["cases"], ids=[c["name"] for c in DATA["cases"]])
def test_score_matches_fixture(case):
    s = scoring.score(DATA["checklist"], case["answers"])
    e = case["expected"]
    assert s["total"] == e["total"]
    if "gross" in e:
        assert s["gross"] is e["gross"]
    if "grossIds" in e:
        assert s["grossIds"] == e["grossIds"]
    if "possible" in e:
        assert s["possible"] == e["possible"]
    if "earned" in e:
        assert scoring.round2(s["earned"]) == e["earned"]
    for name, pct in (e.get("sections") or {}).items():
        assert s["sections"][name]["pct"] == pct


def test_pdf_example_redistribution():
    """Checklist PDF: 03 = N/A → remaining weights 80 are stretched to 100 (×1.25); 65.5 / 80 → 81.88."""
    case = next(c for c in DATA["cases"] if c["name"] == "pdf_example_na_on_03")
    s = scoring.score(DATA["checklist"], case["answers"])
    eff = sum(p["effWeight"] for p in s["per"].values() if p.get("effWeight") is not None)
    assert scoring.round2(eff) == 100
    assert s["per"]["c1"]["effWeight"] == 12.5
    assert s["per"]["c4"]["effWeight"] == 25
    assert s["per"]["c6"]["effPoints"] == 13.13


def test_summarize_appeal_flow():
    a = DATA["appeal"]
    result = {"checklist": DATA["checklist"], "answers": a["answers"], "appeals": a["appeals"]}
    s = scoring.summarize(result)
    assert s["originalTotal"] == a["expected"]["originalTotal"]
    assert s["total"] == a["expected"]["total"]
    assert s["pending"] == a["expected"]["pending"]
    assert s["changed"] is True
    assert result["answers"]["c5"]["answer"] == "no", "original answers are never mutated"


def test_disputed_and_rounding():
    result = {"answers": {"c1": {"answer": "yes", "confidence": "high"},
                          "c2": {"answer": "no", "confidence": "low"},
                          "c3": {"answer": None, "needsReview": True}}}
    assert scoring.disputed(result) == ["c2", "c3"]
    result["secondOpinion"] = {"comparison": {"agree": ["c1"], "disagree": ["c7"], "near": ["c4", "c2"]}}
    assert scoring.disputed(result) == ["c2", "c3", "c7", "c4"], "mirrors web/js/scoring.js"
    assert scoring.round2(81.875) == 81.88
    assert scoring.round2(2.675) == 2.68
    assert scoring.round2(None) is None


def test_no_applicable_criteria_gives_no_total():
    checklist = {"criteria": [{"id": "x", "type": "binary", "weight": 100, "naAllowed": True},
                              {"id": "f", "type": "flag", "weight": 0}]}
    s = scoring.score(checklist, {"x": {"answer": "na"}, "f": {"answer": "yes"}})
    assert s["total"] is None
    assert s["gross"] is True

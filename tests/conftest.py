import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# Tests never touch the real storage/ folder or the organizers' API.
os.environ.setdefault("CQA_STORAGE_DIR", os.path.join(ROOT, ".pytest_cache", "storage-unused"))
os.environ.pop("CQA_DATA_API", None)
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("ANTHROPIC_BASE_URL", None)
os.environ.pop("CQA_LOCAL_RELAY_URL", None)
os.environ.pop("CQA_LOCAL_RELAY_TOKEN", None)
os.environ.pop("CQA_RELAY_TOKEN", None)


@pytest.fixture
def fresh_storage(tmp_path, monkeypatch):
    """Every test gets an empty storage directory."""
    from cqa import storage
    monkeypatch.setattr(storage, "ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture
def client(fresh_storage, monkeypatch):
    import server
    monkeypatch.setattr(server, "AUDIO_DIR", str(fresh_storage / "audio"))
    monkeypatch.setattr(server, "DATA_API", "")
    server.JOBS.clear()
    server.app.config["TESTING"] = True
    return server.app.test_client()


def wait_job(client, job_id, timeout=10.0):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{job_id}").get_json()
        if j["status"] == "finished":
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")

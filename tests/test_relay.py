"""Ollama relay (tools/ollama_relay.py) and the evaluator's server-side relay override.

No real Ollama and no network: the relay is started on an ephemeral port in front of
a fake upstream HTTP server.
"""
import http.client
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from cqa import evaluator

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import ollama_relay  # noqa: E402

TOKEN = "t" * 40


class FakeOllama(BaseHTTPRequestHandler):
    seen = []

    def _answer(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        FakeOllama.seen.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
        self._answer({"models": [{"name": "qwen2.5:7b"}]})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(n) or b"{}")
        FakeOllama.seen.append({"method": "POST", "path": self.path, "headers": dict(self.headers), "body": data})
        if data.get("model") == "missing":
            return self._answer({"error": "model not found"}, status=404)
        self._answer({"message": {"content": "{}"}, "prompt_eval_count": 3, "eval_count": 2})

    def log_message(self, *a):
        pass


def _serve(server):
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


@pytest.fixture
def relay():
    FakeOllama.seen = []
    upstream = _serve(ThreadingHTTPServer(("127.0.0.1", 0), FakeOllama))
    up_url = f"http://127.0.0.1:{upstream.server_address[1]}"
    server = _serve(ollama_relay.build_server(TOKEN, "127.0.0.1", 0, up_url, queue_wait=1))
    yield server.server_address[1]
    server.shutdown(); server.server_close()
    upstream.shutdown(); upstream.server_close()


def call(port, method, path, body=None, token=TOKEN, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = dict(headers or {})
    if token is not None:
        h["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        h["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=h)
    r = conn.getresponse()
    out = r.status, r.read()
    conn.close()
    return out


# ---------- relay ----------

def test_rejects_missing_and_wrong_token(relay):
    assert call(relay, "GET", "/api/tags", token=None)[0] == 401
    assert call(relay, "GET", "/api/tags", token="x" * 40)[0] == 401
    # unauthenticated callers learn nothing about routes
    assert call(relay, "POST", "/api/pull", token=None)[0] == 401
    assert FakeOllama.seen == []


def test_only_allowed_routes_and_methods(relay):
    assert call(relay, "POST", "/api/pull", {"name": "x"})[0] == 404
    assert call(relay, "DELETE", "/api/delete")[0] == 404
    assert call(relay, "GET", "/api/chat")[0] == 405
    assert call(relay, "POST", "/api/tags", {})[0] == 405
    assert call(relay, "GET", "/")[0] == 404
    assert FakeOllama.seen == []


def test_tags_and_chat_pass_through(relay):
    status, body = call(relay, "GET", "/api/tags?x=1")
    assert status == 200 and json.loads(body)["models"][0]["name"] == "qwen2.5:7b"
    status, body = call(relay, "POST", "/api/chat", {"model": "qwen2.5:7b", "messages": []})
    assert status == 200 and json.loads(body)["eval_count"] == 2
    assert [s["path"] for s in FakeOllama.seen] == ["/api/tags", "/api/chat"]
    assert FakeOllama.seen[1]["body"]["model"] == "qwen2.5:7b"


def test_client_headers_are_not_forwarded(relay):
    call(relay, "GET", "/api/tags", headers={"Origin": "https://evil.example", "Host": "evil.example",
                                              "X-Extra": "1"})
    h = {k.lower(): v for k, v in FakeOllama.seen[0]["headers"].items()}
    assert "authorization" not in h and "origin" not in h and "x-extra" not in h
    assert h["host"].startswith("127.0.0.1")


def test_upstream_error_status_is_kept(relay):
    status, body = call(relay, "POST", "/api/chat", {"model": "missing"})
    assert status == 404 and "model not found" in body.decode()


def test_body_size_limit(relay, monkeypatch):
    monkeypatch.setattr(ollama_relay, "MAX_BODY", 100)
    assert call(relay, "POST", "/api/chat", {"pad": "x" * 200})[0] == 413
    assert FakeOllama.seen == []


def test_unreachable_upstream_is_502():
    server = _serve(ollama_relay.build_server(TOKEN, "127.0.0.1", 0, "http://127.0.0.1:9", queue_wait=1))
    try:
        assert call(server.server_address[1], "GET", "/api/tags")[0] == 502
    finally:
        server.shutdown(); server.server_close()


def test_short_token_refused():
    with pytest.raises(ValueError):
        ollama_relay.build_server("short", "127.0.0.1", 0)


def test_load_token_from_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("CQA_RELAY_TOKEN", raising=False)
    f = tmp_path / ".env.relay"
    f.write_text("# comment\nCQA_RELAY_TOKEN=abc123\n", encoding="utf-8")
    assert ollama_relay.load_token(str(f)) == "abc123"
    monkeypatch.setenv("CQA_RELAY_TOKEN", "fromenv")
    assert ollama_relay.load_token(str(f)) == "fromenv"


# ---------- evaluator: server-side relay override ----------

class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code, self.text = payload, status, json.dumps(payload)

    def json(self):
        return self._p


SETTINGS = {"engine": "local", "local": {"url": "http://typed-by-visitor:11434", "model": "qwen2.5:7b"}}


def test_without_relay_env_uses_settings_url_and_no_auth(monkeypatch):
    seen = {}

    def fake_get(url, headers=None, timeout=None):
        seen.update(url=url, headers=headers)
        return FakeResp({"models": [{"name": "qwen2.5:7b"}]})

    monkeypatch.setattr(evaluator.requests, "get", fake_get)
    assert evaluator.check_engine(SETTINGS)["ok"] is True
    assert seen["url"] == "http://typed-by-visitor:11434/api/tags" and not seen["headers"]


def test_relay_env_overrides_url_and_sends_bearer(monkeypatch):
    monkeypatch.setenv("CQA_LOCAL_RELAY_URL", "https://relay.example/")
    monkeypatch.setenv("CQA_LOCAL_RELAY_TOKEN", TOKEN)
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append((url, headers))
        return FakeResp({"models": [{"name": "qwen2.5:7b"}]})

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append((url, headers))
        return FakeResp({"message": {"content": "{}"}, "prompt_eval_count": 1, "eval_count": 1})

    monkeypatch.setattr(evaluator.requests, "get", fake_get)
    monkeypatch.setattr(evaluator.requests, "post", fake_post)
    assert evaluator.check_engine(SETTINGS)["ok"] is True
    text, usage, engine = evaluator._call_local(SETTINGS, "sys", [], {})
    assert engine == {"type": "local", "model": "qwen2.5:7b"} and usage["costUsd"] == 0
    assert [u for u, _ in calls] == ["https://relay.example/api/tags", "https://relay.example/api/chat"]
    assert all(h == {"Authorization": f"Bearer {TOKEN}"} for _, h in calls)


def test_relay_token_also_read_under_relay_name(monkeypatch):
    # Railway may carry the token under the relay's own name, CQA_RELAY_TOKEN.
    monkeypatch.setenv("CQA_LOCAL_RELAY_URL", "https://relay.example")
    monkeypatch.delenv("CQA_LOCAL_RELAY_TOKEN", raising=False)
    monkeypatch.setenv("CQA_RELAY_TOKEN", TOKEN)
    assert evaluator.local_relay_enabled() is True
    url, headers = evaluator._local_target(SETTINGS)
    assert url == "https://relay.example" and headers == {"Authorization": f"Bearer {TOKEN}"}
    monkeypatch.setenv("CQA_LOCAL_RELAY_TOKEN", "x" * 40)
    assert evaluator._local_target(SETTINGS)[1] == {"Authorization": "Bearer " + "x" * 40}, "the server's own name wins"


def test_relay_errors_do_not_echo_tunnel_url(monkeypatch):
    monkeypatch.setenv("CQA_LOCAL_RELAY_URL", "https://secret-words.trycloudflare.com")
    monkeypatch.setenv("CQA_LOCAL_RELAY_TOKEN", TOKEN)

    def boom(*a, **k):
        raise evaluator.requests.ConnectionError("down")

    monkeypatch.setattr(evaluator.requests, "get", boom)
    monkeypatch.setattr(evaluator.requests, "post", boom)
    assert "trycloudflare" not in evaluator.check_engine(SETTINGS)["message"]
    with pytest.raises(evaluator.EvaluationError) as e:
        evaluator._call_local(SETTINGS, "sys", [], {})
    assert "trycloudflare" not in str(e.value)


def test_relay_rejected_token_message(monkeypatch):
    monkeypatch.setenv("CQA_LOCAL_RELAY_URL", "https://relay.example")
    monkeypatch.setenv("CQA_LOCAL_RELAY_TOKEN", TOKEN)
    monkeypatch.setattr(evaluator.requests, "get", lambda *a, **k: FakeResp({"error": "unauthorized"}, 401))
    st = evaluator.check_engine(SETTINGS)
    assert st["ok"] is False and "токен" in st["message"]


def test_public_settings_never_expose_relay(client, monkeypatch):
    monkeypatch.setenv("CQA_LOCAL_RELAY_URL", "https://secret-words.trycloudflare.com")
    monkeypatch.setenv("CQA_LOCAL_RELAY_TOKEN", TOKEN)
    r = client.put("/api/settings", json={"local": {"relay": False, "model": "qwen2.5:7b"}})
    text = r.get_data(as_text=True)
    assert r.get_json()["local"]["relay"] is True
    assert TOKEN not in text and "trycloudflare" not in text
    assert TOKEN not in client.get("/api/settings").get_data(as_text=True)


def test_proxy_env_is_ignored(relay, monkeypatch):
    # A proxy set on the PC must not capture prompts on their way to 127.0.0.1.
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("NO_PROXY", "")
    assert call(relay, "GET", "/api/tags")[0] == 200


# ---------- cloud engine: the API key never follows a settings-supplied address ----------

def test_cloud_ignores_settings_base_url(monkeypatch):
    import anthropic
    seen = {}

    class FakeClient:
        def __init__(self, api_key=None, base_url=None, **kw):
            seen.update(api_key=api_key, base_url=base_url)
            raise RuntimeError("stop before any request")

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-placeholder")
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    settings = {"engine": "cloud", "cloud": {"baseUrl": "https://attacker.example", "model": "m"}}
    with pytest.raises(RuntimeError):
        evaluator._call_cloud(settings, "sys", [], {})
    assert seen["base_url"] == "https://api.anthropic.com"
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.internal")
    with pytest.raises(RuntimeError):
        evaluator._call_cloud(settings, "sys", [], {})
    assert seen["base_url"] == "https://proxy.internal"

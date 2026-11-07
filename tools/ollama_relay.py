"""Authenticated relay in front of a local Ollama, for exposure through a tunnel.

    Railway -> https://<random>.trycloudflare.com -> this relay (127.0.0.1:11435) -> Ollama (127.0.0.1:11434)

Ollama's API has no authentication, so it must stay on localhost. This relay is the
only thing the tunnel reaches. It:
  * requires `Authorization: Bearer <token>` (constant-time comparison) on every request;
  * forwards only GET /api/tags and POST /api/chat; everything else is 404/405;
  * caps the request body, limits concurrency, and never forwards client headers
    (the upstream request carries only Content-Type, so Ollama sees Host=127.0.0.1
    and no Origin — no OLLAMA_HOST / OLLAMA_ORIGINS changes are needed);
  * logs only method, path, status and duration — never tokens, prompts or answers.

Token: env CQA_RELAY_TOKEN, or a line CQA_RELAY_TOKEN=... in `.env.relay` at the repo
root (gitignored). Generate one with `python tools/ollama_relay.py --gen-token`.

Usage:
    python tools/ollama_relay.py                       # 127.0.0.1:11435 -> http://127.0.0.1:11434
    cloudflared tunnel --url http://127.0.0.1:11435    # in another window
"""
import argparse
import hmac
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROUTES = {"/api/tags": "GET", "/api/chat": "POST"}
MAX_BODY = 2 * 1024 * 1024           # request body cap, bytes
MAX_RESPONSE = 16 * 1024 * 1024      # upstream response cap, bytes
MIN_TOKEN_LEN = 32
TOKEN_ENV = "CQA_RELAY_TOKEN"
ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.relay")


def load_token(env_file=ENV_FILE):
    token = os.environ.get(TOKEN_ENV, "").strip()
    if token:
        return token
    if os.path.exists(env_file):
        with open(env_file, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line.startswith(TOKEN_ENV + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # never follow redirects away from the local Ollama


# Ignore HTTP(S)_PROXY env vars: prompts must go straight to 127.0.0.1, never through a proxy.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def make_handler(token, upstream, slots, queue_wait, upstream_timeout):
    expected = f"Bearer {token}".encode("utf-8")
    upstream = upstream.rstrip("/")

    class Handler(BaseHTTPRequestHandler):
        server_version = "cqa-relay"
        sys_version = ""
        protocol_version = "HTTP/1.1"
        _status = 0
        _started = 0.0
        timeout = 30  # client socket reads only; the long model call uses a separate upstream connection

        # ---------- helpers ----------
        def _reply(self, status, payload, content_type="application/json"):
            body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            self.close_connection = True
            self._status = status

        def _authorized(self):
            got = (self.headers.get("Authorization") or "").encode("utf-8")
            return hmac.compare_digest(got, expected)

        def _handle(self):
            self._started = time.monotonic()
            path = urlsplit(self.path).path
            if not self._authorized():
                return self._reply(401, {"error": "unauthorized"})
            if path not in ROUTES:
                return self._reply(404, {"error": "not found"})
            if self.command != ROUTES[path]:
                return self._reply(405, {"error": "method not allowed"})

            body = None
            if self.command == "POST":
                if self.headers.get("Transfer-Encoding"):
                    return self._reply(411, {"error": "content-length required"})
                try:
                    length = int(self.headers.get("Content-Length") or "-1")
                except ValueError:
                    length = -1
                if length < 0:
                    return self._reply(411, {"error": "content-length required"})
                if length > MAX_BODY:
                    return self._reply(413, {"error": "request too large"})
                body = self.rfile.read(length)

            if not slots.acquire(timeout=queue_wait):
                return self._reply(503, {"error": "relay busy"})
            try:
                req = urllib.request.Request(upstream + path, data=body, method=self.command)
                if body is not None:
                    req.add_header("Content-Type", "application/json")
                try:
                    with _opener.open(req, timeout=upstream_timeout) as r:
                        status, data = r.status, r.read(MAX_RESPONSE + 1)
                        ctype = r.headers.get("Content-Type", "application/json")
                except urllib.error.HTTPError as e:
                    status, data = e.code, e.read(MAX_RESPONSE + 1)
                    ctype = e.headers.get("Content-Type", "application/json")
                except (urllib.error.URLError, OSError):
                    return self._reply(502, {"error": "ollama unreachable"})
            finally:
                slots.release()
            if len(data) > MAX_RESPONSE:
                return self._reply(502, {"error": "upstream response too large"})
            return self._reply(status, data, ctype)

        def do_GET(self):
            self._handle()

        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_GET

        # ---------- logging: no tokens, prompts, query strings or bodies ----------
        def log_request(self, code="-", size="-"):
            if self._started:  # only requests that reached _handle; malformed ones are not logged
                ms = int((time.monotonic() - self._started) * 1000)
                path = urlsplit(self.path or "").path[:64]
                sys.stderr.write(f"{time.strftime('%H:%M:%S')} {self.command} {path} {self._status} {ms}ms\n")

        def log_message(self, fmt, *args):
            pass

        def send_response(self, code, message=None):
            self._status = code
            super().send_response(code, message)

    return Handler


def build_server(token, host="127.0.0.1", port=11435, upstream="http://127.0.0.1:11434",
                 concurrency=1, queue_wait=60.0, upstream_timeout=900.0):
    if len(token) < MIN_TOKEN_LEN:
        raise ValueError(f"relay token must be at least {MIN_TOKEN_LEN} characters")
    slots = threading.BoundedSemaphore(concurrency)
    handler = make_handler(token, upstream, slots, queue_wait, upstream_timeout)
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main(argv=None):
    p = argparse.ArgumentParser(description="Authenticated relay in front of local Ollama")
    p.add_argument("--host", default="127.0.0.1", help="bind address (keep 127.0.0.1; the tunnel connects locally)")
    p.add_argument("--port", type=int, default=11435)
    p.add_argument("--upstream", default=os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434"))
    p.add_argument("--concurrency", type=int, default=1, help="parallel requests forwarded to Ollama")
    p.add_argument("--queue-wait", type=float, default=60.0, help="seconds a request may wait for a free slot")
    p.add_argument("--gen-token", action="store_true", help="print a new random token and exit")
    a = p.parse_args(argv)

    if a.gen_token:
        print(secrets.token_urlsafe(32))
        return 0
    token = load_token()
    if len(token) < MIN_TOKEN_LEN:
        sys.stderr.write(f"Set {TOKEN_ENV} (>= {MIN_TOKEN_LEN} chars) in the environment or in {ENV_FILE}.\n"
                         f"Generate one: python tools/ollama_relay.py --gen-token\n")
        return 2
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        sys.stderr.write("Warning: relay bound to a non-loopback address.\n")
    server = build_server(token, a.host, a.port, a.upstream, a.concurrency, a.queue_wait)
    sys.stderr.write(f"cqa-relay on http://{a.host}:{a.port} -> {a.upstream} (routes: {', '.join(ROUTES)})\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

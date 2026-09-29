"""HTTPS upstream stub for the edge test.

One process plays either the origin or the CDN (ROLE env). It records every
request it receives — method, path, headers, body and the TLS SNI name — as one
JSON line in /tmp/requests.jsonl, which the test reads with `docker exec`.

Every response carries `Alt-Svc: h3`, the way a real HTTP/3-capable upstream
advertises itself, so the test can assert the edge does not pass it on.

Routes:
  /public/<name>.bin   deterministic ASCII body ("0123456789" repeated) of the
                       size named in SIZES; honours a single `Range: bytes=a-b`
  /public/stall.bin    100000 bytes with a known length: 2000, a pause, the rest
  /public/stall-long.bin  200000 bytes: 16384, then a STALL_LONG pause, the rest
  /public/stall-unsized.bin  100000 bytes with no Content-Length, then a STALL_LONG pause
  /chat/sse            text/event-stream: one event, a pause, a second event
  anything else        200 JSON naming the role and the path
"""

import json
import os
import re
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROLE = os.environ.get("ROLE", "origin")
LOG = "/tmp/requests.jsonl"
SIZES = {"/public/probe.bin": 200_000, "/public/range.bin": 1_000}
SSE_PAUSE = float(os.environ.get("SSE_PAUSE", "3"))
STALL_LONG = float(os.environ.get("STALL_LONG", "60"))
ALT_SVC = 'h3=":443"; ma=86400'

_log_lock = threading.Lock()


def body_of(size):
    return (b"0123456789" * (size // 10 + 1))[:size]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def record(self, body):
        entry = {
            "role": ROLE,
            "method": self.command,
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body.decode("utf-8", "replace"),
            "sni": getattr(self.request, "sni_name", None),
        }
        with _log_lock, open(LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Alt-Svc", ALT_SVC)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def handle_any(self):
        body = self.read_body()
        self.record(body)
        path = self.path.split("?", 1)[0]
        if path in SIZES:
            return self.serve_blob(SIZES[path])
        if path == "/chat/sse":
            return self.serve_sse()
        if path == "/public/stall.bin":
            return self.serve_stall()
        if path == "/public/stall-long.bin":
            return self.serve_stall(size=200_000, head=16_384, pause=STALL_LONG)
        if path == "/public/stall-unsized.bin":
            return self.serve_unsized_stall()
        payload = json.dumps({"role": ROLE, "path": self.path}).encode()
        self.send(200, payload, "application/json")

    def serve_blob(self, size):
        data = body_of(size)
        m = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range", ""))
        if not m:
            return self.send(200, data, "application/octet-stream", {"Accept-Ranges": "bytes"})
        start, end = int(m.group(1)), min(int(m.group(2)), size - 1)
        self.send(206, data[start : end + 1], "application/octet-stream", {
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{size}",
        })

    def serve_stall(self, size=100_000, head=2_000, pause=SSE_PAUSE):
        data = body_of(size)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data[:head])
        self.wfile.flush()
        time.sleep(pause)
        self.wfile.write(data[head:])
        self.wfile.flush()

    def serve_unsized_stall(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body_of(100_000))
        self.wfile.flush()
        time.sleep(STALL_LONG)
        self.close_connection = True

    def serve_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Alt-Svc", ALT_SVC)
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(b"data: one\n\n")
        self.wfile.flush()
        time.sleep(SSE_PAUSE)
        self.wfile.write(b"data: two\n\n")
        self.wfile.flush()
        self.close_connection = True

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = handle_any


def remember_sni(sock, server_name, _ctx):
    sock.sni_name = server_name


def main():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain("/certs/server.pem", "/certs/server.key")
    ctx.sni_callback = remember_sni
    srv = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

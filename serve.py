#!/usr/bin/env python3
"""Run the Stock Tracker on your own computer with live Yahoo Finance data.

    python3 serve.py            # opens http://localhost:8000
    python3 serve.py --port 8080 --no-browser

Serves the app from this folder and answers /api/market?symbols=TTWO,META,^GSPC with
fresh closing prices and headlines (cached for 10 minutes; add &refresh=1 to bypass).
Standard library only, no installs needed.
"""

from __future__ import annotations

import argparse
import http.server
import json
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))

import market_data  # noqa: E402

CACHE_SECONDS = 600
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def market_payload(symbols: list[str], refresh: bool) -> dict:
    out = {"generatedAt": market_data._iso(time.time()), "source": "Yahoo Finance (live)", "symbols": {}}
    for sym in symbols:
        with _lock:
            hit = _cache.get(sym)
        if hit and not refresh and time.time() - hit[0] < CACHE_SECONDS:
            out["symbols"][sym] = hit[1]
            continue
        data = market_data.fetch_symbol(sym)
        with _lock:
            _cache[sym] = (time.time(), data)
        out["symbols"][sym] = data
    return out


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):  # noqa: N802 (stdlib naming)
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/market":
            return self._market(parsed.query)
        if any(part.startswith(".") for part in Path(parsed.path).parts):
            return self.send_error(404)
        return super().do_GET()

    def _market(self, query: str):
        qs = urllib.parse.parse_qs(query)
        raw = ",".join(qs.get("symbols", []))
        symbols = list(dict.fromkeys(s.strip().upper() for s in raw.split(",") if s.strip()))[:20]
        bad = [s for s in symbols if not market_data.SYMBOL_RE.match(s)]
        if not symbols or bad:
            return self._json(400, {"error": f"bad symbols: {', '.join(bad) or '(none)'}"})
        payload = market_payload(symbols, refresh=qs.get("refresh") == ["1"])
        return self._json(200, payload)

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))


def main() -> None:
    ap = argparse.ArgumentParser(description="Run the Stock Tracker locally.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"Stock Tracker running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

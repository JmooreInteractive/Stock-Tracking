#!/usr/bin/env python3
"""Fetch daily closing prices and Yahoo Finance headlines for the tracked tickers.

Standard library only. Used two ways:
  * GitHub Actions runs it on a schedule and publishes data/market.json with the site.
  * serve.py imports it to answer /api/market live when you run the tracker locally.

    python3 scripts/market_data.py --config tracker.config.json --out data/market.json
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
YAHOO_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
SYMBOL_RE = re.compile(r"^[A-Za-z0-9^.=\-]{1,15}$")
NEWS_LIMIT = 15


class FetchError(Exception):
    pass


def http_get(url: str, timeout: float = 15.0) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json, application/rss+xml, text/xml;q=0.9, */*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        raise FetchError(f"HTTP {exc.code} from {urllib.parse.urlsplit(url).netloc}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FetchError(f"{urllib.parse.urlsplit(url).netloc}: {exc}") from exc


# ---------------------------------------------------------------- prices


def parse_chart(payload: dict, now: float | None = None) -> dict:
    """Turn a Yahoo v8 chart response into {closes: {YYYY-MM-DD: close}, ...}.

    While the market is open, Yahoo's newest daily bar is the live price, not a close.
    That bar is reported separately as `live` and left out of `closes`.
    """
    chart = payload.get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise FetchError(err.get("description") or err.get("code") or "chart error")
    results = chart.get("result") or []
    if not results:
        raise FetchError("no chart data returned")
    res = results[0]
    meta = res.get("meta") or {}
    offset = int(meta.get("gmtoffset") or 0)
    timestamps = res.get("timestamp") or []
    quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    raw_closes = quote.get("close") or []

    closes: dict[str, float] = {}
    for ts, close in zip(timestamps, raw_closes):
        if close is None:
            continue
        day = datetime.fromtimestamp(ts + offset, tz=timezone.utc).strftime("%Y-%m-%d")
        closes[day] = round(float(close), 4)

    now = time.time() if now is None else now
    session_end = ((meta.get("currentTradingPeriod") or {}).get("regular") or {}).get("end")
    live = None
    if closes and session_end and now < float(session_end):
        last_day = max(closes)
        today = datetime.fromtimestamp(now + offset, tz=timezone.utc).strftime("%Y-%m-%d")
        if last_day == today:
            live = {"date": last_day, "price": closes.pop(last_day)}

    last_date = max(closes) if closes else None
    return {
        "name": meta.get("longName") or meta.get("shortName") or "",
        "currency": meta.get("currency") or "",
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "closes": closes,
        "lastDate": last_date,
        "lastClose": closes.get(last_date) if last_date else None,
        "live": live,
    }


def fetch_prices(symbol: str, range_: str = "3mo") -> dict:
    errors = []
    sym = urllib.parse.quote(symbol, safe="")
    for host in YAHOO_HOSTS:
        url = f"https://{host}/v8/finance/chart/{sym}?range={range_}&interval=1d&includePrePost=false"
        try:
            return parse_chart(json.loads(http_get(url)))
        except (FetchError, ValueError) as exc:
            errors.append(str(exc))
    raise FetchError("; ".join(errors))


# ---------------------------------------------------------------- news


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clean(text: str | None) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def _safe_link(link: str | None) -> str | None:
    if link and urllib.parse.urlsplit(link).scheme in ("http", "https"):
        return link
    return None


def parse_search_news(payload: dict) -> list[dict]:
    items = []
    for n in payload.get("news") or []:
        link = _safe_link(n.get("link"))
        title = _clean(n.get("title"))
        if not link or not title:
            continue
        items.append(
            {
                "title": title,
                "link": link,
                "publisher": n.get("publisher") or "",
                "published": _iso(n.get("providerPublishTime")),
                "tickers": n.get("relatedTickers") or [],
            }
        )
    return items


def parse_rss_news(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    items = []
    for item in root.iter("item"):
        link = _safe_link((item.findtext("link") or "").strip())
        title = _clean(item.findtext("title"))
        if not link or not title:
            continue
        published = None
        pub = item.findtext("pubDate")
        if pub:
            try:
                published = _iso(parsedate_to_datetime(pub).timestamp())
            except (TypeError, ValueError):
                published = None
        items.append(
            {
                "title": title,
                "link": link,
                "publisher": _clean(item.findtext("source")) or "Yahoo Finance",
                "published": published,
                "summary": _clean(item.findtext("description"))[:280],
            }
        )
    return items


def fetch_news(symbol: str, limit: int = NEWS_LIMIT) -> list[dict]:
    """Yahoo Finance headlines for one ticker: search API first, RSS feed as a backup."""
    sym = urllib.parse.quote(symbol, safe="")
    items: list[dict] = []
    errors = []
    for host in YAHOO_HOSTS:
        url = f"https://{host}/v1/finance/search?q={sym}&quotesCount=0&newsCount={limit}&enableFuzzyQuery=false"
        try:
            items = parse_search_news(json.loads(http_get(url)))
            break
        except (FetchError, ValueError) as exc:
            errors.append(str(exc))
    if len(items) < 5:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US"
        try:
            items += parse_rss_news(http_get(url))
        except (FetchError, ET.ParseError) as exc:
            errors.append(str(exc))
    if not items and errors:
        raise FetchError("; ".join(errors))
    return dedupe_news(items)[:limit]


def dedupe_news(items: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out = []
    for item in sorted(items, key=lambda i: i.get("published") or "", reverse=True):
        key = item["link"].split("?")[0].rstrip("/").lower()
        title_key = item["title"].lower()
        if key in seen or title_key in seen:
            continue
        seen.update((key, title_key))
        out.append(item)
    return out


# ---------------------------------------------------------------- bundle


def fetch_symbol(symbol: str, with_news: bool = True) -> dict:
    """Everything the tracker needs for one ticker. Failures are recorded, not raised."""
    data: dict = {"symbol": symbol, "closes": {}, "news": [], "errors": {}}
    try:
        data.update(fetch_prices(symbol))
    except FetchError as exc:
        data["errors"]["prices"] = str(exc)
    if with_news:
        try:
            data["news"] = fetch_news(symbol)
        except FetchError as exc:
            data["errors"]["news"] = str(exc)
    return data


def build_market_data(symbols: list[str], with_news: bool = True, pause: float = 0.4) -> dict:
    out = {"generatedAt": _iso(time.time()), "source": "Yahoo Finance", "symbols": {}}
    for i, sym in enumerate(symbols):
        if i and pause:
            time.sleep(pause)  # be polite; Yahoo rate-limits bursts
        out["symbols"][sym] = fetch_symbol(sym, with_news)
    return out


def symbols_from_config(path: Path) -> list[str]:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    symbols = [s["symbol"] for s in cfg.get("stocks", [])]
    if cfg.get("benchmark", {}).get("symbol"):
        symbols.append(cfg["benchmark"]["symbol"])
    bad = [s for s in symbols if not SYMBOL_RE.match(s)]
    if bad:
        raise SystemExit(f"Invalid ticker symbol(s) in {path}: {', '.join(bad)}")
    return list(dict.fromkeys(symbols))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="tracker.config.json", type=Path)
    ap.add_argument("--out", default="data/market.json", type=Path)
    ap.add_argument("--symbols", help="comma-separated tickers (overrides --config)")
    ap.add_argument("--no-news", action="store_true")
    args = ap.parse_args(argv)

    symbols = [s.strip() for s in args.symbols.split(",")] if args.symbols else symbols_from_config(args.config)
    data = build_market_data(symbols, with_news=not args.no_news)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")

    ok = 0
    for sym, d in data["symbols"].items():
        status = f"close {d.get('lastClose')} on {d.get('lastDate')}" if d.get("lastDate") else "no prices"
        print(f"{sym:>8}: {status}; {len(d['news'])} headlines" + (f"  [{d['errors']}]" if d["errors"] else ""))
        ok += bool(d.get("lastDate") or d["news"])
    print(f"Wrote {args.out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

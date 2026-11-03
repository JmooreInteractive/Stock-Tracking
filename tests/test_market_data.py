import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import market_data as md  # noqa: E402

# 2026-11-02 and 2026-11-03 regular sessions open at 09:30 EST = 14:30 UTC
NOV2 = 1793629800
NOV3 = NOV2 + 86400
NOV3_CLOSE = NOV3 + int(6.5 * 3600)


def chart(closes, session_end=NOV3_CLOSE):
    return {
        "chart": {
            "result": [
                {
                    "meta": {
                        "symbol": "TTWO",
                        "longName": "Take-Two Interactive Software, Inc.",
                        "currency": "USD",
                        "gmtoffset": -18000,
                        "currentTradingPeriod": {"regular": {"start": NOV3, "end": session_end}},
                    },
                    "timestamp": [NOV2, NOV3][: len(closes)],
                    "indicators": {"quote": [{"close": closes}]},
                }
            ],
            "error": None,
        }
    }


class ChartTests(unittest.TestCase):
    def test_after_close_all_bars_are_closes(self):
        data = md.parse_chart(chart([192.1, 194.5512]), now=NOV3_CLOSE + 600)
        self.assertEqual(data["closes"], {"2026-11-02": 192.1, "2026-11-03": 194.5512})
        self.assertEqual(data["lastDate"], "2026-11-03")
        self.assertEqual(data["lastClose"], 194.5512)
        self.assertIsNone(data["live"])
        self.assertEqual(data["name"], "Take-Two Interactive Software, Inc.")

    def test_during_session_todays_bar_is_live_not_a_close(self):
        data = md.parse_chart(chart([192.1, 193.0]), now=NOV3 + 3600)
        self.assertEqual(data["closes"], {"2026-11-02": 192.1})
        self.assertEqual(data["live"], {"date": "2026-11-03", "price": 193.0})
        self.assertEqual(data["lastDate"], "2026-11-02")

    def test_null_closes_are_skipped(self):
        data = md.parse_chart(chart([None, 194.0]), now=NOV3_CLOSE + 1)
        self.assertEqual(data["closes"], {"2026-11-03": 194.0})

    def test_error_payload_raises(self):
        with self.assertRaises(md.FetchError):
            md.parse_chart({"chart": {"result": None, "error": {"code": "Not Found", "description": "No data found"}}})


class NewsTests(unittest.TestCase):
    def test_search_api_news(self):
        payload = {
            "news": [
                {"title": "Take-Two &amp; earnings", "link": "https://finance.yahoo.com/news/a.html", "publisher": "Reuters", "providerPublishTime": NOV3, "relatedTickers": ["TTWO"]},
                {"title": "bad link", "link": "javascript:alert(1)"},
                {"title": "", "link": "https://finance.yahoo.com/news/empty.html"},
            ]
        }
        items = md.parse_search_news(payload)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "Take-Two & earnings")
        self.assertEqual(items[0]["publisher"], "Reuters")
        self.assertEqual(items[0]["published"], "2026-11-03T14:30:00Z")

    def test_rss_feed(self):
        xml = b"""<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Yahoo! Finance: TTWO News</title>
          <item><title>Gaming stocks rally</title><link>https://finance.yahoo.com/news/rally.html</link>
            <description>&lt;p&gt;Shares of video game makers rose.&lt;/p&gt;</description>
            <pubDate>Tue, 03 Nov 2026 15:00:00 +0000</pubDate></item>
        </channel></rss>"""
        items = md.parse_rss_news(xml)
        self.assertEqual(items[0]["title"], "Gaming stocks rally")
        self.assertEqual(items[0]["summary"], "Shares of video game makers rose.")
        self.assertEqual(items[0]["published"], "2026-11-03T15:00:00Z")

    def test_dedupe_keeps_newest_first(self):
        items = md.dedupe_news(
            [
                {"title": "Old", "link": "https://x.com/1", "published": "2026-11-01T00:00:00Z"},
                {"title": "New", "link": "https://x.com/2", "published": "2026-11-03T00:00:00Z"},
                {"title": "Old copy", "link": "https://x.com/1?utm=rss", "published": "2026-11-01T00:00:00Z"},
            ]
        )
        self.assertEqual([i["title"] for i in items], ["New", "Old"])

    def test_news_falls_back_to_rss_when_search_fails(self):
        rss = b"<rss><channel><item><title>T</title><link>https://finance.yahoo.com/news/t.html</link></item></channel></rss>"

        def fake_get(url, timeout=15):
            if "search" in url:
                raise md.FetchError("HTTP 429")
            return rss

        with mock.patch.object(md, "http_get", side_effect=fake_get):
            self.assertEqual([i["title"] for i in md.fetch_news("TTWO")], ["T"])


class BundleTests(unittest.TestCase):
    def test_failures_are_recorded_not_raised(self):
        with mock.patch.object(md, "http_get", side_effect=md.FetchError("HTTP 403")):
            data = md.build_market_data(["TTWO"], pause=0)
        sym = data["symbols"]["TTWO"]
        self.assertEqual(sym["closes"], {})
        self.assertIn("prices", sym["errors"])
        self.assertIn("news", sym["errors"])

    def test_symbols_from_config(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(md.symbols_from_config(root / "tracker.config.json"), ["TTWO", "SKYD", "META", "^GSPC"])
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "c.json"
            bad.write_text(json.dumps({"stocks": [{"symbol": "TT WO"}]}))
            with self.assertRaises(SystemExit):
                md.symbols_from_config(bad)


if __name__ == "__main__":
    unittest.main()

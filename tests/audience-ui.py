"""Run: python tests/audience-ui.py [url]. Requires Playwright and Chrome.

Uses isolated browser storage, demo data and a fake LIVE API. Does not join TikTok.
"""

import json
import sys
import unicodedata
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


def normalized(value):
    return "".join(char for char in unicodedata.normalize("NFD", value) if not unicodedata.combining(char)).lower().replace("đ", "d")


url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001"
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
        localStorage.setItem('livelens.mode', 'demo');
        window.testToneStarts = 0;
        window.testAudioPeak = 0;
        const NativeAudio = window.AudioContext;
        window.AudioContext = class extends NativeAudio {
            createOscillator() {
                const oscillator = super.createOscillator();
                const start = oscillator.start.bind(oscillator);
                oscillator.start = (...args) => { window.testToneStarts++; return start(...args); };
                return oscillator;
            }
            createGain() {
                const gain = super.createGain();
                const analyser = this.createAnalyser();
                analyser.fftSize = 256;
                gain.connect(analyser);
                const samples = new Float32Array(analyser.fftSize);
                let remaining = 80;
                function sample() {
                    analyser.getFloatTimeDomainData(samples);
                    window.testAudioPeak = Math.max(window.testAudioPeak, ...samples.map(Math.abs));
                    if (--remaining > 0) requestAnimationFrame(sample);
                }
                requestAnimationFrame(sample);
                return gain;
            }
        };
    """)
    page.goto(url + "/#alerts")
    page.get_by_role("button", name="Nghe thử", exact=True).click()
    page.wait_for_function("window.testAudioPeak > 0.01")
    assert page.evaluate("window.testToneStarts") == 1
    page.get_by_role("button", name="Bật báo mọi bình luận", exact=True).click()
    preferences = page.evaluate("JSON.parse(localStorage.getItem('livelens.preferences.v1'))")
    assert preferences["commentAlerts"] and preferences["sound"] and preferences["keywords"] == []
    page.locator('.navigation a[href="#overview"]').click()
    page.get_by_role("button", name="Chạy demo", exact=True).click()
    before = page.evaluate("window.testToneStarts")
    page.wait_for_function("count => window.testToneStarts > count", arg=before)
    page.get_by_role("button", name="Dừng theo dõi", exact=True).click()
    expect(page.locator(".audience-current > strong")).to_have_text("156")
    page.get_by_role("button", name="Xem người xem", exact=True).click()
    expect(page.locator(".viewer-table tbody tr")).to_have_count(6)
    expect(page.locator(".audience-chart svg")).to_be_visible()
    assert page.locator('.audience-dialog').evaluate('el => el.getBoundingClientRect().width') > 1000
    assert page.locator('.viewer-table td').first.evaluate('el => el.getBoundingClientRect().width') >= 200
    page.get_by_role("searchbox", name="Tìm người xem", exact=True).fill("linh chi")
    expect(page.locator(".viewer-table tbody tr")).to_have_count(1)
    page.locator(".viewer-name").click()
    expect(page.locator(".viewer-detail h3")).to_have_text("Linh Chi")
    assert page.locator(".viewer-event-list li").count() >= 3
    page.get_by_role("button", name="Danh sách người xem", exact=True).click()
    with page.expect_download() as exported:
        page.get_by_role("button", name="Xuất CSV người xem", exact=True).click()
    assert "viewers-demo" in exported.value.suggested_filename
    with open(exported.value.path(), encoding="utf-8-sig") as stream:
        assert len(stream.read().splitlines()) == 7
    for width, height in [(390, 844), (320, 740), (768, 1024)]:
        page.set_viewport_size({"width": width, "height": height})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), width
        assert page.locator(".audience-dialog").evaluate("el => el.scrollWidth <= el.clientWidth"), width
    page.locator(".dialog-heading button").click()
    page.close()

    live = browser.new_page(viewport={"width": 1440, "height": 900})
    live.on("pageerror", lambda error: errors.append(str(error)))
    live.clock.install()
    live.add_init_script("localStorage.setItem('livelens.mode', 'live')")
    session = {"id": "bcaa21f1-545a-4639-af67-32499211d328", "uniqueId": "audience_test", "roomId": "test-room", "mode": "live", "status": "connected", "createdAt": "2026-11-26T01:00:00Z", "endedAt": None, "lastEventAt": None, "error": None, "stats": {"comments": 350, "gifts": 5, "gifters": 1, "events": 350}}
    timestamp = "2026-11-26T01:01:00Z"
    viewers = [{"user": {"id": str(index), "username": f"viewer_{index}", "nickname": "Áo Trắng" if index == 60 else f"Người {index}"}, "comments": index, "gifts": 5 if index == 60 else 0, "likes": index * 2, "joins": 1, "follows": 0, "shares": 0, "firstSeen": timestamp, "lastSeen": timestamp} for index in range(61)]
    state = {"count": 25}

    def api(route):
        parsed = urlparse(route.request.url)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/live-sessions":
            data = {"sessions": [session]}
        elif parsed.path.endswith("/audience"):
            search = normalized(query.get("search", [""])[0])
            kind = query.get("filter", ["all"])[0]
            selected = [viewer for viewer in viewers if search in normalized(viewer["user"]["nickname"] + " " + viewer["user"]["username"]) and (kind == "all" or (kind == "chat" and viewer["comments"] > 0) or (kind == "gift" and viewer["gifts"] > 0))]
            sort = query.get("sort", ["recent"])[0]
            if sort != "recent":
                selected.sort(key=lambda viewer: -viewer[sort])
            offset = int(query.get("offset", ["0"])[0])
            data = {"currentViewers": state["count"], "peakViewers": state["count"], "updatedAt": live.evaluate("new Date().toISOString()"), "totalLikes": 500, "viewers": selected[offset:offset + 50], "samples": [{"seq": 1, "timestamp": timestamp, "count": 25}, {"seq": 2, "timestamp": "2026-11-26T01:02:00Z", "count": state["count"]}], "knownViewers": 61, "joins": 61, "likes": 500, "follows": 0, "shares": 0, "total": len(selected), "offset": offset, "hasMore": offset + 50 < len(selected)}
        elif parsed.path.endswith("/history"):
            user = viewers[60]["user"]
            before = int(query.get("before", ["1000000"])[0])
            events = [{"id": str(index), "seq": index, "sessionId": session["id"], "type": "chat", "timestamp": timestamp, "user": user, "comment": f"Tin {index}"} for index in range(1, 351) if index < before] if query.get("userId") == ["60"] else []
            data = {"events": events[-300:], "nextCursor": 350, "hasMore": len(events) > 300}
        elif parsed.path.endswith("/events"):
            route.fulfill(status=200, content_type="text/event-stream", body=": closed\n\n")
            return
        else:
            data = {"session": session}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(data))

    live.route("**/api/**", api)
    live.goto(url)
    expect(live.locator(".audience-current > strong")).to_have_text("25")
    state["count"] = 42
    live.clock.run_for(5100)
    expect(live.locator(".audience-current > strong")).to_have_text("42")
    live.get_by_role("button", name="Xem người xem", exact=True).click()
    expect(live.locator(".viewer-table tbody tr")).to_have_count(50)
    live.get_by_role("button", name="Tiếp", exact=True).click()
    expect(live.locator(".viewer-table tbody tr")).to_have_count(11)
    live.get_by_role("searchbox", name="Tìm người xem", exact=True).fill("ao trang")
    live.clock.run_for(300)
    expect(live.locator(".viewer-table tbody tr")).to_have_count(1)
    live.get_by_role("combobox", name="Lọc người xem").select_option("gift")
    live.clock.run_for(300)
    expect(live.locator(".viewer-table tbody tr")).to_have_count(1)
    live.locator(".viewer-name").click()
    live.clock.run_for(1)
    expect(live.locator(".viewer-event-list li")).to_have_count(300)
    live.get_by_role("button", name="Tải tương tác cũ hơn", exact=True).click()
    expect(live.locator(".viewer-event-list li")).to_have_count(350)
    assert not errors, errors
    browser.close()
    print("Audience UI passed: demo and LIVE stats, chart, full-session viewer search, pagination, per-user history, CSV, mobile layout, real Web Audio signal, and automatic comment sound.")

"""Regression checks for saved history, session discovery, sound and connection settings.

Run: python tests/functional-ui.py [url]. Requires Playwright and Chrome.
The browser uses a fake API; no TikTok room or application data is changed.
"""

import json
import sys
import unicodedata
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


def normalized(value):
    return "".join(c for c in unicodedata.normalize("NFD", value) if not unicodedata.combining(c)).lower().replace("đ", "d")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.clock.install()
    page.add_init_script("""
        localStorage.setItem('livelens.mode', 'live');
        localStorage.setItem('livelens.preferences.v1', JSON.stringify({sound: true, desktop: false, giftAlerts: true, commentAlerts: false, keywords: ['giá']}));
        window.auditSounds = 0;
        window.AudioContext = class {
            state = 'suspended'; currentTime = 0; destination = {};
            constructor() { window.auditAudio = this; }
            async resume() { this.state = 'running'; }
            createOscillator() {
                return {frequency: {setValueAtTime(){}, exponentialRampToValueAtTime(){}}, connect(node){return node}, start(){window.auditSounds++}, stop(){}};
            }
            createGain() { return {gain: {setValueAtTime(){}, exponentialRampToValueAtTime(){}}, connect(){}}; }
        };
    """)
    session = {"id": "bcaa21f1-545a-4639-af67-32499211d328", "uniqueId": "regression_host", "roomId": "test-room", "mode": "live", "status": "connected", "createdAt": "2026-11-26T01:00:00Z", "endedAt": None, "lastEventAt": None, "error": None, "stats": {"comments": 650, "gifts": 0, "gifters": 0, "events": 650}}
    events = [{"id": str(index), "seq": index, "sessionId": session["id"], "type": "chat", "timestamp": "2026-11-26T01:01:00Z", "user": {"id": "viewer", "username": "test_viewer", "nickname": "Người xem"}, "comment": "Áo trắng đầu phiên" if index == 1 else f"Bình luận {index}"} for index in range(1, 651)]
    state = {"active": False, "list_requests": 0, "fail_older": True}
    streams = []
    health_requests = []

    def api(route):
        url = urlparse(route.request.url)
        query = parse_qs(url.query)
        if url.path == "/api/health":
            health_requests.append(route)
            return
        if url.path == "/api/live-sessions":
            state["list_requests"] += 1
            body = {"sessions": [session] if state["active"] else []}
        elif url.path.endswith("/audience"):
            body = {"currentViewers": None, "peakViewers": None, "updatedAt": None, "totalLikes": None, "viewers": [], "samples": [], "knownViewers": 0, "joins": 0, "likes": 0, "follows": 0, "shares": 0, "total": 0, "offset": 0, "hasMore": False}
        elif url.path.endswith("/history"):
            if "before" in query and state["fail_older"]:
                state["fail_older"] = False
                route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Không tải được tin cũ. Thử lại."}))
                return
            before = int(query.get("before", [str(10**9)])[0])
            search = normalized(query.get("search", [""])[0])
            kind = query.get("type", ["all"])[0]
            matches = [event for event in events if event["seq"] < before and (kind == "all" or (kind == "chat" and event["type"] == "chat") or (kind == "gift" and "gift" in event)) and search in normalized(" ".join([event.get("comment", ""), event["user"]["nickname"], event["user"]["username"], event.get("gift", {}).get("name", "")]))]
            body = {"events": matches[-300:], "hasMore": len(matches) > 300, "nextCursor": matches[-1]["seq"] if matches else 0}
        elif url.path.endswith("/events"):
            streams.append(route)
            return
        else:
            body = {"session": session}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    page.route("**/api/**", api)
    page.goto(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001")
    action = page.locator(".connection-form > button[type=submit]")
    expect(action).to_have_text("Theo dõi")
    state["active"] = True
    page.clock.run_for(5100)
    expect(action).to_have_text("Dừng theo dõi")
    expect(page.locator(".feed-comment")).to_have_count(300)
    assert state["list_requests"] >= 2
    assert len(streams) == 1
    streams.pop().fulfill(status=200, content_type="text/event-stream", body=": closed\n\n")
    page.reload()
    expect(action).to_have_text("Dừng theo dõi")
    expect(page.locator(".feed-comment")).to_have_count(300)
    expect(page.locator('.comment-sound-controls')).to_contain_text('báo bình luận đang tắt')
    page.get_by_role("button", name="Bật báo mọi bình luận", exact=True).click()
    preferences = page.evaluate("JSON.parse(localStorage.getItem('livelens.preferences.v1'))")
    assert preferences['sound'] and preferences['commentAlerts'] and preferences['keywords'] == []
    expect(page.locator('.comment-sound-controls')).to_contain_text('Đã bật âm báo mọi bình luận mới')
    assert page.evaluate('window.auditSounds') == 1

    feed = page.locator(".feed-scroll")
    feed.evaluate("el => { el.scrollTop = 1000; }")
    anchor = feed.evaluate("el => [...el.querySelectorAll('li')].find(row => row.getBoundingClientRect().top >= el.getBoundingClientRect().top)?.textContent")
    page.get_by_role("button", name="Tải tin cũ hơn", exact=True).click()
    expect(page.locator(".activity-panel .error-notice")).to_contain_text("Không tải được tin cũ")
    expect(page.locator(".feed-comment")).to_have_count(300)
    page.get_by_role("button", name="Tải tin cũ hơn", exact=True).click()
    expect(page.locator(".feed-comment")).to_have_count(600)
    assert anchor == feed.evaluate("el => [...el.querySelectorAll('li')].find(row => row.getBoundingClientRect().top >= el.getBoundingClientRect().top)?.textContent")
    page.get_by_role("button", name="Tải tin cũ hơn", exact=True).click()
    expect(page.locator(".feed-comment")).to_have_count(650)
    expect(page.get_by_role("button", name="Tải tin cũ hơn", exact=True)).to_have_count(0)

    search = page.get_by_role("searchbox")
    search.fill("ao trang dau phien")
    page.clock.run_for(300)
    expect(page.locator(".feed-comment")).to_have_count(1)
    expect(page.locator(".comment-text")).to_have_text("Áo trắng đầu phiên")
    search.fill("no result")
    search.fill("Bình luận 650")
    page.clock.run_for(300)
    expect(page.locator(".comment-text")).to_have_text("Bình luận 650")
    search.fill("")
    page.clock.run_for(1)
    expect(page.locator(".feed-comment")).to_have_count(300)

    chat = {**events[-1], 'id': 'chat-651', 'seq': 651, 'comment': 'Bình luận LIVE mới'}
    events.append(chat)
    streams.pop(0).fulfill(status=200, content_type='text/event-stream', body='id: 651\nevent: event\ndata: ' + json.dumps(chat) + '\n\n')
    expect(page.locator('.comment-text').last).to_have_text(chat['comment'])
    assert page.evaluate('window.auditSounds') == 2
    expect(page.locator('.connection-card .error-notice')).to_contain_text('Đang kết nối lại luồng sự kiện')
    with page.expect_request(lambda request: '/events?' in request.url):
        page.clock.run_for(11000)
    assert len(streams) == 1
    assert page.evaluate('window.auditSounds') == 2  # Saved snapshots must not replay sound.

    page.evaluate("window.auditAudio.state = 'suspended'")
    blocked = {**chat, 'id': 'chat-652', 'seq': 652, 'comment': 'Bình luận khi âm thanh bị tạm ngưng'}
    events.append(blocked)
    streams.pop(0).fulfill(status=200, content_type='text/event-stream', body='id: 652\nevent: event\ndata: ' + json.dumps(blocked) + '\n\n')
    expect(page.get_by_role('button', name='Bật âm báo', exact=True)).to_be_visible()
    assert page.evaluate('window.auditSounds') == 2
    page.get_by_role('button', name='Bật âm báo', exact=True).click()
    expect(page.locator('.comment-sound-controls')).to_contain_text('Đã bật âm báo mọi bình luận mới')
    assert page.evaluate('window.auditSounds') == 3
    expect(page.locator('.connection-card .error-notice')).to_contain_text('Đang kết nối lại luồng sự kiện')
    with page.expect_request(lambda request: '/events?' in request.url):
        page.clock.run_for(11000)
    assert len(streams) == 1
    assert page.evaluate('window.auditSounds') == 3

    gift = {"id": "gift-653", "seq": 653, "sessionId": session["id"], "type": "gift.completed", "timestamp": "2026-11-26T01:02:00Z", "user": {"id": "gifter", "username": "test_gifter", "nickname": "Người tặng"}, "gift": {"id": "rose", "name": "Hoa hồng", "quantity": 1, "streakId": "test-streak", "isFinal": True}}
    events.append(gift)
    streams.pop(0).fulfill(status=200, content_type="text/event-stream", body="id: 653\nevent: event\ndata: " + json.dumps(gift) + "\n\n")
    expect(page.locator(".gift-list li")).to_have_count(1)
    assert page.evaluate("window.auditSounds") == 4
    expect(page.locator(".feed-comment")).to_have_count(300)

    page.locator('a[href="#settings"]').click()
    page.locator(".settings-card button").first.click()
    origin = page.locator("#server-url")
    origin.fill("http://localhost:3002")
    page.locator(".dialog-actions > button").first.click()
    expect(origin).to_be_disabled()
    expect(page.locator("#server-token")).to_be_disabled()
    expect(page.locator(".dialog-actions button[type=submit]")).to_be_disabled()
    assert len(health_requests) == 1
    health_requests.pop().fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "version": "1.0.0", "storage": "sqlite", "authRequired": False}))
    expect(page.locator(".dialog .success-text")).to_be_visible()
    expect(origin).to_be_enabled()
    origin.fill("https://untested.invalid")
    expect(page.locator(".dialog .success-text")).to_have_count(0)
    page.locator(".dialog-heading button").click()

    session["status"] = "error"
    session["endedAt"] = "2026-11-26T01:03:00Z"
    session["error"] = "Không thể lưu dữ liệu phiên. Đã dừng nhận sự kiện."
    page.clock.run_for(5100)
    page.locator('.navigation a[href="#overview"]').click()
    expect(page.locator(".connection-card .error-notice")).to_contain_text("Không thể lưu dữ liệu")
    expect(page.locator(".connection-card .status-pill")).to_have_class("status-pill status-error")
    page.locator('.navigation a[href="#history"]').click()
    page.locator(".history-row").first.click()
    page.get_by_role("searchbox").fill("ao trang dau phien")
    page.clock.run_for(300)
    expect(page.locator(".comment-text")).to_have_text("Áo trắng đầu phiên")

    for route in streams:
        route.fulfill(status=200, content_type="text/event-stream", body=": closed\n\n")
    assert not errors, errors
    browser.close()
    print("Functional UI passed: session discovery, search, history pagination, enabling comment alerts from saved disabled settings, LIVE chat and gift sound, visible suspended audio and recovery without replay, stable settings test, and visible storage failure.")

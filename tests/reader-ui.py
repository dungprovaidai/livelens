"""Run against a running app: python tests/reader-ui.py [url]. Requires Playwright and Chrome."""

import json
import sys

from playwright.sync_api import expect, sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.clock.install()
    page.goto(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001")

    expect(page.get_by_role("button", name="Bình luận", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(page.locator(".feed-comment")).to_have_count(6)
    expect(page.locator(".feed-gift")).to_have_count(0)
    comment = page.locator(".comment-text").first
    assert comment.evaluate("el => getComputedStyle(el).fontSize") == "22px"
    assert page.locator(".activity-panel").bounding_box()["height"] > 600
    assert page.evaluate("document.documentElement.scrollHeight <= innerHeight")

    increase = page.get_by_role("button", name="Tăng cỡ chữ bình luận")
    decrease = page.get_by_role("button", name="Giảm cỡ chữ bình luận")
    increase.click()
    page.reload()
    assert comment.evaluate("el => getComputedStyle(el).fontSize") == "26px"
    increase.click()
    expect(increase).to_be_disabled()
    for _ in range(3):
        decrease.click()
    expect(decrease).to_be_disabled()
    increase.click()

    search = page.get_by_role("searchbox", name="Tìm theo nội dung hoặc tài khoản")
    search.fill("mau trang")
    expect(page.locator(".feed-comment")).to_have_count(1)
    expect(comment).to_contain_text("màu trắng")
    search.fill("")

    page.get_by_role("button", name="Chạy demo", exact=True).click()
    page.clock.run_for(29_000)
    feed = page.locator(".feed-scroll")
    assert feed.evaluate("el => el.scrollHeight - el.scrollTop - el.clientHeight") < 3
    feed.evaluate("el => { el.scrollTop = 0; }")
    expect(page.get_by_role("button", name="Tiếp tục cuộn tự động")).to_be_visible()
    before = feed.evaluate("el => el.scrollTop")
    page.clock.run_for(14_500)
    assert feed.evaluate("el => el.scrollTop") == before
    expect(page.locator(".feed-jump")).to_contain_text("tin mới")
    page.locator(".feed-jump").click()
    assert feed.evaluate("el => el.scrollHeight - el.scrollTop - el.clientHeight") < 3
    expect(page.get_by_role("button", name="Tạm dừng cuộn tự động")).to_be_visible()

    page.get_by_role("button", name="Đọc toàn màn hình", exact=True).click()
    page.wait_for_function("document.fullscreenElement !== null")
    assert page.locator(".activity-panel").bounding_box()["height"] == 900
    page.get_by_role("button", name="Thoát toàn màn hình", exact=True).click()
    page.wait_for_function("document.fullscreenElement === null")
    page.get_by_role("button", name="Dừng theo dõi", exact=True).click()

    records = page.evaluate("JSON.parse(localStorage.getItem('livelens.demo.v1'))")
    last = records[0]["events"][-1]
    text = '<img src=x onerror="window.readerInjected=true">\n' + "Bình luận dài có dấu 👋 " * 30
    records[0]["events"].append({**last, "id": "reader-long-comment", "seq": last["seq"] + 1, "type": "chat", "gift": None, "comment": text})
    page.evaluate("records => localStorage.setItem('livelens.demo.v1', records)", json.dumps(records))
    page.reload()
    expect(page.locator(".comment-text").last).to_have_text(text)
    expect(page.locator(".feed-scroll img")).to_have_count(0)
    assert page.evaluate("window.readerInjected") is None

    for width, height in [(1280, 800), (1024, 768), (768, 1024), (390, 844), (320, 740)]:
        page.set_viewport_size({"width": width, "height": height})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Horizontal overflow at {width}px"
        assert comment.evaluate("el => getComputedStyle(el).fontSize") == "22px"
        expect(page.get_by_role("button", name="Đọc toàn màn hình", exact=True)).to_be_visible()

    page.set_viewport_size({"width": 1440, "height": 900})
    page.get_by_role("link", name="Lịch sử phiên", exact=True).click()
    page.locator(".history-row").first.click()
    expect(page.get_by_role("heading", name="Luồng bình luận")).to_be_visible()
    page.get_by_role("button", name="Quà tặng", exact=True).click()
    assert page.locator(".feed-gift").count() > 0
    expect(page.locator(".feed-comment")).to_have_count(0)
    page.get_by_role("button", name="Tất cả", exact=True).click()
    assert page.locator(".feed-comment").count() > 0
    with page.expect_download() as download:
        page.get_by_role("button", name="Xuất CSV", exact=True).click()
    assert download.value.suggested_filename.endswith(".csv")
    assert not errors, errors
    browser.close()
    print("Reader UI passed: filters, font persistence and limits, scroll pause/resume, new messages, fullscreen, safe wrapping, 5 viewport sizes, history, CSV, and no browser errors.")

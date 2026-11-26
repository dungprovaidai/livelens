"""Run: python tests/notifications-ui.py [url]. Requires Playwright and Chrome.

Uses an isolated browser, native desktop notifications and a fake LIVE API.
Does not connect to TikTok or change the user's browser permissions/storage.
"""

import json
import sys
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3001'
session = {'id': 'bcaa21f1-545a-4639-af67-32499211d328', 'uniqueId': 'notification_test', 'roomId': 'test-room', 'mode': 'live', 'status': 'connected', 'createdAt': '2026-11-26T01:00:00Z', 'endedAt': None, 'lastEventAt': None, 'error': None, 'stats': {'comments': 1, 'gifts': 0, 'gifters': 0, 'events': 1}}
events = [{'id': 'chat-1', 'seq': 1, 'sessionId': session['id'], 'type': 'chat', 'timestamp': '2026-11-26T01:01:00Z', 'user': {'id': 'viewer', 'username': 'linhchi', 'nickname': 'Linh Chi'}, 'comment': 'Tin đã lưu trước khi mở trang'}]
streams = []


def api(route):
    path = urlparse(route.request.url).path
    if path == '/api/live-sessions':
        body = {'sessions': [session]}
    elif path.endswith('/history'):
        body = {'events': events[-300:], 'nextCursor': events[-1]['seq'], 'hasMore': False}
    elif path.endswith('/events'):
        streams.append(route)
        return
    elif path.endswith('/audience'):
        body = {'currentViewers': None, 'peakViewers': None, 'updatedAt': None, 'totalLikes': None, 'viewers': [], 'samples': [], 'knownViewers': 0, 'joins': 0, 'likes': 0, 'follows': 0, 'shares': 0, 'total': 0, 'offset': 0, 'hasMore': False}
    else:
        body = {'session': session}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(body))


def send_comment(text):
    event = {**events[0], 'id': f'chat-{len(events) + 1}', 'seq': len(events) + 1, 'comment': text}
    events.append(event)
    streams.pop(0).fulfill(status=200, content_type='text/event-stream', body=f"id: {event['seq']}\nevent: event\ndata: {json.dumps(event)}\n\n")


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(permissions=['notifications'], viewport={'width': 1440, 'height': 900})
    page = context.new_page()
    cdp = context.new_cdp_session(page)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install()
    page.add_init_script("""
        localStorage.setItem('livelens.mode', 'live');
        localStorage.setItem('livelens.preferences.v1', JSON.stringify({sound: false, desktop: false, giftAlerts: true, commentAlerts: false, keywords: ['gia']}));
        window.deliveredNotifications = [];
        window.liveNotifications = [];
        window.Notification = new Proxy(window.Notification, {
            construct(target, args) {
                const notification = Reflect.construct(target, args);
                window.deliveredNotifications.push({title: notification.title, body: notification.body, tag: notification.tag});
                window.liveNotifications.push(notification);
                return notification;
            }
        });
    """)
    page.route('**/api/**', api)
    page.goto(url)
    expect(page.locator('.feed-comment')).to_have_count(1)
    assert page.evaluate('window.deliveredNotifications.length') == 0
    page.get_by_role('button', name='Bật thông báo bình luận', exact=True).click()
    expect(page.get_by_role('button', name='Tắt thông báo màn hình', exact=True)).to_be_visible()
    preferences = page.evaluate("JSON.parse(localStorage.getItem('livelens.preferences.v1'))")
    assert preferences['desktop'] and preferences['commentAlerts'] and preferences['keywords'] == []
    assert not preferences['sound'] and preferences['giftAlerts']

    send_comment('Tin mới khi đang đọc LiveLens')
    expect(page.locator('.comment-text').last).to_have_text(events[-1]['comment'])
    assert page.evaluate('window.deliveredNotifications.length') == 0
    expect(page.locator('.connection-card .error-notice')).to_contain_text('Đang kết nối lại luồng sự kiện')
    with page.expect_request(lambda request: '/events?' in request.url):
        page.clock.run_for(11000)
    assert len(streams) == 1

    other = context.new_page()
    other.goto('about:blank')
    other.bring_to_front()
    # Headless Chrome otherwise forces every tab to report focus.
    cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': False})
    page.wait_for_function("document.visibilityState === 'hidden' || !document.hasFocus()")
    send_comment('Áo trắng này giá bao nhiêu?')
    page.wait_for_function('window.deliveredNotifications.length === 1')
    notification = page.evaluate('window.deliveredNotifications[0]')
    assert notification['title'] == 'Linh Chi bình luận · LiveLens', notification
    assert notification['body'] == 'Áo trắng này giá bao nhiêu?', notification
    assert notification['tag'] == f"livelens:{session['id']}:chat-3"
    expect(page.locator('.connection-card .error-notice')).to_contain_text('Đang kết nối lại luồng sự kiện')
    with page.expect_request(lambda request: '/events?' in request.url):
        page.clock.run_for(11000)
    assert page.evaluate('window.deliveredNotifications.length') == 1
    page.bring_to_front()
    cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
    page.get_by_role('button', name='Tắt thông báo màn hình', exact=True).click()
    other.bring_to_front()
    cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': False})
    page.wait_for_function("document.visibilityState === 'hidden' || !document.hasFocus()")
    send_comment('Tin khi đã tắt thông báo')
    expect(page.locator('.comment-text').last).to_have_text(events[-1]['comment'])
    assert page.evaluate('window.deliveredNotifications.length') == 1

    page.bring_to_front()
    cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
    for width in [390, 320]:
        page.set_viewport_size({'width': width, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        expect(page.get_by_role('button', name='Bật thông báo bình luận', exact=True)).to_be_visible()
    page.evaluate("Notification.requestPermission = async () => 'denied'")
    page.get_by_role('button', name='Bật thông báo bình luận', exact=True).click()
    expect(page.locator('.comment-desktop-controls')).to_contain_text('Chưa được cấp quyền')
    assert not page.evaluate("JSON.parse(localStorage.getItem('livelens.preferences.v1')).desktop")
    page.evaluate('window.liveNotifications.forEach(notification => notification.close())')
    for route in streams:
        route.fulfill(status=200, content_type='text/event-stream', body=': closed\n\n')
    assert not errors, errors
    browser.close()
    print('Notifications UI passed: native Chrome notifications with commenter and text in another tab, foreground suppression, no history replay, saved preferences, disable, denied permission and mobile layout. LIVE API was simulated.')

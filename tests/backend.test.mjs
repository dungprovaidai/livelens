import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadConfig } from '../server/config.mjs';
import { createApp } from '../server/http.mjs';
import { createTikTokFactory, SessionManager } from '../server/manager.mjs';
import { createStore } from '../server/store.mjs';
import { normalizeAudience, normalizeChat } from '../server/normalize.mjs';

const allowedOrigin = 'https://dashboard.example';
const token = 'a temporary token kept in the test';
const auth = { Authorization: `Bearer ${token}` };

class TestConnection extends EventEmitter {
  constructor(connect = async () => ({ roomId: '9576211122334455667' })) {
    super();
    this.connect = connect;
  }

  async disconnect() {
    this.emit('disconnected');
  }
}

async function service(t, { sqlitePath = ':memory:', connectorFactory, config = {}, reconnectDelays } = {}) {
  const store = await createStore({ sqlitePath });
  const connection = new TestConnection();
  const manager = new SessionManager({
    store,
    connectorFactory: connectorFactory ?? (() => connection),
    reconnectDelays,
  });
  await manager.recover();
  const server = createApp({ store, manager, config: { ...loadConfig({}), ...config } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await manager.close();
    await store.close();
  };
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, request: (path, options) => fetch(base + '/api' + path, options), connection, close, store, manager };
}

const startOptions = (url = '@viewer_host', mode = 'live', headers = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ url, mode }),
});

async function start(request) {
  const response = await request('/live-sessions', startOptions());
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

async function fetchSession(request, id) {
  return (await (await request(`/live-sessions/${id}`)).json()).session;
}

async function until(get, condition) {
  for (let step = 0; step < 100; step++) {
    const value = await get();
    if (condition(value)) return value;
    await delay(10);
  }
  assert.fail('Timed out waiting for the expected session state');
}

function emitChat(connection, id, content, nickname = 'Người xem') {
  connection.emit('chat', {
    common: { msgId: id, roomId: '9576211122334455667' },
    user: { id: '9876543210012345678', displayId: 'viewer', nickname },
    content,
  });
}

test('remote server configuration requires a token', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /APP_TOKEN/);
});

test('protected routes require bearer auth and allowlisted browser origins', async (t) => {
  const { request } = await service(t, {
    config: { appToken: token, allowedOrigins: new Set([allowedOrigin]) },
  });
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).authRequired, true);
  assert.equal((await request('/live-sessions')).status, 401);
  assert.equal((await request('/live-sessions?token=' + encodeURIComponent(token))).status, 401);

  const options = await request('/live-sessions', {
    method: 'OPTIONS',
    headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.match(options.headers.get('access-control-allow-headers'), /Authorization/i);

  const allowed = await request('/live-sessions', { headers: { ...auth, Origin: allowedOrigin } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), allowedOrigin);
  const denied = await request('/live-sessions', {
    headers: { ...auth, Origin: 'https://untrusted.example' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('invalid LIVE targets fail before claiming the active slot', async (t) => {
  const { request } = await service(t);
  const result = await request('/live-sessions', startOptions('https://evil.example/@viewer_host/live'));
  assert.equal(result.status, 400);
  assert.equal((await result.json()).code, 'INVALID_TARGET');
  assert.equal((await request('/live-sessions', startOptions())).status, 201);
});

test('simultaneous starts reserve one active session', async (t) => {
  const { request } = await service(t);
  const results = await Promise.all([
    request('/live-sessions', startOptions('@first')),
    request('/live-sessions', startOptions('@second')),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const history = await request('/live-sessions');
  assert.equal((await history.json()).sessions.length, 1);
});

test('stop while connecting rejects late source callbacks and releases the active slot', async (t) => {
  const pending = Promise.withResolvers();
  const began = Promise.withResolvers();
  const late = new TestConnection(() => {
    began.resolve();
    return pending.promise;
  });
  const { request } = await service(t, {
    connectorFactory: (uniqueId) => uniqueId === 'viewer_host' ? late : new TestConnection(),
  });
  const session = await start(request);
  await began.promise;
  const stopped = await request(`/live-sessions/${session.id}/stop`, { method: 'POST' });
  assert.equal((await stopped.json()).session.status, 'stopped');

  const fresh = await request('/live-sessions', startOptions('@fresh_host'));
  assert.equal(fresh.status, 201);
  pending.resolve({ roomId: 'another-room' });
  late.emit('error', new Error('late upstream error'));
  emitChat(late, 'message-after-stop', 'Tin nhắn sau khi dừng');
  await until(() => fetchSession(request, session.id), (value) => value.status === 'stopped');
  const history = await (await request(`/live-sessions/${session.id}/history`)).json();
  assert.equal(history.events.some(({ type, status }) => type === 'chat' || status === 'connected'), false);
});

test('transport loss shows a gap and stream end releases the active slot', async (t) => {
  const first = new TestConnection();
  const second = new TestConnection();
  const attempts = [first, second];
  const { request } = await service(t, {
    connectorFactory: () => attempts.shift(),
    reconnectDelays: [15],
  });
  const session = await start(request);
  await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');
  first.emit('disconnected');
  await until(async () => (await (await request(`/live-sessions/${session.id}/history`)).json()).events,
    (events) => events.filter(({ status }) => status === 'connected').length === 2);
  first.emit('streamEnd');
  second.emit('streamEnd');
  const ended = await until(() => fetchSession(request, session.id), (value) => value.status === 'ended');
  assert.ok(ended.endedAt);
  const history = await (await request(`/live-sessions/${session.id}/history`)).json();
  assert.ok(history.events.some(({ status, message }) => status === 'reconnecting' && /bỏ lỡ|gián đoạn/.test(message)));
});

test('history survives restart and records the interrupted connection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'livelens-tests-'));
  const path = join(directory, 'history.sqlite');
  let first;
  let reopened;
  t.after(async () => {
    await reopened?.close();
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  });
  first = await service(t, { sqlitePath: path });
  const session = await start(first.request);
  await until(() => fetchSession(first.request, session.id), (value) => value.status === 'connected');
  emitChat(first.connection, '990000000000000001', 'Dòng tin được lưu');
  emitChat(first.connection, '990000000000000001', 'Lặp ở upstream');
  await until(() => fetchSession(first.request, session.id), (value) => value.stats.comments === 1);
  await first.close();

  reopened = await service(t, { sqlitePath: path });
  const history = await (await reopened.request(`/live-sessions/${session.id}/history`)).json();
  assert.deepEqual(history.events.filter(({ type }) => type === 'chat').map(({ id, comment }) => [id, comment]),
    [['990000000000000001', 'Dòng tin được lưu']]);
  assert.ok(history.events.some(({ status, message }) => status === 'error' && /khởi động lại/.test(message)));
  const recovered = await fetchSession(reopened.request, session.id);
  assert.equal(recovered.status, 'error');
  assert.ok(recovered.endedAt);
});

test('storage failures stop intake and reach clients even when the error cannot be persisted', async (t) => {
  for (const failTransition of [false, true]) await t.test(`error-state write fails: ${failTransition}`, async (t) => {
    const { request, connection, store } = await service(t);
    const session = await start(request);
    await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');
    t.mock.method(console, 'error', () => {});
    t.mock.method(store, 'record', async () => { throw new Error('SQLITE_FULL'); });
    if (failTransition) t.mock.method(store, 'transition', async () => { throw new Error('SQLITE_FULL'); });
    emitChat(connection, 'write-failure-1', 'Không được lưu');
    emitChat(connection, 'write-failure-2', 'Đang chờ ghi');
    const failed = await until(() => fetchSession(request, session.id), (value) => value.status === 'error');
    assert.match(failed.error, /Không thể lưu/);
    assert.ok(failed.endedAt);
    assert.equal(failed.stats.comments, 0);
    assert.equal(connection.listenerCount('chat'), 0);
    const list = (await (await request('/live-sessions')).json()).sessions;
    assert.equal(list[0].status, 'error');
    const health = await request('/health');
    assert.equal(health.status, 503);
    assert.equal((await health.json()).code, 'STORAGE_ERROR');
    assert.equal((await request('/live-sessions', startOptions('@fresh'))).status, 503);
    const stopped = await request(`/live-sessions/${session.id}/stop`, { method: 'POST' });
    assert.equal((await stopped.json()).session.status, 'error');
  });
});

test('a failed stop write cannot leave a disconnected source displayed as connected', async (t) => {
  const { request, store } = await service(t);
  const session = await start(request);
  await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');
  t.mock.method(console, 'error', () => {});
  t.mock.method(store, 'transition', async () => { throw new Error('disk unavailable'); });
  const response = await request(`/live-sessions/${session.id}/stop`, { method: 'POST' });
  const failed = (await response.json()).session;
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /Không thể lưu/);
});

test('history pages reach the first comment and search the entire saved session', async (t) => {
  const { request, connection } = await service(t);
  const session = await start(request);
  await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');
  for (let index = 1; index <= 650; index++) emitChat(connection, `history-${index}`,
    index === 1 ? 'Áo trắng đầu phiên' : index === 2 ? 'Literal 100%_ sale' : `Bình luận ${index}`);
  await until(() => fetchSession(request, session.id), (value) => value.stats.comments === 650);
  let page = await (await request(`/live-sessions/${session.id}/history?type=chat`)).json();
  assert.equal(page.events.length, 300);
  assert.equal(page.hasMore, true);
  const collected = [...page.events];
  while (page.hasMore) {
    page = await (await request(`/live-sessions/${session.id}/history?type=chat&before=${page.events[0].seq}`)).json();
    collected.unshift(...page.events);
  }
  assert.equal(collected.length, 650);
  assert.equal(new Set(collected.map(({ seq }) => seq)).size, 650);
  assert.equal(collected[0].comment, 'Áo trắng đầu phiên');
  const search = await (await request(`/live-sessions/${session.id}/history?type=chat&search=ao%20trang%20dau%20phien`)).json();
  assert.deepEqual(search.events.map(({ comment }) => comment), ['Áo trắng đầu phiên']);
  const literal = await (await request(`/live-sessions/${session.id}/history?search=100%25_`)).json();
  assert.equal(literal.events.length, 1);
  for (const query of ['after=0&before=10', 'before=-1', 'type=unknown', `search=${'x'.repeat(201)}`]) {
    assert.equal((await request(`/live-sessions/${session.id}/history?${query}`)).status, 400);
  }
});

test('aggregates count completed streaks once while history retains cumulative stages', async (t) => {
  const { request, connection } = await service(t);
  const session = await start(request);
  await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');
  const payload = {
    common: { roomId: '9576211122334455667', msgId: 'progress-message' },
    user: { id: '551', displayId: 'gifter' },
    giftId: '5655', groupId: '444', repeatCount: 1, repeatEnd: 0,
    gift: { name: 'Hoa hồng', type: 1 },
  };
  for (const quantity of [1, 2, 5]) connection.emit('gift', { ...payload, repeatCount: quantity });
  connection.emit('gift', { ...payload, repeatCount: 5, repeatEnd: 1 });
  connection.emit('gift', { ...payload, repeatCount: 5, repeatEnd: 1,
    common: { ...payload.common, msgId: 'another-final-message' } });
  connection.emit('gift', { ...payload, repeatCount: 4, common: { ...payload.common, msgId: 'late-progress-message' } });
  await request(`/live-sessions/${session.id}/stop`, { method: 'POST' });
  const history = await (await request(`/live-sessions/${session.id}/history`)).json();
  assert.deepEqual(history.events.filter((event) => event.gift).map(({ gift }) => [gift.quantity, gift.isFinal]),
    [[1, false], [2, false], [5, false], [5, true]]);
  const current = await fetchSession(request, session.id);
  assert.equal(current.stats.gifts, 5);
  assert.equal(current.stats.gifters, 1);
  assert.equal(current.stats.events, history.events.length);
});

async function readSSE(request, path, count, headers) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    const response = await request(path, { headers, signal: abort.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
      if (body.match(/^data: /gm)?.length >= count && body.endsWith('\n\n')) break;
    }
    return body.split('\n\n').filter((frame) => frame.startsWith('id: ')).map((frame) => {
      const [id, name, data] = frame.split('\n');
      assert.equal(name, 'event: event');
      const event = JSON.parse(data.slice(6));
      assert.equal(Number(id.slice(4)), event.seq);
      return event;
    });
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

test('SSE replays persistent events after the cursor with bearer authorization', async (t) => {
  const { request, connection } = await service(t, { config: { appToken: token } });
  const authenticated = (path, opts = {}) => request(path, { ...opts, headers: { ...opts.headers, ...auth } });
  const session = await start(authenticated);
  await until(() => fetchSession(authenticated, session.id), (value) => value.status === 'connected');
  emitChat(connection, 'sse-chat-1', 'Một');
  emitChat(connection, 'sse-chat-2', 'Hai');
  await until(() => fetchSession(authenticated, session.id), (value) => value.stats.comments === 2);

  const history = await (await authenticated(`/live-sessions/${session.id}/history?limit=1`)).json();
  assert.equal(history.hasMore, true);
  assert.equal(history.events[0].comment, 'Hai');
  const through = await (await authenticated(`/live-sessions/${session.id}/history?after=0&limit=3`)).json();
  const cursor = through.nextCursor;
  assert.deepEqual(through.events.map(({ type }) => type), ['status', 'status', 'chat']);
  assert.equal(through.hasMore, true);

  const read = readSSE(request, `/live-sessions/${session.id}/events?after=${cursor}`, 2, auth);
  emitChat(connection, 'sse-chat-3', 'Ba');
  const events = await read;
  assert.deepEqual(events.map(({ comment }) => comment), ['Hai', 'Ba']);
  assert.ok(events.every(({ seq }) => seq > cursor));
});

test('CSV exports literal fields safely even when data looks like a spreadsheet formula', async (t) => {
  const { request, connection } = await service(t);
  const session = await start(request);
  await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');
  emitChat(connection, 'csv-chat', '=HYPERLINK("https://example.org")', '\t+SUM(1,2)');
  await until(() => fetchSession(request, session.id), (value) => value.stats.comments === 1);
  const csv = await request(`/live-sessions/${session.id}/export`);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const content = await csv.text();
  assert.ok(content.includes(`"'\t+SUM(1,2)"`));
  assert.ok(content.includes(`"'=HYPERLINK(""https://example.org"")"`));
});

test('server demo persists explicitly simulated events and does not require a TikTok connection', async (t) => {
  const { request } = await service(t, {
    connectorFactory: () => {
      assert.fail('Demo must not construct a TikTok connector');
    },
  });
  const response = await request('/live-sessions', startOptions('', 'demo'));
  assert.equal(response.status, 201);
  const { session } = await response.json();
  const live = await until(() => fetchSession(request, session.id), (value) => value.stats.comments > 0);
  assert.equal(live.mode, 'demo');
  assert.match(live.roomId, /^demo-/);
  const history = await (await request(`/live-sessions/${session.id}/history`)).json();
  assert.ok(history.events.some(({ message }) => /mô phỏng/.test(message ?? '')));
});

test('loopback API without a token rejects requests addressed to an unrelated host', async (t) => {
  const { base } = await service(t);
  const response = await new Promise((resolve, reject) => {
    get(base + '/api/live-sessions', { headers: { Host: 'unrelated.example' } }, resolve).on('error', reject);
  });
  response.resume();
  assert.equal(response.statusCode, 403);
});

test('stop cancels scheduled reconnects and signals pending handshakes', async (t) => {
  let attempts = 0;
  let signal;
  const pending = Promise.withResolvers();
  const connection = new TestConnection(() => pending.promise);
  const { request } = await service(t, {
    connectorFactory: (_username, options) => {
      attempts++;
      signal = options?.signal;
      return connection;
    },
    reconnectDelays: [100],
  });
  const session = await start(request);
  connection.emit('disconnected');
  await until(() => fetchSession(request, session.id), (value) => value.status === 'reconnecting');
  await request(`/live-sessions/${session.id}/stop`, { method: 'POST' });
  await delay(125);
  pending.resolve({ roomId: 'late-room-id' });
  assert.equal(attempts, 1);
  assert.equal(signal?.aborted, true);
  assert.equal((await fetchSession(request, session.id)).status, 'stopped');
});


test('type-zero gifts complete immediately and a sparse retry counts only once', async (t) => {
  const { request, connection } = await service(t);
  const session = await start(request);
  await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');

  const payload = {
    common: { roomId: '9576211122334455667', msgId: 'type-zero-message' },
    user: { id: '551', displayId: 'gifter' },
    giftId: '5655', groupId: '444', repeatCount: 1, repeatEnd: 0,
    gift: { name: 'Hoa hồng', type: 0, combo: false },
  };
  connection.emit('gift', payload);
  connection.emit('gift', { ...payload, gift: undefined });
  await request(`/live-sessions/${session.id}/stop`, { method: 'POST' });

  const completed = await fetchSession(request, session.id);
  assert.equal(completed.stats.gifts, 1);
  const history = await (await request(`/live-sessions/${session.id}/history`)).json();
  assert.deepEqual(history.events.filter((event) => event.gift).map(({ type }) => type), ['gift.completed']);
});

test('TikTok connector aborts an in-flight WebSocket upgrade', async (t) => {
  const server = createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  const controller = new AbortController();
  const connector = createTikTokFactory()('viewer_host', { signal: controller.signal });
  const port = server.address().port;
  const receivedUpgrade = once(server, 'upgrade', { signal: AbortSignal.timeout(1000) });
  // Exercise the pinned provider's actual WebSocket path without calling the signing service.
  const attempt = connector.setupWebsocket(`ws://127.0.0.1:${port}/`, { room_id: '123' }, '123');
  const rejected = assert.rejects(Promise.race([attempt, delay(1200, undefined, { ref: false })]), {
    code: 'ABORT_ERR',
  });
  await Promise.all([receivedUpgrade.then(() => controller.abort()), rejected]);
});

test('audience stats persist distinct accounts, source counts, joins and completed gifts without duplicates', async (t) => {
  const { request, connection } = await service(t);
  const session = await start(request);
  await until(() => fetchSession(request, session.id), (value) => value.status === 'connected');
  const read = async (query = '') => (await (await request(`/live-sessions/${session.id}/audience${query}`)).json());
  const empty = await read();
  assert.equal(empty.currentViewers, null);
  assert.equal(empty.peakViewers, null);
  assert.equal(empty.knownViewers, 0);
  const common = { roomId: '9576211122334455667' };
  const user = { id: '9223372036854775802', displayId: 'ao_trang', nickname: 'Áo Trắng' };
  connection.emit('roomUser', { common: { ...common, msgId: 'count-1' }, total: '40', totalUser: '999' });
  connection.emit('roomUser', { common: { ...common, msgId: 'count-2' }, total: '100' });
  connection.emit('roomUser', { common: { ...common, msgId: 'count-3' }, total: '0' });
  for (let index = 0; index < 2; index++) {
    connection.emit('member', { common: { ...common, msgId: 'join-1' }, user, action: 1 });
    connection.emit('like', { common: { ...common, msgId: 'like-1' }, user, count: 5, total: '750' });
    connection.emit('follow', { common: { ...common, msgId: 'follow-1' }, user });
    connection.emit('share', { common: { ...common, msgId: 'share-1' }, user, shareCount: 2 });
    connection.emit('chat', { common: { ...common, msgId: 'chat-1' }, user, content: 'Xin giá' });
    connection.emit('gift', { common: { ...common, msgId: 'gift-1' }, user, giftId: 'rose', groupId: 'combo', repeatCount: 3, repeatEnd: index, gift: { type: 1, name: 'Hoa hồng' } });
  }
  connection.emit('member', { common: { ...common, msgId: 'subscription-not-join' }, user, action: 3 });
  connection.emit('member', { common: { ...common, msgId: 'anonymous' }, action: 1 });
  connection.emit('roomUser', { common: { roomId: 'wrong-room', msgId: 'wrong-count' }, total: '9999' });
  const data = await until(() => read(), (value) => value.viewers[0]?.gifts === 3);
  assert.equal(data.currentViewers, 0);
  assert.equal(data.peakViewers, 100);
  assert.equal(data.samples.length, 3);
  assert.equal(data.knownViewers, 1);
  assert.equal(data.totalLikes, 750);
  const viewer = data.viewers[0];
  assert.equal(viewer.user.id, user.id);
  assert.deepEqual([viewer.comments, viewer.gifts, viewer.likes, viewer.joins, viewer.follows, viewer.shares], [1, 3, 5, 1, 1, 2]);
  assert.ok(viewer.firstSeen <= viewer.lastSeen);
  assert.equal((await read('?search=ao%20trang&filter=gift&sort=gifts')).viewers.length, 1);
  assert.equal((await read('?search=unmatched')).total, 0);
  const personal = await (await request(`/live-sessions/${session.id}/history?userId=${user.id}`)).json();
  assert.ok(personal.events.length > 0);
  assert.ok(personal.events.every((event) => event.user?.id === user.id));
  assert.equal((await (await request(`/live-sessions/${session.id}/history?userId=not-there`)).json()).events.length, 0);
  for (const query of ['filter=invalid', 'sort=payload', 'offset=-1', 'limit=201', `search=${'x'.repeat(201)}`]) {
    assert.equal((await request(`/live-sessions/${session.id}/audience?${query}`)).status, 400);
  }
});

test('viewer lists page across the full session and CSV exports every account with formula-safe names', async (t) => {
  const { request, store } = await service(t, { config: { appToken: token } });
  const authenticated = (path, opts = {}) => request(path, { ...opts, headers: { ...opts.headers, ...auth } });
  const session = await start(authenticated);
  await until(() => fetchSession(authenticated, session.id), (value) => value.status === 'connected');
  for (let index = 0; index < 205; index++) await store.record(session.id, normalizeChat({
    common: { msgId: `audience-chat-${index}` }, user: { id: String(index + 1), displayId: `viewer_${index}`, nickname: index === 0 ? '=SUM(1,2)' : `Người ${index}` }, content: 'Chào',
  }));
  const endpoint = `/live-sessions/${session.id}/audience`;
  assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(`/live-sessions/${session.id}/audience-export`)).status, 401);
  const first = await (await authenticated(endpoint + '?limit=200&sort=comments')).json();
  const last = await (await authenticated(endpoint + '?offset=200&limit=200&sort=comments')).json();
  assert.equal(first.knownViewers, 205);
  assert.equal(first.hasMore, true);
  assert.equal(last.viewers.length, 5);
  assert.equal(last.hasMore, false);
  assert.equal(new Set([...first.viewers, ...last.viewers].map((viewer) => viewer.user.id)).size, 205);
  const literal = await (await authenticated(endpoint + '?search=viewer_1')).json();
  assert.ok(literal.viewers.every((viewer) => viewer.user.username.includes('viewer_1')));
  const exported = await authenticated(`/live-sessions/${session.id}/audience-export`);
  const csv = await exported.text();
  assert.equal(csv.trim().split('\r\n').length, 206);
  assert.ok(csv.includes('"\'=SUM(1,2)"'));
});

test('audience projections rebuild older stored sessions once and survive reopening without double counts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'livelens-audience-'));
  const path = join(directory, 'history.sqlite');
  let store;
  let raw;
  t.after(async () => { raw?.close(); await store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await createStore({ sqlitePath: path });
  const session = await store.start({ uniqueId: 'history_host', mode: 'live', message: 'Start' });
  await store.record(session.id, normalizeChat({ common: { msgId: 'old-chat' }, user: { id: 'old-user', displayId: 'old_viewer' }, content: 'Được lưu từ trước' }));
  await store.record(session.id, normalizeAudience({ total: '52' }, undefined, 'viewers'));
  await store.close();
  store = undefined;
  const { DatabaseSync } = await import('node:sqlite');
  raw = new DatabaseSync(path);
  raw.exec('DROP TABLE audience_samples; DROP TABLE audience_viewers; DROP TABLE audience_sessions;');
  raw.close();
  raw = undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    store = await createStore({ sqlitePath: path });
    const data = await store.audience(session.id);
    assert.equal(data.knownViewers, 1);
    assert.equal(data.viewers[0].comments, 1);
    assert.equal(data.peakViewers, 52);
    assert.equal(data.samples.length, 1);
    assert.equal((await store.history(session.id, { limit: 300 })).events.length, 3);
    await store.close();
    store = undefined;
  }
});

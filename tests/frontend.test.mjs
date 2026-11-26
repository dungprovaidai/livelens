import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import ts from 'typescript';

const output = await mkdtemp(join(tmpdir(), 'livelens-frontend-'));
after(() => rm(output, { recursive: true, force: true }));

for (const name of ['src/client', 'src/demo', 'src/preferences', 'shared/audience']) {
  const fileName = `${name}.ts`;
  const source = await readFile(new URL(`../${fileName}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      rewriteRelativeImportExtensions: true,
    },
  });
  await mkdir(dirname(join(output, `${name}.js`)), { recursive: true });
  await writeFile(join(output, `${name}.js`), outputText);
}

const { LiveClient } = await import(pathToFileURL(join(output, 'src/client.js')));
const { loadDemoRecords, nextDemoEvent, saveDemoRecords, startDemo, demoAudienceCsv } = await import(pathToFileURL(join(output, 'src/demo.js')));
const { readConnection, saveConnection, unlockSound, notifyEvent, testSound, requestDesktopPermission } = await import(pathToFileURL(join(output, 'src/preferences.js')));

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function mockStorage(t) {
  const descriptors = Object.fromEntries(['localStorage', 'sessionStorage'].map((name) => [
    name, Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  const local = memoryStorage();
  let session = memoryStorage();
  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, value: local },
    sessionStorage: { configurable: true, get: () => session },
  });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { local, useTab: (storage) => { session = storage; } };
}

test('an access token stays bound to the normalized server across tabs', (t) => {
  const { local, useTab } = mockStorage(t);
  const tabA = memoryStorage();
  const tabB = memoryStorage();

  useTab(tabA);
  saveConnection({ origin: 'https://first.example', token: 'token-a' });
  assert.deepEqual(readConnection(), { origin: 'https://first.example', token: 'token-a' });

  useTab(tabB);
  saveConnection({ origin: 'https://SECOND.example:443/', token: 'token-b' });
  assert.deepEqual(readConnection(), { origin: 'https://second.example', token: 'token-b' });

  useTab(tabA);
  assert.deepEqual(readConnection(), { origin: 'https://second.example', token: '' });
  assert.equal(local.getItem('livelens.backend'), 'https://second.example');
});

test('an unbound token from an older version is ignored', (t) => {
  const { local } = mockStorage(t);
  local.setItem('livelens.backend', 'https://example.test');
  sessionStorage.setItem('livelens.token', 'legacy-token');
  assert.deepEqual(readConnection(), { origin: 'https://example.test', token: '' });
});

test('public health requests omit the bearer header while protected calls include it', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, authorization: options.headers.get('Authorization') });
    return Response.json({ ok: true, authRequired: true, sessions: [] });
  });
  const client = new LiveClient({ origin: 'https://example.test', token: 'sample-token' });
  await client.health();
  await client.sessions();
  assert.deepEqual(requests, [
    { url: 'https://example.test/api/health', authorization: null },
    { url: 'https://example.test/api/live-sessions', authorization: 'Bearer sample-token' },
  ]);
});

test('restoring an interrupted demo preserves its actual end time on subsequent loads', (t) => {
  const { local } = mockStorage(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T10:00:00Z') });
  const record = nextDemoEvent(startDemo());
  const inconsistent = startDemo();
  inconsistent.session.lastEventAt = new Date(Date.parse(inconsistent.session.createdAt) - 10000).toISOString();
  saveDemoRecords([record, inconsistent]);

  t.mock.timers.setTime(Date.parse('2026-01-02T10:00:00Z'));
  const [repaired, clamped] = loadDemoRecords();
  assert.equal(repaired.session.status, 'stopped');
  assert.equal(repaired.session.endedAt, record.session.lastEventAt);
  assert.equal(clamped.session.endedAt, inconsistent.session.createdAt);
  assert.deepEqual(JSON.parse(local.getItem('livelens.demo.v1')), [repaired, clamped]);

  t.mock.timers.setTime(Date.parse('2026-01-09T10:00:00Z'));
  assert.deepEqual(loadDemoRecords(), [repaired, clamped]);
});

test('history requests preserve pagination, literal search text and the selected event type', async (t) => {
  let requested;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested = new URL(url);
    return Response.json({ events: [], nextCursor: 0, hasMore: false });
  });
  const client = new LiveClient({ origin: 'https://example.test', token: '' });
  await client.history('session-id', undefined, { before: 150, search: '  áo 100%_ & trắng  ', type: 'chat' });
  assert.equal(requested.pathname, '/api/live-sessions/session-id/history');
  assert.equal(requested.searchParams.get('before'), '150');
  assert.equal(requested.searchParams.get('search'), 'áo 100%_ & trắng');
  assert.equal(requested.searchParams.get('type'), 'chat');
  assert.equal(requested.searchParams.get('limit'), '300');
});

test('sound resumes after a new browser gesture and can play an alert in a restored session', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let context;
  let played = 0;
  let created = 0;
  class TestAudio {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    constructor() { context = this; created++; }
    async resume() { this.state = 'running'; }
    createOscillator() {
      return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(node) { return node; }, start() { played++; }, stop() {} };
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: TestAudio });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else delete globalThis.AudioContext;
  });
  assert.equal(await unlockSound(), true);
  context.state = 'suspended';
  assert.equal(await unlockSound(), true);
  assert.equal(created, 1);
  notifyEvent({ type: 'gift.completed', gift: { name: 'Hoa hồng', quantity: 1 } }, { sound: true, giftAlerts: true, desktop: false }, false);
  assert.equal(played, 1);
  assert.equal(notifyEvent({ type: 'chat', comment: 'Xin giá áo trắng' }, { sound: true, commentAlerts: true, keywords: ['gia'], desktop: false }, false), true);
  assert.equal(played, 2);
  notifyEvent({ type: 'chat', comment: 'Xin size' }, { sound: true, commentAlerts: true, keywords: ['gia'], desktop: false }, false);
  assert.equal(played, 2);
  assert.equal(notifyEvent({ type: 'chat', comment: 'Xin giá' }, { sound: true, commentAlerts: false, keywords: [], desktop: false }, false), undefined);
  assert.equal(notifyEvent({ type: 'chat', comment: 'Xin giá' }, { sound: false, commentAlerts: true, keywords: [], desktop: false }, false), undefined);
  assert.equal(played, 2);
  context.state = 'suspended';
  assert.equal(notifyEvent({ type: 'chat', comment: 'Xin giá' }, { sound: true, commentAlerts: true, keywords: [], desktop: false }, false), false);
  assert.equal(played, 2);
  assert.equal(await testSound(), true);
  assert.equal(played, 3);
  context.createOscillator = () => { throw new Error('Audio output unavailable'); };
  assert.equal(notifyEvent({ type: 'chat', comment: 'Xin giá' }, { sound: true, commentAlerts: true, keywords: [], desktop: false }, false), false);
});

test('desktop alerts identify new commenters only while the page is in the background and permission is granted', async (t) => {
  const originals = Object.fromEntries(['window', 'document', 'Notification'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const shown = [];
  let focused = true;
  let focusCalls = 0;
  let permissionRequests = 0;
  class DesktopNotification {
    static permission = 'default';
    static async requestPermission() { permissionRequests++; return this.permission = 'granted'; }
    constructor(title, options) { Object.assign(this, { title, options }); shown.push(this); }
    close() { this.closed = true; }
  }
  const browserWindow = { Notification: DesktopNotification, focus() { focusCalls++; }, location: { hash: '#history' } };
  const browserDocument = { visibilityState: 'visible', hasFocus: () => focused };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: browserWindow },
    document: { configurable: true, value: browserDocument },
    Notification: { configurable: true, value: DesktopNotification },
  });
  const settings = { sound: false, desktop: true, giftAlerts: true, commentAlerts: true, keywords: [] };
  const chat = { id: 'chat-1', sessionId: 'live-session', type: 'chat', user: { nickname: 'Linh Chi', username: 'linhchi' }, comment: 'Áo trắng này giá bao nhiêu?' };
  notifyEvent(chat, settings, false);
  assert.equal(permissionRequests, 0);
  assert.equal(shown.length, 0);
  assert.equal(await requestDesktopPermission(), 'granted');
  notifyEvent(chat, settings, false);
  assert.equal(shown.length, 0);
  browserDocument.visibilityState = 'hidden';
  notifyEvent(chat, settings, false);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Linh Chi bình luận · LiveLens');
  assert.equal(shown[0].options.body, chat.comment);
  assert.equal(shown[0].options.tag, 'livelens:live-session:chat-1');
  shown[0].onclick();
  assert.equal(focusCalls, 1);
  assert.equal(browserWindow.location.hash, '#overview');
  assert.equal(shown[0].closed, true);
  notifyEvent(chat, { ...settings, desktop: false }, false);
  notifyEvent(chat, { ...settings, commentAlerts: false }, false);
  notifyEvent(chat, { ...settings, keywords: ['không khớp'] }, false);
  notifyEvent({ ...chat, type: 'gift.progress' }, settings, false);
  assert.equal(shown.length, 1);
  browserDocument.visibilityState = 'visible';
  focused = false;
  notifyEvent({ ...chat, id: 'chat-2', user: { username: 'only_username' } }, settings, true);
  assert.equal(shown[1].title, 'Demo · only_username bình luận · LiveLens');
  assert.notEqual(shown[0].options.tag, shown[1].options.tag);
  DesktopNotification.permission = 'denied';
  notifyEvent(chat, settings, false);
  assert.equal(shown.length, 2);
  DesktopNotification.requestPermission = () => { throw new Error('Browser blocked permission'); };
  assert.equal(await requestDesktopPermission(), 'denied');
  DesktopNotification.permission = 'granted';
  const unavailable = class { static permission = 'granted'; constructor() { throw new Error('Desktop notifications unavailable'); } };
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: unavailable });
  browserWindow.Notification = unavailable;
  assert.doesNotThrow(() => notifyEvent(chat, settings, false));
  delete browserWindow.Notification;
  assert.equal(await requestDesktopPermission(), 'unsupported');
});

test('demo audience totals retain accounts and gift counts beyond the visible event window', async () => {
  let record = startDemo();
  const first = record.audience.viewers.find((viewer) => viewer.user.id === 'an');
  assert.equal(first.gifts, 12);
  assert.equal(record.audience.currentViewers, 156);
  for (let index = 0; index < 350; index++) record = nextDemoEvent(record);
  assert.equal(record.events.length, 300);
  assert.equal(record.audience.viewers.length, 6);
  assert.equal(record.audience.viewers.find((viewer) => viewer.user.id === 'an').gifts, 12 + 25 * 6);
  assert.ok(record.audience.peakViewers >= record.audience.currentViewers);
  const csv = await demoAudienceCsv(record.audience.viewers).text();
  assert.equal(csv.split('\r\n').length, 7);
  assert.ok(csv.includes('Dữ liệu mẫu'));
});

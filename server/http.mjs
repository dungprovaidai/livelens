import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isLoopback } from './config.mjs';

const { version } = createRequire(import.meta.url)('../package.json');
const PAGE_SIZE = 200;
const MAX_STREAMS = 100;
const clientErrorCodes = new Set(['INVALID_REQUEST', 'INVALID_TARGET', 'SHORT_LINK']);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function errorResponse(res, status, error, code) {
  json(res, status, { error, ...(code && { code }) });
}

function statusError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function hash(value) {
  return createHash('sha256').update(value).digest();
}

function numberParam(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return fallback;
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number >= min && number <= max) return number;
  }
  throw statusError(400, 'Cursor hoặc giới hạn trang không hợp lệ.', 'INVALID_PAGINATION');
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > 8192) {
      req.resume();
      throw statusError(413, 'Yêu cầu vượt quá kích thước cho phép.', 'BODY_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // A JSON syntax error has the same response as an unexpected JSON shape.
  }
  throw statusError(400, 'Gửi dữ liệu dưới dạng đối tượng JSON.', 'INVALID_REQUEST');
}

function write(res, chunk) {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;

  return new Promise((resolveWrite) => {
    const finish = (ready) => {
      clearTimeout(timeout);
      res.off('close', closed);
      res.off('drain', drained);
      resolveWrite(ready);
    };
    const closed = () => finish(false);
    const drained = () => finish(true);
    const timeout = setTimeout(() => {
      finish(false);
      res.destroy();
    }, 15_000).unref();
    res.once('close', closed);
    res.once('drain', drained);
  });
}

function eventFrame(event) {
  return `id: ${event.seq}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamEvents(res, store, id, after, onClose) {
  let cursor = after;
  let closed = false;
  let dirty = true;
  let running = false;
  let heartbeatDue = false;

  async function flush() {
    if (closed || running) return;
    running = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        const page = await store.history(id, { after: cursor, limit: PAGE_SIZE });
        for (const event of page.events) {
          if (!(await write(res, eventFrame(event)))) return;
          cursor = event.seq;
          heartbeatDue = false;
        }
        dirty ||= page.hasMore;
      }
      if (heartbeatDue && !closed) {
        heartbeatDue = false;
        await write(res, ': keep-alive\n\n');
      }
    } catch {
      res.destroy();
    } finally {
      running = false;
      if (dirty && !closed) void flush();
    }
  }

  const changed = () => {
    dirty = true;
    void flush();
  };
  const unsubscribe = store.subscribe(id, changed);
  const heartbeat = setInterval(() => {
    heartbeatDue = true;
    changed();
  }, 15_000).unref();
  res.once('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    onClose();
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  void flush();
}

function cell(value) {
  let rendered = String(value ?? '');
  if (/^[\s\p{Cf}]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(rendered)) rendered = "'" + rendered;
  return `"${rendered.replaceAll('"', '""')}"`;
}

function csvEntry(event) {
  return [
    event.seq, event.timestamp, event.type, event.id,
    event.user?.id, event.user?.username, event.user?.nickname,
    event.comment, event.gift?.id, event.gift?.name, event.gift?.quantity, event.gift?.diamonds,
    event.gift?.streakId, event.status, event.message,
    event.viewerCount, event.likeCount, event.totalLikeCount, event.shareCount,
  ].map(cell).join(',') + '\r\n';
}

async function exportCsv(res, store, session) {
  const end = await store.latestSequence(session.id);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="livelens-${session.id}.csv"`,
  });
  const header = 'seq,thoi_gian,loai,id_su_kien,id_nguoi_dung,ten_nguoi_dung,biet_danh,binh_luan,id_qua,ten_qua,so_luong,kim_cuong,id_chuoi,trang_thai,thong_bao,nguoi_dang_xem,luot_thich,tong_thich,luot_chia_se';
  if (!(await write(res, `\uFEFF${header}\r\n`))) return;
  let cursor = 0;
  while (!res.destroyed && cursor < end) {
    const page = await store.history(session.id, { after: cursor, limit: PAGE_SIZE });
    for (const event of page.events) {
      if (event.seq > end) break;
      if (!(await write(res, csvEntry(event)))) return;
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  res.end();
}

async function exportAudienceCsv(res, store, id) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="livelens-viewers-${id}.csv"`,
  });
  if (!(await write(res, '\uFEFFid,tai_khoan,ten_hien_thi,binh_luan,qua,luot_thich,luot_vao,follow,chia_se,lan_dau,gan_nhat\r\n'))) return;
  let afterId;
  while (!res.destroyed) {
    const page = await store.viewers(id, { sort: 'id', afterId, limit: PAGE_SIZE });
    for (const viewer of page.viewers) {
      const values = [viewer.user.id, viewer.user.username, viewer.user.nickname, viewer.comments, viewer.gifts, viewer.likes,
        viewer.joins, viewer.follows, viewer.shares, viewer.firstSeen, viewer.lastSeen];
      if (!(await write(res, values.map(cell).join(',') + '\r\n'))) return;
    }
    if (!page.hasMore) break;
    afterId = page.viewers.at(-1).user.id;
  }
  res.end();
}

async function staticFile(root, pathname) {
  const diskRoot = await realpath(root).catch(() => null);
  if (!diskRoot) return null;
  const candidate = resolve(diskRoot, `.${pathname}`);
  if (!candidate.startsWith(diskRoot + sep)) return null;
  const path = await realpath(candidate).catch(() => null);
  if (!path?.startsWith(diskRoot + sep)) return null;
  const details = await stat(path);
  return details.isFile() ? { path, size: details.size } : null;
}

async function serveStatic(req, res, url, root) {
  if (!['GET', 'HEAD'].includes(req.method)) return errorResponse(res, 405, 'Phương thức không được hỗ trợ.');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return errorResponse(res, 400, 'Đường dẫn không hợp lệ.');
  }
  if (pathname.startsWith('/.') || pathname.includes('\\') || pathname.includes('\0')) {
    return errorResponse(res, 404, 'Không tìm thấy trang.');
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = await staticFile(root, requested)
    ?? (!extname(pathname) && req.headers.accept?.includes('text/html') ? await staticFile(root, '/index.html') : null);
  if (!file) return errorResponse(res, 404, 'Không tìm thấy trang. Hãy chạy npm run build để mở giao diện.');
  res.writeHead(200, {
    'Content-Type': types.get(extname(file.path)) ?? 'application/octet-stream',
    'Content-Length': file.size,
    'Cache-Control': requested.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(file.path), res);
}

export function createApp({ store, manager, config }) {
  const token = config.appToken ? hash(`Bearer ${config.appToken}`) : null;
  let streamCount = 0;

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) {
      return errorResponse(res, 400, 'Đường dẫn không hợp lệ.');
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return serveStatic(req, res, url, config.staticDir);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    const authority = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.exec(req.headers.host ?? '');
    if (!token && (!authority || !isLoopback(authority[1].toLowerCase()))) {
      return errorResponse(res, 403, 'API không dùng mã truy cập chỉ hỗ trợ địa chỉ loopback.', 'HOST_DENIED');
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!config.allowedOrigins.has(origin)) {
        return errorResponse(res, 403, 'Origin này chưa được máy chủ cho phép.', 'ORIGIN_DENIED');
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return json(res, manager.storageError ? 503 : 200, { ok: !manager.storageError, version, storage: store.kind, authRequired: Boolean(token), ...(manager.storageError && { error: manager.storageError, code: 'STORAGE_ERROR' }) });
    }
    if (token && !timingSafeEqual(token, hash(req.headers.authorization || ''))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return errorResponse(res, 401, 'Cần mã truy cập backend hợp lệ.', 'UNAUTHORIZED');
    }
    if (url.pathname === '/api/live-sessions') {
      if (req.method === 'GET') return json(res, 200, { sessions: (await store.list()).map((session) => manager.sessionState(session)) });
      if (req.method === 'POST') {
        const session = await manager.start(await readBody(req));
        return session
          ? json(res, 201, { session })
          : errorResponse(res, 409, 'Đang có một phiên theo dõi. Hãy dừng phiên hiện tại để mở phiên mới.', 'SESSION_ACTIVE');
      }
      return errorResponse(res, 405, 'Phương thức không được hỗ trợ.');
    }

    const match = /^\/api\/live-sessions\/([0-9a-f-]{36})(?:\/(stop|history|events|export|audience|audience-export))?$/.exec(url.pathname);
    if (!match) return errorResponse(res, 404, 'Không tìm thấy đường dẫn.', 'NOT_FOUND');
    const [, id, route] = match;
    if (req.method !== (route === 'stop' ? 'POST' : 'GET')) {
      return errorResponse(res, 405, 'Phương thức không được hỗ trợ.');
    }
    const session = manager.sessionState(await store.get(id));
    if (!session) return errorResponse(res, 404, 'Không tìm thấy phiên theo dõi.', 'SESSION_NOT_FOUND');
    if (route === 'stop') return json(res, 200, { session: await manager.stop(id) });
    if (route === 'audience') {
      const search = url.searchParams.get('search') || '';
      const filter = url.searchParams.get('filter') || 'all';
      const sort = url.searchParams.get('sort') || 'recent';
      const offset = numberParam(url.searchParams.get('offset'), 0);
      const limit = numberParam(url.searchParams.get('limit'), 50, { min: 1, max: 200 });
      if (search.length > 200 || !['all', 'chat', 'gift'].includes(filter) || !['recent', 'comments', 'gifts', 'likes', 'joins'].includes(sort)) {
        throw statusError(400, 'Bộ lọc người xem không hợp lệ.', 'INVALID_FILTER');
      }
      return json(res, 200, await store.audience(id, { search, filter, sort, offset, limit }));
    }
    if (route === 'audience-export') return exportAudienceCsv(res, store, id);
    if (route === 'history') {
      const after = numberParam(url.searchParams.get('after'), undefined);
      const before = numberParam(url.searchParams.get('before'), undefined);
      if (after !== undefined && before !== undefined) throw statusError(400, 'Chỉ dùng một trong hai cursor after hoặc before.', 'INVALID_PAGINATION');
      const limit = numberParam(url.searchParams.get('limit'), 300, { min: 1, max: 1000 });
      const search = url.searchParams.get('search') || '';
      const type = url.searchParams.get('type') || 'all';
      const userId = url.searchParams.get('userId') || '';
      if (search.length > 200 || userId.length > 160 || !['all', 'chat', 'gift'].includes(type)) throw statusError(400, 'Từ khóa hoặc loại sự kiện không hợp lệ.', 'INVALID_FILTER');
      return json(res, 200, await store.history(id, { after, before, limit, search, type, userId }));
    }
    if (route === 'events') {
      const after = numberParam(url.searchParams.get('after') ?? req.headers['last-event-id'], 0);
      if (streamCount >= MAX_STREAMS) {
        return errorResponse(res, 503, 'Máy chủ đang có quá nhiều kết nối sự kiện.', 'STREAM_LIMIT');
      }
      if (res.destroyed) return;
      streamCount++;
      return streamEvents(res, store, id, after, () => streamCount--);
    }
    if (route === 'export') return exportCsv(res, store, session);
    return json(res, 200, { session });
  }

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch((error) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error.status || clientErrorCodes.has(error.code)) {
        return errorResponse(res, error.status ?? 400, error.message, error.code);
      }
      console.error('Không thể xử lý yêu cầu LiveLens.');
      errorResponse(res, 500, 'Máy chủ chưa thể xử lý yêu cầu này.', 'SERVER_ERROR');
    });
  });
}

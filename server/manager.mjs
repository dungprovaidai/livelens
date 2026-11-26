import { randomUUID } from 'node:crypto';
import {
  ControlEvent, SignatureRateLimitError, SignAPIError, TikTokLiveConnection, UserOfflineError, WebcastEvent,
} from 'tiktok-live-connector';
import { GiftNormalizer, normalizeAudience, normalizeChat, parseTikTokTarget, safeId } from './normalize.mjs';

const connected = 'Đã kết nối với TikTok LIVE.';
const sourceEnded = 'Buổi TikTok LIVE đã kết thúc.';
const sourceGap = 'Kết nối TikTok LIVE bị gián đoạn. Có thể đã bỏ lỡ một số sự kiện.';
const storageProblem = 'Không thể lưu dữ liệu phiên. Đã dừng nhận sự kiện để tránh bỏ sót âm thầm. Kiểm tra dung lượng và kết nối cơ sở dữ liệu, rồi khởi động lại máy chủ.';
const reconnectDelayMs = [1500, 4000, 9000, 20000];
const noop = () => {};

export function createTikTokFactory(signApiKey) {
  return (uniqueId, { signal } = {}) => new TikTokLiveConnection(uniqueId, {
    signApiKey,
    webClientOptions: { signal, timeout: { request: 15000 }, retry: { limit: 0 } },
    wsClientOptions: { signal, handshakeTimeout: 20000 },
  });
}

function sourceProblem(error) {
  if (error instanceof UserOfflineError || error?.name === 'UserOfflineError') {
    return { text: 'Nhà sáng tạo hiện không phát TikTok LIVE.', terminal: true };
  }
  if (error instanceof SignatureRateLimitError) {
    return {
      text: 'Dịch vụ ký kết nối TikTok đang giới hạn yêu cầu.',
      wait: Number.isFinite(error.retryAfter) ? error.retryAfter : 60_000,
    };
  }
  if (error instanceof SignAPIError) {
    return {
      text: 'Dịch vụ ký kết nối TikTok không phản hồi như dự kiến. Hãy kiểm tra cấu hình SIGN_API_KEY.',
      terminal: true,
    };
  }
  return { text: 'Không thể kết nối với TikTok LIVE.' };
}

async function disconnect(connection) {
  try {
    await connection.disconnect();
  } catch {
    // Provider disconnects can race with close events.
  }
}

export class SessionManager {
  #active = null;
  #queue = Promise.resolve();
  #closed = false;
  #storageFailure = null;

  constructor({ store, connectorFactory = createTikTokFactory(), reconnectDelays = reconnectDelayMs }) {
    this.store = store;
    this.connectorFactory = connectorFactory;
    this.reconnectDelays = reconnectDelays;
  }

  #serialize(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(noop);
    return next;
  }

  get storageError() { return this.#storageFailure?.error || ''; }

  sessionState(session) {
    return session && session.id === this.#storageFailure?.id
      ? { ...session, status: 'error', error: this.storageError, endedAt: this.#storageFailure.endedAt }
      : session;
  }

  #dispatch(operation, context = this.#active) {
    this.#serialize(async () => {
      try {
        await operation();
      } catch {
        await this.#failStorage(context);
      }
    }).catch(() => console.error(storageProblem));
  }

  async #failStorage(context) {
    if (!context || this.#storageFailure) return;
    this.#storageFailure = { id: context.id, error: storageProblem, endedAt: new Date().toISOString() };
    if (this.#active?.id === context.id) this.#release(this.#active);
    console.error(storageProblem);
    try {
      await this.store.transition(context.id, { status: 'error', message: storageProblem, error: storageProblem });
    } catch {
      // Keep the failure in memory when the database cannot persist even the error state.
    }
  }

  recover() {
    return this.#serialize(() => this.store.interrupt());
  }

  start({ url, mode } = {}) {
    return this.#serialize(async () => {
      if (this.storageError) throw Object.assign(new Error(this.storageError), { status: 503, code: 'STORAGE_ERROR' });
      if (this.#closed) return null;
      if (!['live', 'demo'].includes(mode) || typeof url !== 'string') {
        throw Object.assign(new Error('Nhập liên kết hoặc @tên_người_dùng và chọn chế độ hợp lệ.'), { code: 'INVALID_REQUEST' });
      }
      const uniqueId = mode === 'demo' && !url.trim() ? 'livelens_demo' : parseTikTokTarget(url);
      const session = await this.store.start({
        uniqueId, mode,
        message: mode === 'demo' ? 'Đang chuẩn bị phiên mô phỏng.' : 'Đang kết nối với TikTok LIVE.',
      });
      if (!session) return null;
      const context = {
        id: session.id, uniqueId, roomId: null, mode, attempts: 0, establishedAt: 0,
        attempt: null, retry: null, demo: null, giftNormalizer: new GiftNormalizer(),
      };
      this.#active = context;
      if (mode === 'demo') this.#dispatch(() => this.#startDemo(context));
      else this.#connect(context);
      return session;
    });
  }

  stop(id) {
    return this.#serialize(async () => {
      if (this.#storageFailure?.id === id) return this.sessionState(await this.store.get(id));
      const context = this.#active?.id === id ? this.#active : null;
      if (context) this.#release(context);
      try {
        return await this.store.transition(id, { status: 'stopped', message: 'Đã dừng theo dõi.' });
      } catch (error) {
        if (!context) throw error;
        await this.#failStorage(context);
        return this.sessionState(await this.store.get(id));
      }
    });
  }

  close() {
    return this.#serialize(() => {
      this.#closed = true;
      if (this.#active) this.#release(this.#active);
    });
  }

  #release(context) {
    this.#active = null;
    clearTimeout(context.retry);
    clearInterval(context.demo);
    this.#detach(context);
  }

  #detach(context) {
    const attempt = context.attempt;
    if (!attempt) return;
    context.attempt = null;
    clearTimeout(attempt.deadline);
    for (const [name, handler] of attempt.listeners) attempt.connection.off(name, handler);
    // An in-flight connector may emit an error after we have detached.
    if (attempt.connection.listenerCount(ControlEvent.ERROR) === 0) attempt.connection.on(ControlEvent.ERROR, noop);
    attempt.controller.abort();
    void disconnect(attempt.connection);
  }

  #connect(context) {
    if (this.#active !== context) return;
    const controller = new AbortController();
    let connection;
    try {
      connection = this.connectorFactory(context.uniqueId, { signal: controller.signal });
    } catch (error) {
      this.#dispatch(() => this.#retry(context, sourceProblem(error)));
      return;
    }
    const attempt = { connection, controller, listeners: [] };
    context.attempt = attempt;
    const listen = (name, handler) => {
      attempt.listeners.push([name, handler]);
      connection.on(name, handler);
    };
    const dispatch = (operation) => this.#dispatch(() => {
      if (this.#active === context && context.attempt === attempt) return operation();
    }, context);
    const record = (normalize) => (payload) => {
      if (!payload || typeof payload !== 'object') return;
      dispatch(() => {
        const room = safeId(payload.common?.roomId, payload.roomId);
        if (!room || !context.roomId || room === context.roomId) {
          return this.store.record(context.id, normalize(payload, context.roomId || safeId(connection.roomId)));
        }
      });
    };
    connection.off(ControlEvent.ERROR, noop);
    listen(ControlEvent.ERROR, noop);
    listen(WebcastEvent.CHAT, record(normalizeChat));
    listen(WebcastEvent.GIFT, record(context.giftNormalizer.normalize.bind(context.giftNormalizer)));
    for (const [name, type] of [[WebcastEvent.ROOM_USER, 'viewers'], [WebcastEvent.MEMBER, 'member'], [WebcastEvent.LIKE, 'like'], [WebcastEvent.FOLLOW, 'follow'], [WebcastEvent.SHARE, 'share']]) {
      listen(name, record((payload, room) => normalizeAudience(payload, room, type)));
    }
    listen(WebcastEvent.STREAM_END, () => dispatch(async () => {
      this.#release(context);
      await this.store.transition(context.id, { status: 'ended', message: sourceEnded });
    }));
    listen(ControlEvent.DISCONNECTED, () => dispatch(() => this.#retry(context, { text: sourceGap })));

    attempt.deadline = setTimeout(() => dispatch(() => this.#retry(context, {
      text: 'TikTok LIVE mất quá nhiều thời gian để kết nối.',
    })), 35000).unref();

    Promise.resolve().then(() => connection.connect(context.roomId || undefined))
      .then((state) => this.#dispatch(async () => {
        if (this.#active !== context || context.attempt !== attempt) {
          void disconnect(connection);
          return;
        }
        clearTimeout(attempt.deadline);
        const roomId = safeId(state?.roomId, connection.roomId);
        if (!roomId || (context.roomId && roomId !== context.roomId)) {
          await this.#retry(context, { text: 'Không thể xác nhận phòng LIVE ban đầu.', terminal: true });
          return;
        }
        context.roomId = roomId;
        context.establishedAt = Date.now();
        await this.store.transition(context.id, { status: 'connected', roomId, message: connected });
      }), (error) => dispatch(() => this.#retry(context, sourceProblem(error))));
  }

  async #retry(context, problem) {
    if (this.#active !== context) return;
    if (context.establishedAt && Date.now() - context.establishedAt > 60_000) context.attempts = 0;
    context.establishedAt = 0;
    this.#detach(context);

    const delay = this.reconnectDelays[context.attempts];
    if (problem.terminal || delay === undefined || problem.wait > 300_000) {
      this.#release(context);
      const message = context.roomId && problem.text !== sourceGap ? `${problem.text} ${sourceGap}` : problem.text;
      await this.store.transition(context.id, { status: 'error', message, error: message });
      return;
    }

    context.attempts++;
    const message = problem.text === sourceGap ? sourceGap : `${problem.text} Có thể đã bỏ lỡ một số sự kiện.`;
    await this.store.transition(context.id, { status: 'reconnecting', message, error: problem.text });
    context.retry = setTimeout(() => this.#dispatch(() => this.#connect(context)), Math.max(delay, problem.wait ?? 0)).unref();
  }

  async #startDemo(context) {
    if (this.#active !== context) return;
    context.roomId = `demo-${context.id}`;
    await this.store.transition(context.id, {
      status: 'connected', roomId: context.roomId, message: 'Đã mở phiên mô phỏng LiveLens.',
    });
    const users = [
      { id: 'demo-1', displayId: 'minh_anh', nickname: 'Minh Anh' },
      { id: 'demo-2', displayId: 'hoangnam', nickname: 'Hoàng Nam' },
      { id: 'demo-3', displayId: 'linhchi', nickname: 'Linh Chi' },
    ];
    const comments = ['Xin chào cả nhà 👋', 'Hôm nay livestream vui quá!', 'Mọi người nghe rõ không ạ?', 'Cảm ơn vì buổi LIVE nhé!'];
    let index = 0;
    const tick = () => this.#dispatch(() => {
      if (this.#active !== context) return;
      const phase = index % 8;
      const common = { msgId: randomUUID(), roomId: context.roomId };
      const user = users[(Math.floor(index / 8) + (phase < 4 ? phase : 0)) % users.length];
      const item = phase < 4
        ? normalizeChat({ common, user, content: comments[phase] })
        : context.giftNormalizer.normalize({
          common, user, giftId: 'demo-hoa-hong', groupId: String(Math.floor(index / 8) + 1),
          repeatCount: [1, 2, 5, 5][phase - 4], repeatEnd: phase === 7 ? 1 : 0,
          gift: { type: 1, name: 'Hoa hồng', diamondCount: 1 },
        });
      index++;
      return this.store.record(context.id, item);
    });
    tick();
    context.demo = setInterval(tick, 1100).unref();
  }
}

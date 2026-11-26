import type { AudienceResponse, HealthResponse, HistoryResponse, LiveEvent, LiveSession } from '../shared/contracts';

export interface Connection {
  origin: string;
  token: string;
}

export interface EventFilter { search: string; type: 'all' | 'chat' | 'gift'; userId?: string }
export interface AudienceFilter { search: string; filter: 'all' | 'chat' | 'gift'; sort: 'recent' | 'comments' | 'gifts' | 'likes' | 'joins'; offset: number }

export function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fullLinkHint = 'Hãy dán liên kết đầy đủ dạng https://www.tiktok.com/@tentaikhoan/live hoặc nhập @tentaikhoan.';

export function normalizeLiveInput(raw: string): string {
  const value = raw.trim();
  if (value.length > 2048 || /[\\\s]/.test(value)) throw new Error(fullLinkHint);
  if (/^@[a-z0-9_.]{1,24}$/i.test(value) && !value.endsWith('.')) return value;

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error(fullLinkHint);
  }

  const officialHost = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname);
  if (['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname) || (officialHost && /^\/t\//i.test(url.pathname))) {
    throw new Error(`Liên kết TikTok rút gọn. ${fullLinkHint}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !officialHost) {
    throw new Error('Hãy nhập liên kết TikTok hợp lệ hoặc @tentaikhoan.');
  }
  const match = url.pathname.match(/^\/@([a-z0-9_.]{1,24})(?:\/live)?\/?$/i);
  if (!match || match[1].endsWith('.')) throw new Error(fullLinkHint);
  return `https://www.tiktok.com/@${match[1]}/live`;
}

export function normalizeOrigin(raw: string): string {
  if (!raw.trim()) return '';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Nhập địa chỉ máy chủ đầy đủ, ví dụ https://live.example.com.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Dùng địa chỉ HTTPS của máy chủ, hoặc HTTP cho localhost khi chạy cục bộ.');
  }
  return url.origin;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

const unavailable = 'Không truy cập được máy chủ LiveLens. Kiểm tra địa chỉ và quyền truy cập từ trang này trong Cài đặt.';

export class LiveClient {
  constructor(private readonly connection: Connection) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (path === '/health') headers.delete('Authorization');
    else if (this.connection.token) headers.set('Authorization', `Bearer ${this.connection.token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const timeout = AbortSignal.timeout(15000);
    const signal = headers.get('Accept') === 'text/event-stream'
      ? init.signal
      : init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.connection.origin}/api${path}`, {
        ...init, headers, signal, cache: 'no-store', redirect: 'error',
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(unavailable);
    }
    if (response.ok) return response;
    const body = await response.json().catch(() => null);
    if (['ORIGIN_DENIED', 'HOST_DENIED'].includes(body?.code)) {
      throw new ApiError(body.error, response.status, body.code);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError('Máy chủ yêu cầu mã truy cập hợp lệ. Kiểm tra mã trong Cài đặt.', response.status, body?.code);
    }
    throw new ApiError(body?.error || unavailable, response.status, body?.code);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new ApiError(unavailable);
    return response.json();
  }

  private sessionPath(id: string): string {
    return `/live-sessions/${encodeURIComponent(id)}`;
  }

  health(signal?: AbortSignal) {
    return this.json<HealthResponse>('/health', { signal });
  }

  async sessions(signal?: AbortSignal) {
    const { sessions } = await this.json<{ sessions: LiveSession[] }>('/live-sessions', { signal });
    if (!Array.isArray(sessions)) throw new ApiError(unavailable);
    return sessions.filter((session) => session.mode === 'live');
  }

  async start(url: string) {
    const { session } = await this.json<{ session: LiveSession }>('/live-sessions', {
      method: 'POST', body: JSON.stringify({ url, mode: 'live' }),
    });
    return session;
  }

  async session(id: string, signal?: AbortSignal) {
    const { session } = await this.json<{ session: LiveSession }>(this.sessionPath(id), { signal });
    return session;
  }

  async stop(id: string) {
    const { session } = await this.json<{ session: LiveSession }>(`${this.sessionPath(id)}/stop`, { method: 'POST' });
    return session;
  }

  history(id: string, signal?: AbortSignal, options: Partial<EventFilter> & { before?: number } = {}) {
    const query = new URLSearchParams({ limit: '300' });
    if (options.before !== undefined) query.set('before', String(options.before));
    if (options.search?.trim()) query.set('search', options.search.trim());
    if (options.type) query.set('type', options.type);
    if (options.userId) query.set('userId', options.userId);
    return this.json<HistoryResponse>(`${this.sessionPath(id)}/history?${query}`, { signal });
  }

  async export(id: string) {
    const response = await this.request(`${this.sessionPath(id)}/export`);
    if (!response.headers.get('Content-Type')?.includes('text/csv')) throw new ApiError(unavailable);
    return response.blob();
  }

  audience(id: string, signal?: AbortSignal, options: Partial<AudienceFilter> = {}) {
    const query = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
    return this.json<AudienceResponse>(`${this.sessionPath(id)}/audience?${query}`, { signal });
  }

  async exportAudience(id: string) {
    const response = await this.request(`${this.sessionPath(id)}/audience-export`);
    if (!response.headers.get('Content-Type')?.includes('text/csv')) throw new ApiError(unavailable);
    return response.blob();
  }

  async stream(
    id: string,
    after: number,
    signal: AbortSignal,
    onOpen: () => void,
    onEvent: (event: LiveEvent) => void,
  ) {
    const watchdog = new AbortController();
    let timer = setTimeout(() => watchdog.abort(), 15000);
    let reader: ReadableStreamDefaultReader<string> | undefined;
    let buffer = '';
    let data: string[] = [];
    let eventType = '';
    let frameId = '';

    try {
      const response = await this.request(`${this.sessionPath(id)}/events?after=${after}`, {
        signal: AbortSignal.any([signal, watchdog.signal]), headers: { Accept: 'text/event-stream' },
      });
      if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
        throw new ApiError(unavailable);
      }
      reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      onOpen();

      while (true) {
        clearTimeout(timer);
        timer = setTimeout(() => watchdog.abort(), 45000);
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += chunk.value;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');

          if (!line) {
            if (eventType === 'event' && data.length > 0) {
              let event: LiveEvent | undefined;
              try {
                event = JSON.parse(data.join('\n')) as LiveEvent;
              } catch {
                // Ignore malformed frames. The next valid sequence still advances the cursor.
              }
              if (event && event.sessionId === id && Number.isSafeInteger(event.seq) && String(event.seq) === frameId) {
                onEvent(event);
              }
            }
            data = [];
            eventType = '';
            frameId = '';
            continue;
          }

          const separator = line.indexOf(':');
          if (separator < 0) continue;
          const value = line.slice(separator + 1).replace(/^ /, '');
          switch (line.slice(0, separator)) {
            case 'data': data.push(value); break;
            case 'id': frameId = value; break;
            case 'event': eventType = value; break;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (reader) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent, LiveSession } from '../shared/contracts';
import { ApiError, LiveClient, type EventFilter } from './client';
import { EVENT_LIMIT, isActive } from './demo';
import { normalizeText } from './preferences';

const streamWarning = 'Đang kết nối lại luồng sự kiện. Các sự kiện đã lưu sẽ được tải lại.';

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Đã có lỗi. Vui lòng thử lại.';
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function useLive(client: LiveClient, enabled: boolean, onAlert: (event: LiveEvent) => void) {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [rows, setRows] = useState<{ id: string; events: LiveEvent[] } | null>(null);
  const [streamError, setStreamError] = useState('');
  const [setupError, setSetupError] = useState('');
  const [loading, setLoading] = useState(false);
  const clientRef = useRef(client);
  const alertRef = useRef(onAlert);
  const revision = useRef(0);
  clientRef.current = client;
  alertRef.current = onAlert;

  const active = sessions.find(isActive);
  const activeId = active?.id;

  const publish = useCallback((session: LiveSession) => {
    if (clientRef.current !== client) return;
    revision.current += 1;
    setSessions((list) => {
      const existing = list.find((item) => item.id === session.id);
      if (existing && !isActive(existing) && isActive(session)) return list;
      if (existing && existing.stats.events > session.stats.events) return list;
      const revised = existing
        ? list.map((item) => item.id === session.id ? session : item)
        : [session, ...list];
      return revised;
    });
  }, [client]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestRevision = revision.current;
    setLoading(true);
    try {
      const result = await client.sessions(signal);
      if (signal?.aborted || client !== clientRef.current) return;
      setSessions((current) => {
        if (requestRevision === revision.current) return result;
        const combined = new Map(result.map((session) => [session.id, session]));
        for (const prior of current) {
          const incoming = combined.get(prior.id);
          if (!incoming || prior.stats.events > incoming.stats.events || (!isActive(prior) && isActive(incoming))) {
            combined.set(prior.id, prior);
          }
        }
        return [...combined.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      });
      setSetupError('');
    } catch (error) {
      if (!signal?.aborted && client === clientRef.current) setSetupError(messageOf(error));
    } finally {
      if (!signal?.aborted && client === clientRef.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    setSessions([]);
    setRows(null);
    setSetupError('');
    setStreamError('');
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false;
    async function update() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      await refresh(controller.signal);
      pending = false;
    }
    function visible() { if (document.visibilityState === 'visible') void update(); }
    void update();
    const timer = window.setInterval(() => void update(), 5000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    const controller = new AbortController();
    const { signal } = controller;
    let lastSeq = 0;
    let failures = 0;
    let latest: LiveEvent[] = [];
    let metadataPending = false;
    let finished = false;

    setRows((current) => current?.id === id ? current : { id, events: [] });

    const sync = async () => {
      if (metadataPending || signal.aborted || finished) return;
      metadataPending = true;
      try {
        const session = await client.session(id, signal);
        if (signal.aborted || clientRef.current !== client) return;
        publish(session);
        finished = !isActive(session);
      } catch (error) {
        if (!signal.aborted) setStreamError(messageOf(error));
      } finally {
        metadataPending = false;
      }
    };

    async function follow() {
      while (!signal.aborted && !finished) {
        const attemptedAt = Date.now();
        try {
          // The saved snapshot fills any gap and gives alerts a clean sequence boundary.
          const page = await client.history(id, signal);
          if (signal.aborted) return;
          if (page.nextCursor >= lastSeq) {
            latest = page.events.slice(-EVENT_LIMIT);
            lastSeq = Math.max(page.nextCursor, latest.at(-1)?.seq ?? 0);
            setRows({ id, events: latest });
          }
          await client.stream(id, lastSeq, signal, () => {
            setStreamError('');
          }, (event) => {
            if (signal.aborted || event.seq <= lastSeq) return;
            lastSeq = event.seq;
            latest = [...latest, event].slice(-EVENT_LIMIT);
            setRows({ id, events: latest });
            if (event.type === 'status') {
              void sync();
            } else {
              alertRef.current(event);
            }
          });
          if (!signal.aborted && !finished) setStreamError(streamWarning);
        } catch (error) {
          if (!signal.aborted && !finished) {
            setStreamError(error instanceof ApiError && [401, 403].includes(error.status ?? 0)
              ? error.message : streamWarning);
          }
        }
        if (signal.aborted || finished) break;
        void sync();
        if (Date.now() - attemptedAt > 6000) failures = 0;
        await wait(Math.min(800 * 2 ** failures, 10000), signal);
        failures += 1;
      }
    }

    const timer = window.setInterval(() => void sync(), 2500);
    void follow();
    return () => {
      controller.abort();
      window.clearInterval(timer);
      setStreamError('');
    };
  }, [activeId, client, publish]);

  return { sessions, rows, active, publish, refresh, loading, setupError, streamError };
}

export interface EventView {
  events: LiveEvent[]; loading: boolean; error: string;
  hasMore?: boolean; loadingMore?: boolean; loadOlder?: () => Promise<void>;
}

export function useArchivedEvents(
  client: LiveClient,
  id: string | undefined,
  activeId: string | undefined,
  liveRows: { id: string; events: LiveEvent[] } | null,
  filter: EventFilter,
): EventView {
  const search = filter.search.trim();
  const type = filter.type;
  const userId = filter.userId;
  const key = JSON.stringify([id, search, type, userId]);
  const [result, setResult] = useState<{ key: string; events: LiveEvent[]; error: string; hasMore: boolean; expanded: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const olderPending = useRef(false);
  const tracked = activeId === id;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    request.current = controller;
    olderPending.current = false;
    setLoadingMore(false);
    setResult(null);
    const timer = window.setTimeout(() => {
      client.history(id, controller.signal, { search, type, userId }).then(
        ({ events, hasMore }) => {
          if (!controller.signal.aborted) setResult({ key, events, hasMore, error: '', expanded: false });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setResult({ key, events: [], hasMore: false, error: messageOf(error), expanded: false });
        },
      );
    }, search ? 250 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [id, client, key, search, type, userId, tracked]);

  const ready = result?.key === key;
  useEffect(() => {
    if (!ready || !tracked || liveRows?.id !== id) return;
    const recent = liveRows?.events;
    if (!recent) return;
    const query = normalizeText(search);
    setResult((current) => {
      if (!current || current.key !== key) return current;
      const last = current.events.at(-1)?.seq ?? 0;
      const incoming = recent.filter((event) => {
        if (event.seq <= last || (type === 'chat' && event.type !== 'chat') || (type === 'gift' && !event.gift)) return false;
        if (userId && event.user?.id !== userId) return false;
        const text = [event.user?.username, event.user?.nickname, event.comment, event.gift?.name, event.message].filter(Boolean).join(' ');
        return !query || normalizeText(text).includes(query);
      });
      if (!incoming.length) return current;
      const events = [...current.events, ...incoming];
      return { ...current, events: current.expanded ? events : events.slice(-EVENT_LIMIT), hasMore: current.hasMore || (!current.expanded && events.length > EVENT_LIMIT) };
    });
  }, [liveRows, ready, id, key, search, type, userId, tracked]);

  async function loadOlder() {
    const controller = request.current;
    if (!id || !ready || !result.hasMore || !result.events.length || !controller || controller.signal.aborted || olderPending.current) return;
    olderPending.current = true;
    setLoadingMore(true);
    try {
      const page = await client.history(id, controller.signal, { before: result.events[0].seq, search, type, userId });
      if (!controller.signal.aborted) setResult((current) => current?.key === key
        ? { ...current, events: [...page.events, ...current.events], hasMore: page.hasMore, error: '', expanded: true }
        : current);
    } catch (error) {
      if (!controller.signal.aborted) setResult((current) => current?.key === key ? { ...current, error: messageOf(error) } : current);
    } finally {
      if (!controller.signal.aborted) { olderPending.current = false; setLoadingMore(false); }
    }
  }

  if (!id) return { events: [], loading: false, error: '' };
  if (ready) return { events: result.events, loading: false, error: result.error, hasMore: result.hasMore, loadingMore, loadOlder };
  return { events: [], loading: true, error: '' };
}

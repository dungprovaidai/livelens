import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeAudienceText, updateViewer } from '../shared/audience.ts';

const interruption = 'Kết nối bị gián đoạn do máy chủ khởi động lại. Có thể đã bỏ lỡ một số sự kiện.';
const terminal = new Set(['stopped', 'ended', 'error']);

function sessionFrom(row) {
  return row && {
    id: row.id,
    uniqueId: row.unique_id,
    roomId: row.room_id,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
    error: row.error,
    stats: {
      comments: Number(row.comments),
      gifts: Number(row.gifts),
      gifters: Number(row.gifters),
      events: Number(row.event_count),
    },
  };
}

function eventFrom(row) {
  return { ...JSON.parse(row.payload), seq: Number(row.seq) };
}

async function sqliteDriver(path) {
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  const statements = new Map();
  const query = (sql, params = []) => {
    if (!statements.has(sql)) statements.set(sql, database.prepare(sql));
    return statements.get(sql).all(...params);
  };
  let pending = Promise.resolve();
  const serialize = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  return {
    kind: 'sqlite',
    exec: (sql) => database.exec(sql),
    read: (sql, params) => serialize(() => query(sql, params)),
    write: (operation) => serialize(async () => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation(query);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => serialize(() => database.close()),
  };
}

async function postgresDriver(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('Kết nối nhàn rỗi đến PostgreSQL bị gián đoạn.'));
  async function query(client, sql, params = []) {
    let position = 0;
    const statement = sql.replace(/\?/g, () => `$${++position}`);
    return (await client.query(statement, params)).rows;
  }
  return {
    kind: 'postgres',
    exec: (sql) => pool.query(sql),
    read: (sql, params) => query(pool, sql, params),
    write: async (operation) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await operation((sql, params) => query(client, sql, params));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function schema(kind) {
  const sequence = kind === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      unique_id TEXT NOT NULL,
      room_id TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      active_slot INTEGER UNIQUE CHECK (active_slot IS NULL OR active_slot = 1),
      created_at TEXT NOT NULL,
      ended_at TEXT,
      last_event_at TEXT,
      error TEXT,
      comments BIGINT NOT NULL DEFAULT 0,
      gifts BIGINT NOT NULL DEFAULT 0,
      gifters BIGINT NOT NULL DEFAULT 0,
      event_count BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      seq ${sequence},
      session_id TEXT NOT NULL REFERENCES sessions(id),
      source_key TEXT,
      completion_key TEXT,
      payload TEXT NOT NULL,
      UNIQUE(session_id, source_key),
      UNIQUE(session_id, completion_key)
    );
    CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
    CREATE TABLE IF NOT EXISTS session_gifters (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      user_id TEXT NOT NULL,
      PRIMARY KEY(session_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS audience_sessions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id), last_seq BIGINT NOT NULL DEFAULT 0,
      current_viewers BIGINT, peak_viewers BIGINT, viewers_at TEXT, total_likes BIGINT
    );
    CREATE TABLE IF NOT EXISTS audience_viewers (
      session_id TEXT NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL,
      user_data TEXT NOT NULL, search_name TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      comments BIGINT NOT NULL, gifts BIGINT NOT NULL, likes BIGINT NOT NULL,
      joins BIGINT NOT NULL, follows BIGINT NOT NULL, shares BIGINT NOT NULL,
      PRIMARY KEY(session_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS audience_samples (
      seq BIGINT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), timestamp TEXT NOT NULL, viewer_count BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audience_samples_session_seq ON audience_samples(session_id, seq);
  `;
}

function viewerFrom(row) {
  return row && {
    user: JSON.parse(row.user_data), firstSeen: row.first_seen, lastSeen: row.last_seen,
    ...Object.fromEntries(['comments', 'gifts', 'likes', 'joins', 'follows', 'shares'].map((name) => [name, Number(row[name])])),
  };
}

async function projectAudience(query, sessionId, event) {
  const [applied] = await query(`INSERT INTO audience_sessions(session_id, last_seq) VALUES(?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq
    WHERE audience_sessions.last_seq < excluded.last_seq RETURNING last_seq`, [sessionId, event.seq]);
  if (!applied) return;
  if (event.type === 'viewers' && event.viewerCount !== undefined) {
    await query(`UPDATE audience_sessions SET current_viewers = ?, peak_viewers = CASE WHEN peak_viewers IS NULL OR peak_viewers < ? THEN ? ELSE peak_viewers END, viewers_at = ? WHERE session_id = ?`,
      [event.viewerCount, event.viewerCount, event.viewerCount, event.timestamp, sessionId]);
    await query('INSERT INTO audience_samples(seq, session_id, timestamp, viewer_count) VALUES(?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [event.seq, sessionId, event.timestamp, event.viewerCount]);
  }
  if (event.totalLikeCount !== undefined) {
    await query('UPDATE audience_sessions SET total_likes = CASE WHEN total_likes IS NULL OR total_likes < ? THEN ? ELSE total_likes END WHERE session_id = ?',
      [event.totalLikeCount, event.totalLikeCount, sessionId]);
  }
  if (event.user?.id && event.user.id !== 'unknown') {
    const [previous] = await query('SELECT * FROM audience_viewers WHERE session_id = ? AND user_id = ?', [sessionId, event.user.id]);
    const viewer = updateViewer(viewerFrom(previous), event);
    await query(`INSERT INTO audience_viewers(session_id, user_id, user_data, search_name, first_seen, last_seen, comments, gifts, likes, joins, follows, shares)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, user_id) DO UPDATE SET
      user_data = excluded.user_data, search_name = excluded.search_name, first_seen = excluded.first_seen, last_seen = excluded.last_seen,
      comments = excluded.comments, gifts = excluded.gifts, likes = excluded.likes, joins = excluded.joins, follows = excluded.follows, shares = excluded.shares`,
    [sessionId, viewer.user.id, JSON.stringify(viewer.user), normalizeAudienceText(`${viewer.user.nickname} ${viewer.user.username}`),
      viewer.firstSeen, viewer.lastSeen, viewer.comments, viewer.gifts, viewer.likes, viewer.joins, viewer.follows, viewer.shares]);
  }
}

function statusEvent(status, message) {
  return { id: randomUUID(), type: 'status', timestamp: new Date().toISOString(), status, message };
}

async function insertEvent(query, sessionId, { event, sourceKey, completionKey, comboKey }) {
  if (comboKey && !completionKey) {
    const completed = await query('SELECT 1 FROM events WHERE session_id = ? AND completion_key = ?', [sessionId, comboKey]);
    if (completed.length) return null;
  }
  const stored = { ...event, sessionId };
  const [row] = await query(`
    INSERT INTO events(session_id, source_key, completion_key, payload) VALUES(?, ?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING seq
  `, [sessionId, sourceKey ?? null, completionKey ?? null, JSON.stringify(stored)]);
  if (!row) return null;

  const isGift = event.type === 'gift.completed';
  const gifters = isGift ? await query(`
    INSERT INTO session_gifters(session_id, user_id) VALUES(?, ?)
    ON CONFLICT DO NOTHING RETURNING user_id
  `, [sessionId, event.user.id]) : [];
  await query(`
    UPDATE sessions SET last_event_at = ?, comments = comments + ?, gifts = gifts + ?,
      gifters = gifters + ?, event_count = event_count + 1 WHERE id = ?
  `, [
    new Date().toISOString(),
    event.type === 'chat' ? 1 : 0,
    isGift ? event.gift.quantity : 0,
    gifters.length,
    sessionId,
  ]);
  const recorded = { ...stored, seq: Number(row.seq) };
  await projectAudience(query, sessionId, recorded);
  return recorded;
}

export async function createStore({ databaseUrl, sqlitePath = 'data/livelens.sqlite' } = {}) {
  const database = databaseUrl ? await postgresDriver(databaseUrl) : await sqliteDriver(sqlitePath);
  try {
    await database.exec(schema(database.kind));
    while (true) {
      const processed = await database.write(async (query) => {
        const rows = await query(`SELECT events.seq, events.session_id, events.payload FROM events
          LEFT JOIN audience_sessions ON audience_sessions.session_id = events.session_id
          WHERE events.seq > COALESCE(audience_sessions.last_seq, 0) ORDER BY events.seq LIMIT 500`);
        for (const row of rows) await projectAudience(query, row.session_id, eventFrom(row));
        return rows.length;
      });
      if (!processed) break;
    }
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
  const signal = new EventEmitter();
  signal.setMaxListeners(0);
  const lock = database.kind === 'postgres' ? ' FOR UPDATE' : '';
  const selectById = 'SELECT * FROM sessions WHERE id = ?';

  async function viewers(id, { search = '', filter = 'all', sort = 'recent', offset = 0, limit = 50, afterId } = {}) {
    const conditions = ['session_id = ?'];
    const params = [id];
    if (afterId !== undefined) { conditions.push('user_id > ?'); params.push(afterId); }
    if (filter === 'chat') conditions.push('comments > 0');
    if (filter === 'gift') conditions.push('gifts > 0');
    if (search.trim()) {
      conditions.push("search_name LIKE ? ESCAPE '!'");
      params.push(`%${normalizeAudienceText(search.trim()).replace(/[!%_]/g, '!$&')}%`);
    }
    const where = conditions.join(' AND ');
    const [count] = await database.read(`SELECT COUNT(*) AS total FROM audience_viewers WHERE ${where}`, params);
    const order = { recent: 'last_seen DESC', comments: 'comments DESC', gifts: 'gifts DESC', likes: 'likes DESC', joins: 'joins DESC', id: 'user_id ASC' }[sort] || 'last_seen DESC';
    const rows = await database.read(`SELECT * FROM audience_viewers WHERE ${where} ORDER BY ${order}, user_id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { viewers: rows.map(viewerFrom), total: Number(count.total), offset, hasMore: offset + rows.length < Number(count.total) };
  }

  async function transitionRecord(query, current, { status, message, roomId, error }) {
    const endedAt = terminal.has(status) ? new Date().toISOString() : null;
    await query(`
      UPDATE sessions SET status = ?, room_id = ?, ended_at = ?, error = ?, active_slot = ? WHERE id = ?
    `, [status, roomId ?? current.room_id, endedAt, error ?? null, endedAt ? null : 1, current.id]);
    const event = await insertEvent(query, current.id, { event: statusEvent(status, message) });
    const [row] = await query(selectById, [current.id]);
    return { event, session: sessionFrom(row) };
  }

  const notify = (event) => {
    if (event) signal.emit(event.sessionId);
  };

  return {
    kind: database.kind,
    async start({ uniqueId, mode, message }) {
      const result = await database.write(async (query) => {
        const createdAt = new Date().toISOString();
        const id = randomUUID();
        const [created] = await query(`
          INSERT INTO sessions(id, unique_id, mode, status, active_slot, created_at)
          VALUES(?, ?, ?, 'connecting', 1, ?) ON CONFLICT(active_slot) DO NOTHING RETURNING id
        `, [id, uniqueId, mode, createdAt]);
        if (!created) return null;
        const event = await insertEvent(query, id, { event: statusEvent('connecting', message) });
        const [row] = await query(selectById, [id]);
        return { event, session: sessionFrom(row) };
      });
      notify(result?.event);
      return result?.session ?? null;
    },

    async get(id) {
      const [row] = await database.read(selectById, [id]);
      return sessionFrom(row) ?? null;
    },

    async list() {
      return (await database.read('SELECT * FROM sessions ORDER BY created_at DESC, id DESC')).map(sessionFrom);
    },

    async transition(id, update) {
      const result = await database.write(async (query) => {
        const [current] = await query(selectById + lock, [id]);
        if (!current || !current.active_slot) return { session: sessionFrom(current) ?? null };
        return transitionRecord(query, current, update);
      });
      notify(result.event);
      return result.session;
    },

    async interrupt() {
      const event = await database.write(async (query) => {
        const [active] = await query('SELECT * FROM sessions WHERE active_slot = 1' + lock);
        if (!active) return null;
        const result = await transitionRecord(query, active, { status: 'error', message: interruption, error: interruption });
        return result.event;
      });
      notify(event);
    },

    async record(id, item) {
      if (!item) return null;
      const event = await database.write(async (query) => {
        const [current] = await query('SELECT active_slot FROM sessions WHERE id = ?' + lock, [id]);
        if (!current?.active_slot) return null;
        return insertEvent(query, id, item);
      });
      notify(event);
      return event;
    },

    async history(id, { after, before, limit, search = '', type = 'all', userId = '' }) {
      const normalize = (value) => value.normalize('NFD').replace(/\p{Mark}/gu, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi');
      const query = normalize(search.trim());
      const ascending = after !== undefined;
      let cursor = after ?? before;
      const found = [];
      const batchSize = query || type !== 'all' ? Math.max(500, limit + 1) : limit + 1;
      while (found.length <= limit) {
        const condition = cursor === undefined ? '' : ` AND seq ${ascending ? '>' : '<'} ?`;
        const params = cursor === undefined ? [id, batchSize] : [id, cursor, batchSize];
        const rows = await database.read(`SELECT seq, payload FROM events WHERE session_id = ?${condition} ORDER BY seq ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, params);
        for (const row of rows) {
          const event = eventFrom(row);
          if (userId && event.user?.id !== userId) continue;
          if (type === 'chat' && event.type !== 'chat') continue;
          if (type === 'gift' && !event.gift) continue;
          const text = [event.user?.username, event.user?.nickname, event.comment, event.gift?.name, event.message].filter(Boolean).join(' ');
          if (!query || normalize(text).includes(query)) found.push(event);
          if (found.length > limit) break;
        }
        if (rows.length < batchSize || found.length > limit) break;
        cursor = Number(rows.at(-1).seq);
      }
      const hasMore = found.length > limit;
      const events = found.slice(0, limit);
      if (!ascending) events.reverse();
      return { events, nextCursor: events.at(-1)?.seq ?? after ?? 0, hasMore };
    },

    viewers,

    async audience(id, options) {
      const page = await viewers(id, options);
      const [state] = await database.read('SELECT * FROM audience_sessions WHERE session_id = ?', [id]);
      const [totals] = await database.read('SELECT COUNT(*) AS known_viewers, COALESCE(SUM(joins), 0) AS joins, COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(follows), 0) AS follows, COALESCE(SUM(shares), 0) AS shares FROM audience_viewers WHERE session_id = ?', [id]);
      const step = Math.max(1, Math.ceil(Number(state?.last_seq ?? 0) / 120));
      const samples = await database.read(`SELECT seq, timestamp, viewer_count FROM audience_samples WHERE session_id = ? AND seq IN
        (SELECT MAX(seq) FROM audience_samples WHERE session_id = ? GROUP BY CAST(seq / ? AS BIGINT)) ORDER BY seq`, [id, id, step]);
      return {
        ...page, currentViewers: state?.current_viewers == null ? null : Number(state.current_viewers),
        peakViewers: state?.peak_viewers == null ? null : Number(state.peak_viewers), updatedAt: state?.viewers_at ?? null,
        totalLikes: state?.total_likes == null ? null : Number(state.total_likes),
        knownViewers: Number(totals.known_viewers), joins: Number(totals.joins), likes: Number(totals.likes), follows: Number(totals.follows), shares: Number(totals.shares),
        samples: samples.map((row) => ({ seq: Number(row.seq), timestamp: row.timestamp, count: Number(row.viewer_count) })),
      };
    },

    async latestSequence(id) {
      const [row] = await database.read('SELECT MAX(seq) AS seq FROM events WHERE session_id = ?', [id]);
      return Number(row.seq ?? 0);
    },

    subscribe(id, notifyChange) {
      signal.on(id, notifyChange);
      return () => signal.off(id, notifyChange);
    },

    async close() {
      await database.close();
      signal.removeAllListeners();
    },
  };
}

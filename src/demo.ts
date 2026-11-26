import type { AudienceData, LiveEvent, LiveGift, LiveSession, LiveUser, ViewerSummary } from '../shared/contracts';
import { addAudienceEvent, emptyAudience } from '../shared/audience.ts';

export const EVENT_LIMIT = 300;
const DEMO_KEY = 'livelens.demo.v1';
const DEMO_LIMIT = 12;

export interface DemoRecord {
  session: LiveSession;
  events: LiveEvent[];
  tick: number;
  gifters: string[];
  audience?: AudienceData;
}

const an: LiveUser = { id: 'an', username: 'an.nguyen', nickname: 'An Nguyễn' };
const linh: LiveUser = { id: 'linh', username: 'linh.chi', nickname: 'Linh Chi' };
const minh: LiveUser = { id: 'minh', username: 'minh.tuan', nickname: 'Minh Tuấn' };
const tram: LiveUser = { id: 'tram', username: 'tram.anh', nickname: 'Trâm Anh' };
const ha: LiveUser = { id: 'ha', username: 'ha.my', nickname: 'Hà My' };
const duong: LiveUser = { id: 'duong', username: 'duong.pham', nickname: 'Dương Phạm' };

const rose = { id: 'rose', name: 'Hoa hồng', diamonds: 1 };
const heart = { id: 'heart', name: 'Tim tay', diamonds: 5 };
const bear = { id: 'bear', name: 'Gấu bông', diamonds: 10 };

function chat(user: LiveUser, comment: string): Omit<LiveEvent, 'id' | 'seq' | 'sessionId' | 'timestamp'> {
  return { type: 'chat', user, comment };
}

function gift(
  user: LiveUser,
  item: Omit<LiveGift, 'quantity' | 'streakId' | 'isFinal'>,
  quantity: number,
  streakId: string,
  isFinal = true,
): Omit<LiveEvent, 'id' | 'seq' | 'sessionId' | 'timestamp'> {
  return {
    type: isFinal ? 'gift.completed' : 'gift.progress',
    user,
    gift: { ...item, quantity, streakId, isFinal },
  };
}

const seed: Omit<LiveEvent, 'id' | 'seq' | 'sessionId' | 'timestamp'>[] = [
  { type: 'viewers', viewerCount: 128 },
  { type: 'member', user: duong },
  chat(duong, 'Chào mọi người! 👋'),
  chat(linh, 'Hôm nay lên live sớm quá nè! ✨'),
  gift(an, rose, 12, 'seed-rose'),
  chat(minh, 'Âm thanh rõ lắm nha.'),
  chat(tram, 'Chiếc áo này còn màu trắng không ạ?'),
  gift(linh, heart, 5, 'seed-heart'),
  chat(ha, 'Shop ơi cho mình xin giá mẫu đang cầm với ạ.'),
  gift(minh, bear, 2, 'seed-bear'),
  chat(an, 'Mới vào live, chào cả nhà 🌷'),
  { type: 'like', user: linh, likeCount: 15, totalLikeCount: 1250 },
  { type: 'follow', user: ha },
  { type: 'share', user: tram, shareCount: 1 },
  { type: 'viewers', viewerCount: 156 },
];

export function isActive(session: LiveSession | undefined): boolean {
  return Boolean(session && ['connecting', 'connected', 'reconnecting'].includes(session.status));
}

function makeEvent(
  sessionId: string, seq: number, timestamp: string, payload: Omit<LiveEvent, 'id' | 'seq' | 'sessionId' | 'timestamp'>,
): LiveEvent {
  return { ...payload, id: `${sessionId}-${seq}`, seq, sessionId, timestamp };
}

function seededDemo(id: string, now: number, running: boolean): DemoRecord {
  const events = seed.map((payload, index) =>
    makeEvent(id, index + 1, new Date(now - (seed.length - index) * 9000).toISOString(), payload),
  );
  return {
    session: {
      id, uniqueId: 'phong_mau', roomId: null, mode: 'demo', status: running ? 'connected' : 'stopped',
      createdAt: new Date(now - seed.length * 9000).toISOString(),
      endedAt: running ? null : new Date(now).toISOString(), lastEventAt: events.at(-1)!.timestamp, error: null,
      stats: { comments: 6, gifts: 19, gifters: 3, events: events.length },
    },
    events, tick: 0, gifters: [an.id, linh.id, minh.id], audience: events.reduce(addAudienceEvent, emptyAudience()),
  };
}

export function sampleDemo(): DemoRecord {
  return seededDemo('preview', Date.now(), false);
}

export function startDemo(): DemoRecord {
  return seededDemo(`demo-${crypto.randomUUID()}`, Date.now(), true);
}

export function stopDemo(record: DemoRecord, endedAt = new Date().toISOString()): DemoRecord {
  return { ...record, session: { ...record.session, status: 'stopped', endedAt } };
}

export function nextDemoEvent(record: DemoRecord): DemoRecord {
  if (!isActive(record.session)) return record;
  const cycle = record.tick % 14;
  const streak = `stream-${Math.floor(record.tick / 14)}`;
  const payloads: Omit<LiveEvent, 'id' | 'seq' | 'sessionId' | 'timestamp'>[] = [
    chat(tram, 'Mọi người đang xem mẫu nào vậy ạ? 👀'),
    gift(an, rose, 2, streak, false),
    gift(an, rose, 6, streak),
    chat(minh, 'Cảm ơn shop đã tư vấn nha!'),
    chat(duong, 'Mình xin giá và bảng size với ạ.'),
    gift(ha, heart, 3, `${streak}-heart`),
    chat(linh, 'Mẫu này phối đồ dễ lắm đó ✨'),
    gift(tram, bear, 1, `${streak}-bear`),
    { type: 'viewers', viewerCount: 150 + record.tick % 55 },
    { type: 'member', user: ha },
    { type: 'like', user: linh, likeCount: 8, totalLikeCount: 1265 + record.tick * 8 },
    { type: 'follow', user: duong },
    { type: 'share', user: minh, shareCount: 1 },
    { type: 'viewers', viewerCount: 142 + record.tick % 47 },
  ];
  const payload = payloads[cycle];
  const timestamp = new Date().toISOString();
  const event = makeEvent(record.session.id, (record.events.at(-1)?.seq ?? 0) + 1, timestamp, payload);
  const gifters = event.type === 'gift.completed' && event.user && !record.gifters.includes(event.user.id)
    ? [...record.gifters, event.user.id]
    : record.gifters;
  const stats = record.session.stats;
  return {
    session: {
      ...record.session, lastEventAt: timestamp,
      stats: {
        comments: stats.comments + Number(event.type === 'chat'),
        gifts: stats.gifts + (event.type === 'gift.completed' ? (event.gift?.quantity ?? 0) : 0),
        gifters: gifters.length,
        events: stats.events + 1,
      },
    },
    events: [...record.events, event].slice(-EVENT_LIMIT),
    tick: record.tick + 1,
    gifters,
    audience: addAudienceEvent(record.audience ?? record.events.reduce(addAudienceEvent, emptyAudience()), event),
  };
}

export function loadDemoRecords(): DemoRecord[] {
  try {
    const records = JSON.parse(localStorage.getItem(DEMO_KEY) || '[]') as DemoRecord[];
    const retained = records.filter((record) => record.session.mode === 'demo' && Array.isArray(record.events))
      .slice(0, DEMO_LIMIT);
    if (!retained.some((record) => isActive(record.session))) return retained;

    const repaired = retained.map((record) => {
      if (!isActive(record.session)) return record;
      const { createdAt, lastEventAt } = record.session;
      const endedAt = lastEventAt && Date.parse(lastEventAt) >= Date.parse(createdAt) ? lastEventAt : createdAt;
      return stopDemo(record, endedAt);
    });
    saveDemoRecords(repaired);
    return repaired;
  } catch {
    return [];
  }
}

export function saveDemoRecords(records: DemoRecord[]) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(records.slice(0, DEMO_LIMIT)));
  } catch {
    // The current tab can still use demo when browser storage is unavailable.
  }
}

function csvCell(raw: string | number | undefined): string {
  let value = String(raw ?? '');
  if (/^(?:[\s\p{Cf}]*[=+\-@＝＋－＠]|[\t\r\n])/u.test(value)) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
}

export function demoCsv(events: LiveEvent[]): Blob {
  const rows = [
    ['Nguồn', 'Thời gian', 'Loại', 'Tài khoản', 'Tên hiển thị', 'Nội dung', 'Quà tặng', 'Số lượng'],
    ...events.map((event) => [
      'Dữ liệu mẫu', event.timestamp, event.type, event.user?.username, event.user?.nickname,
      event.comment, event.gift?.name, event.gift?.quantity,
    ]),
  ];
  return new Blob(['\uFEFF', rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

export function demoAudienceCsv(viewers: ViewerSummary[]): Blob {
  const rows = [
    ['Nguồn', 'ID', 'Tài khoản', 'Tên', 'Bình luận', 'Quà', 'Like', 'Lượt vào', 'Follow', 'Chia sẻ', 'Lần đầu', 'Gần nhất'],
    ...viewers.map((viewer) => ['Dữ liệu mẫu', viewer.user.id, viewer.user.username, viewer.user.nickname,
      viewer.comments, viewer.gifts, viewer.likes, viewer.joins, viewer.follows, viewer.shares, viewer.firstSeen, viewer.lastSeen]),
  ];
  return new Blob(['\uFEFF', rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

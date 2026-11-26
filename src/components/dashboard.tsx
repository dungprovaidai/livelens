import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDown, ArrowUpRight, AudioLines, Clock3, Download, Gift, Link2, Maximize2, MessageCircle, MessagesSquare,
  Minimize2, Minus, Music2, Pause, Play, Plus, Radio, Search, Settings2, Square, UsersRound, Wifi, X,
} from 'lucide-react';
import type { LiveEvent, LiveSession, LiveUser } from '../../shared/contracts';
import type { EventFilter } from '../client';
import type { EventView } from '../useLive';
import { normalizeText, readSetting, writeSetting } from '../preferences';
import { Avatar, Empty, ErrorNotice, GiftIcon, StatusPill, formatCount, formatTime } from './ui';

export type Mode = 'demo' | 'live';

export function ConnectionCard({
  mode, active, statusSession, sample, busy, issue, streamIssue, url, setUrl, setMode, onAction, onSettings,
}: {
  mode: Mode; active?: LiveSession; statusSession?: LiveSession; sample: boolean; busy: boolean;
  issue: string; streamIssue: boolean; url: string; setUrl: (value: string) => void;
  setMode: (value: Mode) => void; onAction: (event: FormEvent<HTMLFormElement>) => void;
  onSettings: () => void;
}) {
  const demo = mode === 'demo';
  const inputLabel = demo ? 'Phòng demo' : 'Liên kết LIVE hoặc tên tài khoản';
  return <section className="card connection-card" aria-labelledby="connection-heading">
    <div className="connection-top">
      <div className="connection-provider">
        <span className="provider-icon" aria-hidden="true"><Music2 size={25} strokeWidth={2.6} /></span>
        <div>
          <div className="connection-title"><h2 id="connection-heading">TikTok LIVE</h2><StatusPill status={statusSession?.status} demo={demo} isSample={sample} streamIssue={streamIssue} /></div>
          <p>{demo ? 'Thử với dữ liệu minh họa.' : 'Kết nối phòng LIVE để đọc bình luận.'}</p>
        </div>
      </div>
      <div className="mode-options" role="group" aria-label="Nguồn dữ liệu">
        <button className={demo ? 'selected' : ''} type="button" aria-pressed={demo} disabled={busy || Boolean(active)} onClick={() => setMode('demo')}><AudioLines size={16} /> Demo</button>
        <button className={!demo ? 'selected' : ''} type="button" aria-pressed={!demo} disabled={busy || Boolean(active)} onClick={() => setMode('live')}><Radio size={16} /> LIVE thật</button>
      </div>
    </div>
    <form className="connection-form" onSubmit={onAction}>
      <div className="field-grow">
        <label htmlFor="live-url" className="sr-only">{inputLabel}</label>
        <div className={`input-wrap ${demo || active ? 'input-static' : ''}`}>
          <Link2 size={17} />
          <input
            id="live-url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={demo ? 'Phòng LIVE mẫu' : (active ? `@${active.uniqueId}` : url)}
            disabled={demo || Boolean(active) || busy}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.tiktok.com/@tentaikhoan/live"
            type="text"
          />
        </div>
      </div>
      <button type="submit" className={`button ${active ? 'button-stop' : 'button-primary'}`} disabled={busy}>
        {active ? <Square size={15} fill="currentColor" /> : demo ? <Play size={17} fill="currentColor" /> : <Wifi size={18} />}
        {busy ? 'Đang xử lý…' : active ? 'Dừng theo dõi' : demo ? 'Chạy demo' : 'Theo dõi'}
      </button>
      {!demo && <button className="button button-icon" aria-label="Cài đặt kết nối" title="Cài đặt kết nối" type="button" onClick={onSettings}><Settings2 size={19} /></button>}
    </form>
    {issue && <ErrorNotice message={issue}>{!demo && <button className="text-button" type="button" onClick={onSettings}>Cài đặt <ArrowUpRight size={15} /></button>}</ErrorNotice>}
  </section>;
}

function formatDuration(session: LiveSession | undefined, now: number) {
  if (!session) return '—';
  const end = session.endedAt ? Date.parse(session.endedAt) : now;
  const total = Math.max(0, Math.floor((end - Date.parse(session.createdAt)) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).slice(hours ? 0 : 1).join(':');
}

export function Metrics({ session, now }: { session?: LiveSession; now: number }) {
  const stats = session?.stats;
  const cards = [
    { title: 'Bình luận', value: stats?.comments, caption: 'Tin nhắn đã nhận', icon: MessageCircle, color: 'blue' },
    { title: 'Quà tặng', value: stats?.gifts, caption: 'Số lượng đã chốt', icon: Gift, color: 'rose' },
    { title: 'Người tặng', value: stats?.gifters, caption: 'Tài khoản đã gửi quà', icon: UsersRound, color: 'mint' },
    { title: 'Thời gian phiên', value: formatDuration(session, now), caption: 'Từ khi bắt đầu theo dõi', icon: Clock3, color: 'violet' },
  ];
  return <section className="metrics" aria-label="Thống kê phiên">
    {cards.map(({ title, value, caption, icon: Icon, color }) => <article className="card metric" key={title}>
      <div className="metric-top"><span className={`metric-icon tone-${color}`}><Icon size={20} strokeWidth={1.9} /></span><h2>{title}</h2></div>
      <div className="metric-value">{typeof value === 'number' ? formatCount(value) : value ?? '—'}</div>
      <p>{caption}</p>
    </article>)}
  </section>;
}

type Filter = EventFilter['type'];
const tabs: { id: Filter; label: string }[] = [
  { id: 'chat', label: 'Bình luận' }, { id: 'all', label: 'Tất cả' }, { id: 'gift', label: 'Quà tặng' },
];

export function Activity({ session, events, loading, error, onExport, exporting, filter, setFilter, hasMore, loadingMore, loadOlder, alertControls }: EventView & {
  session?: LiveSession; onExport: () => void; exporting: boolean;
  filter: EventFilter; setFilter: (filter: EventFilter) => void;
  alertControls?: ReactNode;
}) {
  const { type: tab, search } = filter;
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [fontSize, setFontSize] = useState(() => {
    const saved = Number(readSetting('livelens.reader.fontSize'));
    return [18, 22, 26, 30].includes(saved) ? saved : 22;
  });
  const [fullscreen, setFullscreen] = useState(false);
  const [viewError, setViewError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const olderScroll = useRef<{ height: number; top: number; first: number | undefined } | null>(null);
  const paused = pausedAt !== null;
  const visible = useMemo(() => {
    const query = normalizeText(search.trim());
    return events.filter((event) => {
      if (tab === 'chat' && event.type !== 'chat') return false;
      if (tab === 'gift' && !event.gift) return false;
      if (filter.userId && event.user?.id !== filter.userId) return false;
      const text = [event.user?.username, event.user?.nickname, event.comment, event.gift?.name, event.message].filter(Boolean).join(' ');
      return !query || normalizeText(text).includes(query);
    });
  }, [events, search, tab, filter.userId]);
  const unread = paused ? visible.filter((event) => event.seq > pausedAt).length : 0;

  useEffect(() => { olderScroll.current = null; setPausedAt(null); }, [session?.id, tab, search]);
  useEffect(() => {
    function changed() { setFullscreen(document.fullscreenElement === panel.current); }
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useLayoutEffect(() => {
    if (olderScroll.current && list.current && visible[0]?.seq !== olderScroll.current.first) {
      list.current.scrollTop = olderScroll.current.top + list.current.scrollHeight - olderScroll.current.height;
      olderScroll.current = null;
      return;
    }
    if (!paused && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [visible, paused, session?.id, fontSize, fullscreen]);

  function changeFontSize(value: number) {
    setFontSize(value);
    writeSetting('livelens.reader.fontSize', String(value));
  }

  async function toggleFullscreen() {
    setViewError('');
    try {
      if (document.fullscreenElement === panel.current) await document.exitFullscreen();
      else await panel.current?.requestFullscreen();
    } catch {
      setViewError('Trình duyệt chưa cho phép toàn màn hình. Bạn có thể dùng phím F11.');
    }
  }

  return <section ref={panel} className="card activity-panel" aria-labelledby="activity-heading" style={{ '--comment-size': `${fontSize}px` } as CSSProperties}>
    <div className="panel-header reader-header">
      <div className="panel-title"><span className="panel-heading-icon"><MessagesSquare size={21} /></span><div><h2 id="activity-heading">Luồng bình luận</h2><p>{session?.mode === 'demo' ? 'Phòng demo · Dữ liệu minh họa' : session ? `@${session.uniqueId}` : 'Chờ kết nối phòng LIVE'}</p></div></div>
      <div className="reader-view-tools">
        <div className="font-control" role="group" aria-label="Cỡ chữ bình luận">
          <button type="button" className="icon-button" aria-label="Giảm cỡ chữ bình luận" title="Giảm cỡ chữ" disabled={fontSize === 18} onClick={() => changeFontSize(fontSize - 4)}><Minus size={15} /></button>
          <span aria-live="polite">{fontSize}<small>px</small></span>
          <button type="button" className="icon-button" aria-label="Tăng cỡ chữ bình luận" title="Tăng cỡ chữ" disabled={fontSize === 30} onClick={() => changeFontSize(fontSize + 4)}><Plus size={15} /></button>
        </div>
        <button className="button button-small fullscreen-button" type="button" onClick={() => void toggleFullscreen()} disabled={!document.fullscreenEnabled} aria-label={fullscreen ? 'Thoát toàn màn hình' : 'Đọc toàn màn hình'} title={fullscreen ? 'Thoát toàn màn hình (Esc)' : 'Đọc toàn màn hình'}>
          {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}<span>{fullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}</span>
        </button>
      </div>
    </div>
    {alertControls}
    <div className="activity-tools">
      <div className="activity-tabs" role="group" aria-label="Loại sự kiện">
        {tabs.map((item) => <button key={item.id} type="button" aria-pressed={item.id === tab} className={item.id === tab ? 'selected' : ''} onClick={() => setFilter({ ...filter, type: item.id })}>{item.label}</button>)}
      </div>
      <div className="activity-actions">
        <div className="input-wrap feed-search">
          <Search size={16} />
          <input value={search} maxLength={200} onChange={(event) => setFilter({ ...filter, search: event.target.value })} placeholder="Tìm bình luận, tên người xem…" aria-label="Tìm theo nội dung hoặc tài khoản" type="search" />
          {search && <button type="button" className="icon-button clear-search" aria-label="Xóa tìm kiếm" onClick={() => setFilter({ ...filter, search: '' })}><X size={15} /></button>}
        </div>
      </div>
    </div>
    {viewError && <ErrorNotice message={viewError} />}
    {error && visible.length > 0 && <ErrorNotice message={error} />}
    {session?.mode === 'live' && <div className="history-scope"><span>{search ? 'Tìm trong toàn bộ phiên đã lưu' : hasMore ? 'Còn tin cũ trong phiên' : 'Đã tải toàn bộ tin phù hợp'}</span>{hasMore && <button type="button" className="text-button" disabled={loadingMore} onClick={() => {
      if (list.current) olderScroll.current = { height: list.current.scrollHeight, top: list.current.scrollTop, first: visible[0]?.seq };
      setPausedAt(events.at(-1)?.seq ?? 0);
      void loadOlder?.();
    }}>{loadingMore ? 'Đang tải…' : 'Tải tin cũ hơn'}</button>}</div>}
    <div className="feed-body">
    <div className="feed-scroll" ref={list} tabIndex={0} aria-label="Danh sách hoạt động" onScroll={(event) => {
      const element = event.currentTarget;
      if (!paused && element.scrollHeight - element.scrollTop - element.clientHeight > 48) setPausedAt(events.at(-1)?.seq ?? 0);
    }}>
      {error && !visible.length ? <Empty title="Không tải được hoạt động">{error}</Empty>
        : loading ? <Empty title="Đang tải hoạt động…" />
        : !visible.length ? <Empty title={search ? 'Không có kết quả phù hợp' : tab === 'chat' ? 'Chưa có bình luận' : tab === 'gift' ? 'Chưa có quà tặng' : 'Chưa có hoạt động'} icon={<MessageCircle size={22} />}>
          {search ? 'Thử tìm bằng nội dung hoặc tên người xem.' : 'Sự kiện mới sẽ xuất hiện tại đây khi có dữ liệu.'}
        </Empty>
        : <ol className="feed-list">{visible.map((event, index) => <FeedRow event={event} latest={index === visible.length - 1} key={event.seq} />)}</ol>}
    </div>
    {paused && <button type="button" className="feed-jump" onClick={() => setPausedAt(null)}><ArrowDown size={16} /><span>{unread ? `${formatCount(unread)} tin mới · ` : ''}Về mới nhất</span></button>}
    </div>
    <div className="feed-footer">
      <div className="feed-summary"><span>{formatCount(visible.length)} {tab === 'chat' ? 'bình luận' : 'sự kiện'}</span><button className="feed-export" type="button" onClick={onExport} disabled={!session || exporting} aria-label="Xuất CSV"><Download size={14} />{exporting ? 'Đang xuất…' : 'CSV'}</button></div>
      <button type="button" className={`scroll-state ${paused ? 'scroll-paused' : ''}`} aria-pressed={paused} aria-label={paused ? 'Tiếp tục cuộn tự động' : 'Tạm dừng cuộn tự động'} onClick={() => setPausedAt(paused ? null : events.at(-1)?.seq ?? 0)}>
        {paused ? <Play size={14} /> : <Pause size={14} />}{paused ? 'Đang dừng cuộn' : 'Tự động cuộn'}
      </button>
    </div>
  </section>;
}

export function FeedRow({ event, latest }: { event: LiveEvent; latest: boolean }) {
  if (event.type === 'status') return <li className="feed-row status-row">
    <span className="event-status-icon"><Radio size={16} /></span>
    <div className="feed-copy"><div className="feed-meta"><strong>Trạng thái phiên</strong><time dateTime={event.timestamp}>{formatTime(Date.parse(event.timestamp))}</time></div><p>{event.message || 'Đã cập nhật trạng thái'}</p></div>
  </li>;
  if (event.type === 'viewers') return <li className="feed-row status-row"><span className="event-status-icon"><UsersRound size={16} /></span><div className="feed-copy"><div className="feed-meta"><strong>Người xem</strong><time dateTime={event.timestamp}>{formatTime(Date.parse(event.timestamp))}</time></div><p>{formatCount(event.viewerCount ?? 0)} người đang xem</p></div></li>;
  const activity = { member: 'Đã vào phòng', like: `Đã thả ${formatCount(event.likeCount ?? 0)} lượt thích`, follow: 'Đã theo dõi chủ LIVE', share: `Đã chia sẻ LIVE ×${formatCount(event.shareCount ?? 1)}` };
  return <li className={`feed-row ${event.gift ? 'feed-gift' : event.type === 'chat' ? 'feed-comment' : 'feed-interaction'} ${latest ? 'feed-latest' : ''}`}>
    <Avatar user={event.user} />
    <div className="feed-copy">
      <div className="feed-meta"><div className="feed-identity"><strong>{event.user?.nickname || event.user?.username || 'Người xem'}</strong>{event.user?.username && <span>@{event.user.username}</span>}{latest && <span className="latest-tag">Mới nhất</span>}</div><time dateTime={event.timestamp}>{formatTime(Date.parse(event.timestamp))}</time></div>
      {event.gift
        ? <p className="gift-message"><Gift size={15} /> {event.gift.isFinal ? 'Đã tặng' : 'Đang tặng'} <b>{event.gift.name} ×{formatCount(event.gift.quantity)}</b></p>
        : <p className={event.type === 'chat' ? 'comment-text' : 'interaction-text'} dir="auto">{event.comment || activity[event.type as keyof typeof activity]}</p>}
    </div>
  </li>;
}

export function Gifts({ events }: { events: LiveEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const recent = useMemo(() => {
    const streaks = new Map<string, LiveEvent>();
    for (const event of events) {
      if (!event.gift) continue;
      const previous = streaks.get(event.gift.streakId);
      if (!previous?.gift?.isFinal || event.gift.isFinal) streaks.set(event.gift.streakId, event);
    }
    return [...streaks.values()].sort((left, right) => right.seq - left.seq);
  }, [events]);
  return <section className="card side-panel" aria-labelledby="gift-heading">
    <div className="panel-header">
      <div className="panel-title"><span className="panel-heading-icon tone-rose"><Gift size={20} /></span><div><h2 id="gift-heading">Quà tặng</h2><p>Quà tặng gần đây</p></div></div>
      {recent.length > 3 && <button type="button" className="text-button gift-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Thu gọn' : 'Xem thêm'}</button>}
    </div>
    {recent.length === 0 ? <Empty title="Chưa có quà tặng" icon={<Gift size={20} />} />
      : <ol className={`gift-list ${expanded ? 'gift-list-expanded' : ''}`}>{recent.slice(0, expanded ? 15 : 3).map((event) => {
        const gift = event.gift!;
        return <li className="gift-row" key={gift.streakId}>
          <GiftIcon gift={gift} />
          <div className="side-copy"><strong>{gift.name}</strong><span>{event.user?.nickname || event.user?.username || 'Người xem'}</span></div>
          <div className="gift-amount"><strong>×{formatCount(gift.quantity)}</strong>{!gift.isFinal && <span>Đang tặng</span>}</div>
        </li>;
      })}</ol>}
  </section>;
}

export function TopSenders({ events }: { events: LiveEvent[] }) {
  const ranks = useMemo(() => {
    const senders = new Map<string, { user: LiveUser; quantity: number }>();
    const counted = new Set<string>();
    for (const event of [...events].reverse()) {
      if (event.type !== 'gift.completed' || !event.gift || !event.user || counted.has(event.gift.streakId)) continue;
      counted.add(event.gift.streakId);
      const sender = senders.get(event.user.id);
      senders.set(event.user.id, { user: event.user, quantity: (sender?.quantity ?? 0) + event.gift.quantity });
    }
    return [...senders.values()].sort((left, right) => right.quantity - left.quantity).slice(0, 3);
  }, [events]);
  return <section className="card side-panel" aria-labelledby="top-heading">
    <div className="panel-header">
      <div className="panel-title"><span className="panel-heading-icon tone-mint"><UsersRound size={20} /></span><div><h2 id="top-heading">Người tặng nhiều nhất</h2><p>Theo số quà đã chốt trong luồng gần đây</p></div></div>
    </div>
    {ranks.length === 0 ? <Empty title="Chưa có người tặng" icon={<UsersRound size={20} />} />
      : <ol className="sender-list">{ranks.map(({ user, quantity }, index) => <li className="sender-row" key={user.id}>
        <span className="sender-rank">{index + 1}</span><Avatar user={user} small />
        <div className="side-copy"><strong>{user.nickname || user.username}</strong><span>@{user.username}</span></div>
        <strong className="sender-amount">{formatCount(quantity)} <span>quà</span></strong>
      </li>)}</ol>}
  </section>;
}

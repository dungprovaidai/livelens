import { ArrowLeft, ArrowRight, CalendarClock, History } from 'lucide-react';
import type { LiveEvent, LiveSession } from '../../shared/contracts';
import { Activity, Gifts, Metrics, TopSenders, type Mode } from './dashboard';
import { Empty, ErrorNotice, SourceLabel, StatusPill, formatCount, formatDate } from './ui';
import type { EventFilter, LiveClient } from '../client';
import type { DemoRecord } from '../demo';
import type { EventView } from '../useLive';
import { Audience } from './audience';

export function HistoryPage({ source, setSource, sessions, loading, error, viewing, setViewing, data, now, exporting, onExport, filter, setFilter, summaryEvents, client, demoRecord }: {
  source: Mode; setSource: (mode: Mode) => void; sessions: LiveSession[]; loading: boolean; error: string;
  viewing?: LiveSession; setViewing: (session?: LiveSession) => void;
  data: EventView; now: number; exporting: boolean; onExport: () => void;
  filter: EventFilter; setFilter: (filter: EventFilter) => void;
  summaryEvents: LiveEvent[];
  client: LiveClient; demoRecord?: DemoRecord;
}) {
  if (viewing) return <div className="dashboard-stack">
    <div className="history-detail-bar">
      <button type="button" className="button button-small" onClick={() => setViewing()}><ArrowLeft size={16} /> Lịch sử phiên</button>
      <div className="history-detail-identity"><strong>{viewing.mode === 'demo' ? 'Phòng LIVE mẫu' : `@${viewing.uniqueId}`}</strong><SourceLabel demo={viewing.mode === 'demo'} /><StatusPill status={viewing.status} demo={viewing.mode === 'demo'} /></div>
    </div>
    {viewing.error && <ErrorNotice message={viewing.error} />}
    <div className="dashboard-grid">
      <Activity key={viewing.id} session={viewing} {...data} filter={filter} setFilter={setFilter} onExport={onExport} exporting={exporting} />
      <aside className="dashboard-aside" aria-label="Thông tin phiên"><Audience client={client} session={viewing} demoRecord={demoRecord} now={now} /><Metrics session={viewing} now={now} /><Gifts events={summaryEvents} /><TopSenders events={summaryEvents} /></aside>
    </div>
  </div>;

  return <section className="card history-card" aria-labelledby="history-heading">
    <div className="panel-header">
      <div className="panel-title"><span className="panel-heading-icon tone-blue"><History size={20} /></span><div><h2 id="history-heading">Các phiên theo dõi</h2><p>Chọn một phiên để xem hoạt động và xuất CSV.</p></div></div>
      <div className="mode-options" role="group" aria-label="Nguồn lịch sử">
        <button className={source === 'demo' ? 'selected' : ''} type="button" aria-pressed={source === 'demo'} onClick={() => setSource('demo')}>Demo</button>
        <button className={source === 'live' ? 'selected' : ''} type="button" aria-pressed={source === 'live'} onClick={() => setSource('live')}>LIVE thật</button>
      </div>
    </div>
    {error && !sessions.length ? <Empty title="Không tải được lịch sử" icon={<History size={21} />}>{error}</Empty>
      : loading && !sessions.length ? <Empty title="Đang tải lịch sử…" icon={<History size={21} />} />
      : !sessions.length ? <Empty title="Chưa có phiên theo dõi" icon={<CalendarClock size={21} />}>{source === 'demo' ? 'Các phiên bạn đã chạy demo sẽ xuất hiện tại đây.' : 'Các phiên TikTok LIVE được lưu trên máy chủ sẽ xuất hiện tại đây.'}</Empty>
      : <ol className="history-list">{sessions.map((session) => <li key={session.id}>
        <button type="button" className="history-row" onClick={() => setViewing(session)}>
          <span className="history-icon"><CalendarClock size={19} /></span>
          <span className="history-name"><strong>{session.mode === 'demo' ? 'Phòng LIVE mẫu' : `@${session.uniqueId}`}</strong><time dateTime={session.createdAt}>{formatDate(Date.parse(session.createdAt))}</time></span>
          <SourceLabel demo={session.mode === 'demo'} />
          <span className="history-count">{formatCount(session.stats.comments)} bình luận · {formatCount(session.stats.gifts)} quà</span>
          <StatusPill status={session.status} demo={session.mode === 'demo'} />
          <ArrowRight className="history-arrow" size={17} />
        </button>
      </li>)}</ol>}
  </section>;
}

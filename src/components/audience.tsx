import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, Eye, Search, TrendingUp, UsersRound } from 'lucide-react';
import type { AudienceResponse, LiveSession, ViewerSample, ViewerSummary } from '../../shared/contracts';
import { addAudienceEvent, emptyAudience, normalizeAudienceText } from '../../shared/audience.ts';
import { LiveClient, saveDownload, type AudienceFilter } from '../client';
import { demoAudienceCsv, isActive, type DemoRecord } from '../demo';
import { messageOf, useArchivedEvents } from '../useLive';
import { FeedRow } from './dashboard';
import { Avatar, Dialog, Empty, ErrorNotice, formatCount, formatDate, formatTime } from './ui';

function AudienceChart({ samples }: { samples: ViewerSample[] }) {
  const [selected, setSelected] = useState<ViewerSample>();
  if (!samples.length) return <p className="audience-hint">Chưa nhận được số người xem từ nguồn.</p>;
  samples = [...samples].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.seq - right.seq);
  const start = Date.parse(samples[0].timestamp);
  const duration = Math.max(1, Date.parse(samples.at(-1)!.timestamp) - start);
  const max = Math.max(1, ...samples.map((sample) => sample.count));
  const points = samples.map((sample) => ({ ...sample, x: 10 + (Date.parse(sample.timestamp) - start) / duration * 580, y: 120 - sample.count / max * 100 }));
  const current = selected && samples.find((sample) => sample.seq === selected.seq) || samples.at(-1)!;
  return <figure className="audience-chart">
    <figcaption><strong>Người xem theo thời gian</strong><span>{formatTime(Date.parse(current.timestamp))} · {formatCount(current.count)} người</span></figcaption>
    <svg viewBox="0 0 600 135" role="img" aria-label="Biểu đồ số người xem theo các lần nguồn cập nhật">
      <path d="M10 20H590 M10 70H590 M10 120H590" className="chart-grid" />
      <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2.5" />
      {points.map((point) => <circle key={point.seq} cx={point.x} cy={point.y} r="4" tabIndex={0} fill="currentColor" onFocus={() => setSelected(point)} onPointerEnter={() => setSelected(point)} aria-label={`${formatTime(Date.parse(point.timestamp))}: ${point.count} người`}><title>{formatTime(Date.parse(point.timestamp))}: {formatCount(point.count)} người</title></circle>)}
    </svg>
    <div className="chart-axis"><span>{formatTime(start)}</span><span>{formatTime(Date.parse(samples.at(-1)!.timestamp))}</span></div>
  </figure>;
}

function ViewerDetails({ viewer, session, client, demoRecord }: { viewer: ViewerSummary; session: LiveSession; client: LiveClient; demoRecord?: DemoRecord }) {
  const data = useArchivedEvents(client, session.mode === 'live' ? session.id : undefined, undefined, null, { type: 'all', search: '', userId: viewer.user.id });
  const events = session.mode === 'demo' ? demoRecord?.events.filter((event) => event.user?.id === viewer.user.id) || [] : data.events;
  return <section className="viewer-detail" aria-label={`Tương tác của ${viewer.user.nickname}`}>
    <div className="viewer-detail-heading"><Avatar user={viewer.user} /><div><h3>{viewer.user.nickname}</h3><p>@{viewer.user.username}</p></div></div>
    <p className="audience-hint">Lần đầu ghi nhận: {formatDate(Date.parse(viewer.firstSeen))} · Gần nhất: {formatDate(Date.parse(viewer.lastSeen))}</p>
    <p className="audience-hint">{session.mode === 'demo' ? 'Các sự kiện gần đây của tài khoản trong demo.' : 'Các sự kiện đã lưu của tài khoản trong phiên này.'}</p>
    {data.error && <ErrorNotice message={data.error} />}
    {data.loading && session.mode === 'live' ? <Empty title="Đang tải tương tác…" /> : !events.length ? <Empty title="Chưa có tương tác phù hợp" /> : <ol className="feed-list viewer-event-list">{events.map((event) => <FeedRow key={event.seq} event={event} latest={false} />)}</ol>}
    {data.hasMore && <button type="button" className="button button-small" disabled={data.loadingMore} onClick={() => void data.loadOlder?.()}>{data.loadingMore ? 'Đang tải…' : 'Tải tương tác cũ hơn'}</button>}
  </section>;
}

export function Audience({ client, session, demoRecord, now }: { client: LiveClient; session?: LiveSession; demoRecord?: DemoRecord; now: number }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AudienceFilter>({ search: '', filter: 'all', sort: 'recent', offset: 0 });
  const [result, setResult] = useState<{ key: string; id: string; data: AudienceResponse }>();
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<ViewerSummary>();
  const [detailRevision, setDetailRevision] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const id = session?.id;
  const live = session?.mode === 'live';
  const active = isActive(session);
  const key = JSON.stringify([id, options]);

  useEffect(() => {
    setOpen(false);
    setSelected(undefined);
    setOptions({ search: '', filter: 'all', sort: 'recent', offset: 0 });
  }, [id]);

  useEffect(() => {
    if (!id || !live) return;
    const controller = new AbortController();
    let pending = false;
    setError('');
    async function refresh() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const data = await client.audience(id!, controller.signal, options);
        if (!controller.signal.aborted) { setResult({ key, id: id!, data }); setError(''); }
      } catch (error) {
        if (!controller.signal.aborted) setError(messageOf(error));
      } finally { pending = false; }
    }
    const debounce = window.setTimeout(() => void refresh(), options.search ? 250 : 0);
    const timer = active ? window.setInterval(() => void refresh(), 5000) : undefined;
    return () => { controller.abort(); window.clearTimeout(debounce); window.clearInterval(timer); };
  }, [id, live, client, key, active, refreshRevision]);

  const demo = useMemo<AudienceResponse | undefined>(() => {
    if (live || !demoRecord) return undefined;
    const data = demoRecord.audience ?? demoRecord.events.reduce(addAudienceEvent, emptyAudience());
    const query = normalizeAudienceText(options.search.trim());
    const matching = data.viewers.filter((viewer) => (!query || normalizeAudienceText(`${viewer.user.nickname} ${viewer.user.username}`).includes(query)) &&
      (options.filter === 'all' || (options.filter === 'chat' ? viewer.comments > 0 : viewer.gifts > 0)));
    matching.sort((a, b) => options.sort === 'recent' ? b.lastSeen.localeCompare(a.lastSeen) || a.user.id.localeCompare(b.user.id) : b[options.sort] - a[options.sort] || a.user.id.localeCompare(b.user.id));
    return { ...data, viewers: matching.slice(options.offset, options.offset + 50), knownViewers: data.viewers.length,
      joins: data.viewers.reduce((sum, viewer) => sum + viewer.joins, 0), likes: data.viewers.reduce((sum, viewer) => sum + viewer.likes, 0),
      follows: data.viewers.reduce((sum, viewer) => sum + viewer.follows, 0), shares: data.viewers.reduce((sum, viewer) => sum + viewer.shares, 0),
      total: matching.length, offset: options.offset, hasMore: options.offset + 50 < matching.length };
  }, [demoRecord, live, options]);
  const data = live ? result && result.id === id ? result.data : undefined : demo;
  const tableReady = !live || result?.key === key;
  const connected = session?.status === 'connected';
  const stale = connected && data?.updatedAt && now - Date.parse(data.updatedAt) > 60_000;
  const current = data?.currentViewers;

  async function exportViewers() {
    if (!session || exporting) return;
    setExporting(true);
    setError('');
    try {
      const blob = live ? await client.exportAudience(session.id) : demoAudienceCsv((demoRecord?.audience ?? demoRecord?.events.reduce(addAudienceEvent, emptyAudience()))?.viewers || []);
      saveDownload(blob, `livelens-viewers-${session.mode}-${session.createdAt.slice(0, 10)}.csv`);
    } catch (error) { setError(messageOf(error)); }
    finally { setExporting(false); }
  }

  const change = (patch: Partial<AudienceFilter>) => setOptions({ ...options, offset: 0, ...patch });
  return <>
    <section className="card audience-panel" aria-labelledby="audience-heading">
      <div className="panel-header"><div className="panel-title"><span className="panel-heading-icon tone-mint"><Eye size={19} /></span><div><h2 id="audience-heading">Người xem</h2><p>{session?.mode === 'demo' ? 'Dữ liệu mô phỏng' : 'Theo cập nhật từ TikTok'}</p></div></div></div>
      <div className="audience-current"><span>{connected ? 'Đang xem' : 'Lần cập nhật cuối'}</span><strong>{typeof current === 'number' && !stale ? formatCount(current) : '—'}</strong><small>{stale ? `Mẫu cuối: ${formatCount(current ?? 0)} · Chưa có cập nhật mới` : data?.updatedAt ? `Cập nhật ${formatTime(Date.parse(data.updatedAt))}` : 'Chưa nhận số liệu người xem'}</small></div>
      <div className="audience-mini-stats"><div><TrendingUp size={15} /><span>Cao nhất</span><strong>{data?.peakViewers == null ? '—' : formatCount(data.peakViewers)}</strong></div><div><UsersRound size={15} /><span>Tài khoản ghi nhận</span><strong>{data ? formatCount(data.knownViewers) : '—'}</strong></div></div>
      {error && !open && <p className="audience-hint audience-error" role="status">{error}</p>}
      <button type="button" className="button button-small audience-open" disabled={!session} onClick={() => setOpen(true)}>Xem người xem <ArrowRight size={15} /></button>
    </section>
    {open && session && <Dialog title="Tổng hợp người xem" className="audience-dialog" onClose={() => setOpen(false)}>
      <p className="dialog-description">{session.mode === 'demo' ? 'Phòng demo · Dữ liệu mô phỏng.' : `@${session.uniqueId} · Từ lúc bắt đầu theo dõi.`} Tài khoản được ghi nhận qua lượt vào và tương tác; TikTok có thể không gửi danh tính của người chỉ xem im lặng.</p>
      {error && <ErrorNotice message={error}><button type="button" className="text-button" onClick={() => setRefreshRevision((value) => value + 1)}>Thử lại</button></ErrorNotice>}
      {data && <>
        <div className="audience-totals"><div><span>Cao nhất</span><strong>{data.peakViewers == null ? '—' : formatCount(data.peakViewers)}</strong></div><div><span>Tài khoản ghi nhận</span><strong>{formatCount(data.knownViewers)}</strong></div><div><span>Lượt vào ghi nhận</span><strong>{formatCount(data.joins)}</strong></div><div><span>{data.totalLikes === null ? 'Like ghi nhận' : 'Tổng like từ nguồn'}</span><strong>{formatCount(data.totalLikes ?? data.likes)}</strong></div><div><span>Follow ghi nhận</span><strong>{formatCount(data.follows)}</strong></div><div><span>Chia sẻ ghi nhận</span><strong>{formatCount(data.shares)}</strong></div></div>
        <AudienceChart samples={data.samples} />
      </>}
      {selected ? <>
        <div className="audience-detail-actions"><button type="button" className="button button-small" onClick={() => setSelected(undefined)}><ArrowLeft size={15} /> Danh sách người xem</button><button type="button" className="button button-small" onClick={() => setDetailRevision((value) => value + 1)}>Tải lại tương tác</button></div>
        <ViewerDetails key={`${selected.user.id}-${detailRevision}`} viewer={data?.viewers.find((viewer) => viewer.user.id === selected.user.id) || selected} session={session} client={client} demoRecord={demoRecord} />
      </> : <>
        <div className="audience-toolbar"><div className="input-wrap"><Search size={16} /><input type="search" maxLength={200} value={options.search} onChange={(event) => change({ search: event.target.value })} placeholder="Tìm tên hoặc @tài khoản…" aria-label="Tìm người xem" /></div>
          <select value={options.filter} aria-label="Lọc người xem" onChange={(event) => change({ filter: event.target.value as AudienceFilter['filter'] })}><option value="all">Tất cả tài khoản</option><option value="chat">Đã bình luận</option><option value="gift">Đã tặng quà</option></select>
          <select value={options.sort} aria-label="Sắp xếp người xem" onChange={(event) => change({ sort: event.target.value as AudienceFilter['sort'] })}><option value="recent">Gần đây nhất</option><option value="comments">Bình luận nhiều nhất</option><option value="gifts">Tặng quà nhiều nhất</option><option value="likes">Thả like nhiều nhất</option><option value="joins">Vào phòng nhiều nhất</option></select>
          <button type="button" className="button button-small" disabled={exporting || !data?.knownViewers} onClick={() => void exportViewers()}><Download size={15} />{exporting ? 'Đang xuất…' : 'Xuất CSV người xem'}</button>
        </div>
        {!tableReady || !data ? <Empty title={error ? 'Chưa tải được người xem' : 'Đang tải người xem…'} /> : !data.viewers.length ? <Empty title={options.search || options.filter !== 'all' ? 'Không có tài khoản phù hợp' : 'Chưa ghi nhận được tài khoản'} /> : <div className="viewer-table-scroll" tabIndex={0} aria-label="Bảng tài khoản đã ghi nhận"><table className="viewer-table"><thead><tr><th scope="col">Tài khoản</th><th scope="col">Bình luận</th><th scope="col">Quà</th><th scope="col">Like</th><th scope="col">Lượt vào</th><th scope="col">Follow</th><th scope="col">Chia sẻ</th><th scope="col">Lần đầu / gần nhất</th></tr></thead><tbody>{data.viewers.map((viewer) => <tr key={viewer.user.id}><td><button type="button" className="viewer-name" onClick={() => setSelected(viewer)}><Avatar user={viewer.user} small /><span><strong>{viewer.user.nickname}</strong><small>@{viewer.user.username}</small></span></button></td><td>{formatCount(viewer.comments)}</td><td>{formatCount(viewer.gifts)}</td><td>{formatCount(viewer.likes)}</td><td>{formatCount(viewer.joins)}</td><td>{formatCount(viewer.follows)}</td><td>{formatCount(viewer.shares)}</td><td><time dateTime={viewer.firstSeen}>{formatTime(Date.parse(viewer.firstSeen))}</time><br /><time dateTime={viewer.lastSeen}>{formatTime(Date.parse(viewer.lastSeen))}</time></td></tr>)}</tbody></table></div>}
        {data && <div className="audience-pagination"><span>{formatCount(data.total)} tài khoản phù hợp · Trang {Math.floor(options.offset / 50) + 1}</span><div><button type="button" className="button button-small" disabled={options.offset === 0 || !tableReady} onClick={() => change({ offset: Math.max(0, options.offset - 50) })}>Trước</button><button type="button" className="button button-small" disabled={!data.hasMore || !tableReady} onClick={() => change({ offset: options.offset + 50 })}>Tiếp</button></div></div>}
        <p className="audience-hint">Like, lượt vào, follow và chia sẻ là những sự kiện app nhận được. Danh sách này không xác nhận từng tài khoản còn trong phòng.</p>
      </>}
    </Dialog>}
  </>;
}

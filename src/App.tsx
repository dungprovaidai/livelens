import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AudioLines, Bell, Download, History, LayoutDashboard, Radio, Settings, Signal, Volume2, X } from 'lucide-react';
import type { LiveEvent, LiveSession, NotificationSettings } from '../shared/contracts';
import { ApiError, LiveClient, normalizeLiveInput, saveDownload, type Connection, type EventFilter } from './client';
import { demoCsv, isActive, loadDemoRecords, nextDemoEvent, sampleDemo, saveDemoRecords, startDemo, stopDemo } from './demo';
import { notifyEvent, readConnection, readPreferences, readSetting, requestDesktopPermission, saveConnection, savePreferences, testSound, unlockSound, writeSetting } from './preferences';
import { messageOf, useArchivedEvents, useLive } from './useLive';
import { Activity, ConnectionCard, Gifts, Metrics, TopSenders, type Mode } from './components/dashboard';
import { HistoryPage } from './components/history';
import { Audience } from './components/audience';
import { Alerts, ConnectionDialog, GeneralSettings } from './components/settings';
import { ErrorNotice, SourceLabel, StatusPill, formatTime } from './components/ui';

const pages = {
  overview: { label: 'Đọc bình luận', title: 'Bình luận LIVE', subtitle: 'Tập trung vào cuộc trò chuyện với người xem.', icon: LayoutDashboard },
  history: { label: 'Lịch sử phiên', title: 'Lịch sử phiên', subtitle: 'Xem lại những phiên theo dõi đã lưu và hoạt động trong từng phiên.', icon: History },
  alerts: { label: 'Thông báo', title: 'Thông báo', subtitle: 'Chọn sự kiện và từ khóa bạn muốn nhận thông báo.', icon: Bell },
  settings: { label: 'Cài đặt', title: 'Cài đặt', subtitle: 'Quản lý kết nối máy chủ và tải mã nguồn LiveLens.', icon: Settings },
};
type Page = keyof typeof pages;

function currentPage(): Page {
  const value = window.location.hash.slice(1);
  return Object.hasOwn(pages, value) ? value as Page : 'overview';
}

export default function App() {
  const [page, setPage] = useState(currentPage);
  const [mode, setMode] = useState<Mode>(() => readSetting('livelens.mode') === 'live' ? 'live' : 'demo');
  const [historySource, setHistorySource] = useState<Mode>(mode);
  const [historyId, setHistoryId] = useState<string>();
  const [eventFilter, setEventFilter] = useState<EventFilter>({ search: '', type: 'chat' });
  const [connection, setConnection] = useState(readConnection);
  const [settings, setSettings] = useState(readPreferences);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [demoRecords, setDemoRecords] = useState(loadDemoRecords);
  const demoRef = useRef(demoRecords);
  const [sample] = useState(sampleDemo);
  const [url, setUrl] = useState('');
  const [formError, setFormError] = useState('');
  const [exportError, setExportError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [soundReady, setSoundReady] = useState(false);
  const [soundError, setSoundError] = useState('');
  const [desktopMessage, setDesktopMessage] = useState('');
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [now, setNow] = useState(Date.now);

  const client = useMemo(() => new LiveClient(connection), [connection]);
  const live = useLive(client, mode === 'live' || (page === 'history' && historySource === 'live'), (event) => {
    if (mode === 'live') {
      const sounded = notifyEvent(event, settingsRef.current, false);
      if (sounded !== undefined) setSoundReady(sounded);
    }
  });
  const activeDemo = demoRecords.find((record) => isActive(record.session));
  const active = mode === 'demo' ? activeDemo?.session : live.active;
  const currentDemo = demoRecords[0] || sample;
  const currentLive = live.active || live.sessions[0];
  const currentSession = mode === 'demo' ? currentDemo.session : currentLive;
  const viewing = (historySource === 'demo' ? demoRecords.map((record) => record.session) : live.sessions)
    .find((session) => session.id === historyId);
  const requested = page === 'history' ? viewing : page === 'overview' ? currentSession : undefined;
  const liveData = useArchivedEvents(client, requested?.mode === 'live' ? requested.id : undefined, live.active?.id, live.rows, eventFilter);
  const liveSummary = useArchivedEvents(client, requested?.mode === 'live' ? requested.id : undefined, live.active?.id, live.rows, { search: '', type: 'all' });
  const requestedDemo = requested?.id === sample.session.id ? sample : demoRecords.find((record) => record.session.id === requested?.id);
  const data = requested?.mode === 'live' ? liveData : { events: requestedDemo?.events || [], loading: false, error: '' };
  const summaryEvents = requested?.mode === 'live' ? liveSummary.events : data.events;

  useEffect(() => {
    function navigate() {
      setPage(currentPage());
      setHistoryId(undefined);
      setEventFilter({ search: '', type: 'chat' });
      setExportError('');
      window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  useEffect(() => {
    if (!settings.sound) { setSoundReady(false); return; }
    let mounted = true;
    function enable() { void unlockSound().then((ready) => { if (mounted) setSoundReady(ready); }); }
    window.addEventListener('pointerdown', enable);
    window.addEventListener('keydown', enable);
    return () => {
      mounted = false;
      window.removeEventListener('pointerdown', enable);
      window.removeEventListener('keydown', enable);
    };
  }, [settings.sound]);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active?.id]);

  function updateDemo(records: typeof demoRecords) {
    const next = records.slice(0, 12);
    demoRef.current = next;
    setDemoRecords(next);
    saveDemoRecords(next);
  }

  useEffect(() => {
    if (!activeDemo) return;
    const id = activeDemo.session.id;
    const timer = window.setInterval(() => {
      const record = demoRef.current.find((entry) => entry.session.id === id);
      if (!record || !isActive(record.session)) return;
      const next = nextDemoEvent(record);
      updateDemo(demoRef.current.map((entry) => entry.session.id === id ? next : entry));
      const event = next.events.at(-1);
      if (event) {
        const sounded = notifyEvent(event, settingsRef.current, true);
        if (sounded !== undefined) setSoundReady(sounded);
      }
    }, 1450);
    return () => window.clearInterval(timer);
  }, [activeDemo?.session.id]);

  function changeMode(next: Mode) {
    if (active || busy) return;
    setMode(next);
    setHistorySource(next);
    setFormError('');
    setExportError('');
    writeSetting('livelens.mode', next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (settings.sound) unlockSound();
    setFormError('');
    setExportError('');

    if (active?.mode === 'demo') {
      updateDemo(demoRef.current.map((record) => record.session.id === active.id ? stopDemo(record) : record));
      return;
    }

    if (!active && mode === 'demo') {
      updateDemo([startDemo(), ...demoRef.current]);
      return;
    }

    setBusy(true);
    try {
      if (active) {
        live.publish(await client.stop(active.id));
      } else {
        live.publish(await client.start(normalizeLiveInput(url)));
      }
    } catch (error) {
      setFormError(messageOf(error));
      if (error instanceof ApiError && error.status === 409) void live.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function exportCurrent(session: LiveSession | undefined, events: LiveEvent[]) {
    if (!session || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const blob = session.mode === 'demo' ? demoCsv(events) : await client.export(session.id);
      const date = session.createdAt.slice(0, 10);
      const handle = session.uniqueId.replace(/[^a-z0-9_.-]/gi, '_');
      saveDownload(blob, `livelens-${session.mode}-${handle}-${date}.csv`);
    } catch (error) {
      setExportError(messageOf(error));
    } finally {
      setExporting(false);
    }
  }

  function updateSettings(next: NotificationSettings) {
    settingsRef.current = next;
    setSettings(next);
    savePreferences(next);
  }

  async function hearSound() {
    const played = await testSound();
    setSoundReady(played);
    setSoundError(played ? '' : 'Chưa phát được âm thanh. Cho phép âm thanh của trang rồi thử lại.');
  }

  function enableCommentSound() {
    updateSettings({ ...settingsRef.current, sound: true, commentAlerts: true, keywords: [] });
    void hearSound();
  }

  async function toggleCommentNotifications() {
    if (desktopBusy) return;
    setDesktopMessage('');
    if (desktopReady) {
      updateSettings({ ...settingsRef.current, desktop: false });
      return;
    }
    setDesktopBusy(true);
    try {
      const permission = await requestDesktopPermission();
      if (permission === 'granted') updateSettings({ ...settingsRef.current, desktop: true, commentAlerts: true, keywords: [] });
      else setDesktopMessage(permission === 'unsupported'
        ? 'Trình duyệt này không hỗ trợ thông báo màn hình.'
        : 'Chưa được cấp quyền. Bật Thông báo trong cài đặt của trang ở cạnh thanh địa chỉ, rồi thử lại.');
    } finally {
      setDesktopBusy(false);
    }
  }

  function updateConnection(next: Connection) {
    if (busy) throw new Error('Đợi thao tác theo dõi hiện tại hoàn tất rồi lưu kết nối.');
    if (live.active && next.origin !== connection.origin) {
      throw new Error('Dừng phiên LIVE hiện tại trước khi đổi địa chỉ máy chủ.');
    }
    saveConnection(next);
    if (next.origin !== connection.origin || next.token !== connection.token) setConnection(next);
    setFormError('');
    setConnectionOpen(false);
  }

  function selectHistory(session?: LiveSession) {
    setHistoryId(session?.id);
    setEventFilter({ search: '', type: 'chat' });
    setExportError('');
  }

  const sidebarDemo = mode === 'demo';
  const overviewDemo = mode === 'demo';
  const linkedSession = active || currentSession;
  const sampleReady = overviewDemo && currentDemo === sample;
  const connectionIssue = formError || (!overviewDemo && (live.streamError || live.setupError || currentLive?.error)) || '';
  const labelEvent = currentSession?.lastEventAt;
  const fullyConnected = active?.status === 'connected' && (overviewDemo || (!live.streamError && !live.setupError));
  const commentSoundOn = settings.sound && settings.commentAlerts;
  const desktopReady = settings.desktop && settings.commentAlerts && 'Notification' in window && Notification.permission === 'granted';
  const commentSoundStatus = !settings.sound ? 'Âm báo đang tắt.'
    : !settings.commentAlerts ? 'Âm thanh đã bật nhưng báo bình luận đang tắt.'
    : !soundReady ? 'Cần bật âm thanh để nghe bình luận mới.'
    : settings.keywords.length ? 'Chỉ báo bình luận khớp từ khóa.' : 'Đã bật âm báo mọi bình luận mới.';

  return <div className="app-shell">
    <a href="#main-content" className="skip-link" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Tới nội dung chính</a>
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="LiveLens, Tổng quan">
        <span className="brand-mark"><AudioLines size={24} strokeWidth={2.5} /></span>
        <span>Live<span className="brand-accent">Lens</span><small>Bảng điều khiển LIVE</small></span>
      </a>
      <nav className="navigation" aria-label="Điều hướng chính">
        {Object.entries(pages).map(([key, info]) => <a key={key} href={`#${key}`} className={page === key ? 'nav-active' : ''} aria-current={page === key ? 'page' : undefined}>
          <info.icon strokeWidth={1.9} size={19} /><span>{info.label}</span>
        </a>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-status">
          <div><span className={`sidebar-dot ${fullyConnected ? 'sidebar-dot-active' : ''}`} /><strong>{sidebarDemo ? 'Chế độ demo' : 'Chế độ LIVE thật'}</strong></div>
          <p>{active ? (sidebarDemo ? 'Đang mô phỏng' : `@${active.uniqueId}`) : (sidebarDemo ? 'Dữ liệu mẫu' : 'Chưa theo dõi')}</p>
        </div>
        <a className="source-download" href="/livelens-source.zip" download><Download size={17} /> <span>Mã nguồn</span></a>
      </div>
    </aside>
    <main id="main-content" tabIndex={-1} className={`workspace ${page === 'overview' ? 'workspace-overview' : ''}`}>
      <header className="page-header">
        <div><h1>{pages[page].title}</h1><p>{pages[page].subtitle}</p></div>
        {page === 'overview' && <div className="header-source"><SourceLabel demo={overviewDemo} /></div>}
        {page !== 'overview' && active && <div className="header-source"><a className={`active-link ${fullyConnected ? '' : 'active-link-pending'}`} href="#overview"><Radio size={16} /> {active.mode === 'demo' ? 'Demo đang chạy' : `Đang theo dõi @${active.uniqueId}`}</a></div>}
      </header>

      {exportError && <div className="export-error"><ErrorNotice message={exportError}><button className="icon-button" type="button" onClick={() => setExportError('')} aria-label="Đóng báo lỗi"><X size={17} /></button></ErrorNotice></div>}
      {page === 'overview' && <div className="dashboard-stack">
        <ConnectionCard
          mode={mode} active={active} statusSession={linkedSession} sample={sampleReady && !active}
          busy={busy} issue={connectionIssue} streamIssue={Boolean((live.streamError || live.setupError) && active?.mode === 'live')}
          url={url} setUrl={(value) => { setUrl(value); setFormError(''); }}
          setMode={changeMode} onAction={(event) => void submit(event)} onSettings={() => setConnectionOpen(true)}
        />
        <div className="dashboard-grid">
          <Activity session={currentSession} {...data} filter={eventFilter} setFilter={setEventFilter} onExport={() => void exportCurrent(currentSession, data.events)} exporting={exporting} alertControls={<>
          <div className="comment-sound-controls">
            <span role="status">{soundError || commentSoundStatus}</span>
            <div>{!commentSoundOn || settings.keywords.length > 0
              ? <button type="button" className="button button-small sound-enable" onClick={enableCommentSound}><Volume2 size={15} /> Bật báo mọi bình luận</button>
              : <button type="button" className="button button-small sound-enable" onClick={() => void hearSound()}><Volume2 size={15} /> {soundReady ? 'Nghe thử' : 'Bật âm báo'}</button>}
              <a className="text-button" href="#alerts">Tùy chọn âm báo</a>
            </div>
          </div>
          <div className="comment-desktop-controls">
            <span role="status">{desktopMessage || (desktopReady
              ? settings.keywords.length ? 'Thông báo bình luận khớp từ khóa khi bạn ở tab khác đã bật.' : 'Đã bật thông báo tên và nội dung bình luận khi bạn ở tab khác.'
              : 'Nhận mọi bình luận mới khi ở tab khác. Giữ LiveLens mở.')}</span>
            <button type="button" className="button button-small" disabled={desktopBusy} onClick={() => void toggleCommentNotifications()}><Bell size={15} /> {desktopBusy ? 'Đang xin quyền…' : desktopReady ? 'Tắt thông báo màn hình' : 'Bật thông báo bình luận'}</button>
          </div>
          </>} />
          <aside className="dashboard-aside" aria-label="Thông tin phiên"><Audience client={client} session={currentSession} demoRecord={currentDemo} now={now} /><Metrics session={currentSession} now={now} /><Gifts events={summaryEvents} /><TopSenders events={summaryEvents} /></aside>
        </div>
      </div>}
      {page === 'history' && <HistoryPage
        source={historySource} setSource={(next) => { setHistorySource(next); setHistoryId(undefined); }}
        sessions={historySource === 'demo' ? demoRecords.map((record) => record.session) : live.sessions}
        loading={historySource === 'live' && live.loading} error={historySource === 'live' ? live.setupError : ''}
        viewing={viewing} setViewing={selectHistory} data={data} now={now} exporting={exporting}
        filter={eventFilter} setFilter={setEventFilter} summaryEvents={summaryEvents}
        client={client} demoRecord={requestedDemo}
        onExport={() => void exportCurrent(viewing, data.events)}
      />}
      {page === 'alerts' && <Alerts settings={settings} update={updateSettings} />}
      {page === 'settings' && <GeneralSettings connection={connection} openConnection={() => setConnectionOpen(true)} />}
      <footer className="workspace-footer">
        <span><Signal size={16} /> <strong>LiveLens</strong><span className="footer-separator">·</span>{sidebarDemo ? 'Mô phỏng trong trình duyệt' : 'Nguồn TikTok LIVE'}</span>
        {page === 'overview' && <span>{labelEvent && `Sự kiện gần nhất ${formatTime(Date.parse(labelEvent))}`}<StatusPill status={linkedSession?.status} demo={sidebarDemo} isSample={sampleReady && !active} streamIssue={Boolean(live.streamError && active?.mode === 'live')} /></span>}
      </footer>
    </main>

    {connectionOpen && <ConnectionDialog connection={connection} onSave={updateConnection} onClose={() => setConnectionOpen(false)} />}
  </div>;
}

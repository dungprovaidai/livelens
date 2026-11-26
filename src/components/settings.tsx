import { useState, type FormEvent } from 'react';
import { Bell, Code2, Download, Gift, Link2, MessageCircle, Server, Settings2, Volume2 } from 'lucide-react';
import type { NotificationSettings } from '../../shared/contracts';
import { LiveClient, normalizeOrigin, type Connection } from '../client';
import { normalizeText, requestDesktopPermission, testSound, unlockSound } from '../preferences';
import { messageOf } from '../useLive';
import { Dialog, ErrorNotice } from './ui';

export function Alerts({ settings, update }: { settings: NotificationSettings; update: (next: NotificationSettings) => void }) {
  const [keywords, setKeywords] = useState(settings.keywords.join(', '));
  const [message, setMessage] = useState('');
  const [keywordSaved, setKeywordSaved] = useState(false);
  const [soundMessage, setSoundMessage] = useState('');

  async function hearSound() {
    const played = await testSound();
    setSoundMessage(played ? 'Đã phát âm thử. Nếu chưa nghe, kiểm tra tab có bị tắt tiếng và âm lượng Windows.' : 'Chưa phát được âm thanh. Cho phép âm thanh trong cài đặt của trang rồi bấm Nghe thử lại.');
  }

  async function toggleDesktop() {
    setMessage('');
    if (settings.desktop) {
      update({ ...settings, desktop: false });
      return;
    }
    const permission = await requestDesktopPermission();
    if (permission === 'unsupported') {
      setMessage('Trình duyệt này không hỗ trợ thông báo trên màn hình.');
      return;
    }
    if (permission === 'granted') update({ ...settings, desktop: true });
    else setMessage('Trình duyệt chưa cấp quyền thông báo. Bạn có thể bật quyền trong cài đặt của trang.');
  }

  function saveKeywords(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = keywords.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
    const unique = [...new Map(values.map((value) => [normalizeText(value), value])).values()].slice(0, 30);
    update({ ...settings, keywords: unique });
    setKeywords(unique.join(', '));
    setKeywordSaved(true);
  }

  return <div className="settings-stack">
    <section className="card settings-card" aria-labelledby="alert-settings-title">
      <div className="panel-title"><span className="panel-heading-icon tone-violet"><Bell size={20} /></span><div><h2 id="alert-settings-title">Tùy chọn thông báo</h2><p>Áp dụng cho sự kiện mới khi bảng điều khiển đang mở.</p></div></div>
      <div className="setting-list">
        <Toggle icon={<Gift size={19} />} title="Quà tặng" description="Thông báo khi lượt tặng quà đã hoàn tất." checked={settings.giftAlerts} onToggle={() => update({ ...settings, giftAlerts: !settings.giftAlerts })} />
        <Toggle icon={<MessageCircle size={19} />} title="Bình luận" description="Bật để có âm báo cho comment; để trống từ khóa nếu muốn báo mọi comment." checked={settings.commentAlerts} onToggle={() => { if (!settings.commentAlerts && settings.sound) void unlockSound(); update({ ...settings, commentAlerts: !settings.commentAlerts }); }} />
        <Toggle icon={<Volume2 size={19} />} title="Âm thanh" description="Phát tiếng khi có bình luận hoặc quà thuộc loại thông báo bạn đã bật." checked={settings.sound} onToggle={() => { if (!settings.sound) void hearSound(); update({ ...settings, sound: !settings.sound }); }} />
        <Toggle icon={<Bell size={19} />} title="Thông báo trên màn hình" description="Hiện tên và nội dung bình luận khi bạn ở tab hoặc cửa sổ khác. Giữ LiveLens mở và cho phép thông báo khi trình duyệt hỏi." checked={settings.desktop} onToggle={() => void toggleDesktop()} />
      </div>
      <div className="sound-test"><button type="button" className="button button-small" onClick={() => void hearSound()}><Volume2 size={16} /> Nghe thử</button><button type="button" className="button button-small" onClick={() => {
        update({ ...settings, sound: true, commentAlerts: true, keywords: [] });
        setKeywords('');
        setKeywordSaved(false);
        void hearSound();
      }}>Bật báo mọi bình luận</button></div>
      <p className="sound-description">{!settings.sound ? 'Âm báo tự động đang tắt.' : !settings.commentAlerts && !settings.giftAlerts ? 'Chưa chọn loại sự kiện để phát âm báo.' : `Đang báo: ${[settings.commentAlerts && (settings.keywords.length ? 'bình luận khớp từ khóa' : 'mọi bình luận'), settings.giftAlerts && 'quà đã chốt'].filter(Boolean).join(' và ')}.`}</p>
      {soundMessage && <p className="field-hint" role="status">{soundMessage}</p>}
      {message && <ErrorNotice message={message} />}
    </section>
    <section className="card settings-card" aria-labelledby="keywords-title">
      <div className="panel-title"><span className="panel-heading-icon tone-blue"><MessageCircle size={20} /></span><div><h2 id="keywords-title">Từ khóa bình luận</h2><p>Phân cách bằng dấu phẩy. Để trống để nhận mọi bình luận khi bật thông báo.</p></div></div>
      <form className="settings-form" onSubmit={saveKeywords}>
        <label htmlFor="alert-keywords">Từ khóa cần theo dõi</label>
        <div className="input-wrap"><input id="alert-keywords" value={keywords} onChange={(event) => { setKeywords(event.target.value); setKeywordSaved(false); }} placeholder="giá, bảng size, màu trắng" maxLength={500} /></div>
        <div className="form-actions">
          <button className="button button-primary" type="submit">Lưu từ khóa</button>{keywordSaved && <span role="status" className="success-text">Đã lưu từ khóa</span>}
        </div>
      </form>
    </section>
  </div>;
}

function Toggle({ icon, title, description, checked, onToggle }: {
  icon: React.ReactNode; title: string; description: string; checked: boolean; onToggle: () => void;
}) {
  return <div className="setting-row">
    <span className="setting-icon" aria-hidden="true">{icon}</span>
    <div><strong>{title}</strong><p>{description}</p></div>
    <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={title} onClick={onToggle}><span /></button>
  </div>;
}

export function GeneralSettings({ connection, openConnection }: { connection: Connection; openConnection: () => void }) {
  return <div className="settings-stack">
    <section className="card settings-card" aria-labelledby="settings-server-title">
      <div className="panel-title"><span className="panel-heading-icon tone-blue"><Server size={20} /></span><div><h2 id="settings-server-title">Máy chủ LIVE</h2><p>Chọn dịch vụ cung cấp dữ liệu từ TikTok LIVE.</p></div></div>
      <div className="setting-list">
        <div className="setting-row">
          <span className="setting-icon"><Link2 size={19} /></span>
          <div><strong>Địa chỉ kết nối</strong><p>{connection.origin || 'Cùng địa chỉ với bảng điều khiển'}</p></div>
          <button className="button button-small" type="button" onClick={openConnection}><Settings2 size={16} /> Chỉnh sửa</button>
        </div>
      </div>
    </section>
    <section className="card settings-card" aria-labelledby="settings-source-title">
      <div className="panel-title"><span className="panel-heading-icon tone-mint"><Code2 size={20} /></span><div><h2 id="settings-source-title">Chạy LiveLens trên máy của bạn</h2><p>Tải mã nguồn và xem hướng dẫn cấu hình trong README.</p></div></div>
      <ol className="setup-steps">
        <li>Cài Node.js 24 trở lên, giải nén mã nguồn và mở thư mục trong terminal.</li>
        <li>Chạy <code>npm ci</code>, <code>npm run build</code> rồi <code>npm start</code>.</li>
        <li>Mở <code>http://localhost:3001</code> để kết nối trong ứng dụng cục bộ.</li>
      </ol>
      <a className="button button-small" href="/livelens-source.zip" download><Download size={16} /> Mã nguồn</a>
    </section>
  </div>;
}

export function ConnectionDialog({ connection, onSave, onClose }: {
  connection: Connection; onSave: (next: Connection) => void; onClose: () => void;
}) {
  const [origin, setOrigin] = useState(connection.origin);
  const [token, setToken] = useState(connection.token);
  const [error, setError] = useState('');
  const [tested, setTested] = useState(false);
  const [checking, setChecking] = useState(false);
  const read = () => ({ origin: normalizeOrigin(origin), token: token.trim() });

  function editOrigin(value: string) {
    setOrigin(value);
    setTested(false);
    setError('');
    try {
      if (normalizeOrigin(value) === normalizeOrigin(origin)) return;
    } catch {
      // An invalid address must discard credentials from the previous address.
    }
    setToken('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (checking) return;
    try {
      onSave(read());
    } catch (error) {
      setError(messageOf(error));
    }
  }

  async function testConnection() {
    if (checking) return;
    setError('');
    setChecking(true);
    setTested(false);
    try {
      const client = new LiveClient(read());
      const result = await client.health(AbortSignal.timeout(10000));
      if (!result.ok) throw new Error('Máy chủ LiveLens chưa sẵn sàng.');
      if (result.authRequired) await client.sessions(AbortSignal.timeout(10000));
      setTested(true);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setChecking(false);
    }
  }

  return <Dialog title="Cài đặt kết nối" onClose={onClose}>
    <p className="dialog-description">LIVE thật cần một máy chủ LiveLens đang chạy. Nếu bạn đang dùng bản trực tuyến, nhập địa chỉ HTTPS của máy chủ đã cho phép trang này truy cập.</p>
    <form className="settings-form" onSubmit={save}>
      <label htmlFor="server-url">Địa chỉ máy chủ</label>
      <div className="input-wrap"><Link2 size={17} /><input id="server-url" autoFocus value={origin} disabled={checking} onChange={(event) => editOrigin(event.target.value)} placeholder="https://live.example.com" autoComplete="off" inputMode="url" /></div>
      <p className="field-hint">Để trống nếu máy chủ chạy cùng địa chỉ với bảng điều khiển.</p>
      <label htmlFor="server-token">Mã truy cập <span className="optional">(nếu có)</span></label>
      <div className="input-wrap"><input id="server-token" type="password" autoComplete="new-password" value={token} disabled={checking} onChange={(event) => { setToken(event.target.value); setTested(false); }} placeholder="Nhập mã của máy chủ" /></div>
      <p className="field-hint">Mã chỉ được lưu trong phiên trình duyệt này.</p>
      {error && <ErrorNotice message={error} />}
      {tested && <p className="success-text" role="status">Đã truy cập được máy chủ LiveLens.</p>}
      <div className="dialog-actions">
        <button className="button" type="button" disabled={checking} onClick={() => void testConnection()}>{checking ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>
        <button className="button button-primary" type="submit" disabled={checking}>Lưu kết nối</button>
      </div>
    </form>
  </Dialog>;
}

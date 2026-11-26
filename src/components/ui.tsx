import { useEffect, useRef, type ReactNode } from 'react';
import { CircleAlert, Gift, Radio, X } from 'lucide-react';
import type { LiveGift, LiveUser, SessionStatus } from '../../shared/contracts';
import { normalizeText } from '../preferences';

export const formatCount = new Intl.NumberFormat('vi-VN').format;
export const formatTime = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format;
export const formatDate = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
}).format;

const labels: Record<SessionStatus, string> = {
  connecting: 'Đang kết nối',
  connected: 'Đã kết nối',
  reconnecting: 'Đang kết nối lại',
  stopped: 'Đã dừng',
  ended: 'LIVE đã kết thúc',
  error: 'Gián đoạn',
};

export function StatusPill({ status, demo, isSample, streamIssue }: {
  status?: SessionStatus; demo?: boolean; isSample?: boolean; streamIssue?: boolean;
}) {
  const context = streamIssue ? 'reconnecting' : status;
  const label = isSample ? 'Sẵn sàng' : demo && context === 'connected' ? 'Đang mô phỏng'
    : context ? labels[context] : 'Chưa kết nối';
  return <span className={`status-pill status-${context ?? 'idle'}`}><span className="status-dot" />{label}</span>;
}

export function SourceLabel({ demo }: { demo: boolean }) {
  return <span className={`source-tag ${demo ? 'source-demo' : 'source-live'}`}>
    <span className="source-dot" />{demo ? 'Dữ liệu mẫu' : 'TikTok LIVE'}
  </span>;
}

export function Avatar({ user, small = false }: { user?: LiveUser; small?: boolean }) {
  const label = (user?.nickname || user?.username || '?').trim();
  const words = label.split(/\s+/);
  const initials = words.length > 1 ? words[0][0] + words.at(-1)![0] : label.slice(0, 2);
  const color = [...(user?.id || label)].reduce((acc, item) => acc + item.codePointAt(0)!, 0) % 6;
  return <span className={`avatar avatar-${color} ${small ? 'avatar-small' : ''}`} aria-hidden="true">{initials.toUpperCase()}</span>;
}

export function GiftIcon({ gift }: { gift: LiveGift }) {
  const name = normalizeText(gift.name);
  let emoji = '';
  let color = 'pink';
  if (gift.id === 'rose' || /rose|hoa hong/.test(name)) emoji = '🌹';
  else if (gift.id === 'heart' || /heart|tim tay|trai tim/.test(name)) {
    emoji = '🫶'; color = 'peach';
  } else if (gift.id === 'bear' || /bear|gau bong/.test(name)) {
    emoji = '🧸'; color = 'amber';
  }
  return <span className={`gift-icon gift-${color}`} aria-hidden="true">{emoji || <Gift size={18} />}</span>;
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return <div className="empty-state">
    <span className="empty-icon">{icon || <Radio size={21} />}</span>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
  </div>;
}

export function ErrorNotice({ message, children }: { message: string; children?: ReactNode }) {
  return <div className="error-notice" role="status"><CircleAlert size={18} /><span>{message}</span>{children}</div>;
}

export function Dialog({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current!;
    const prior = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (prior instanceof HTMLElement) prior.focus();
    };
  }, []);
  return <dialog
    ref={dialogRef}
    className={`dialog ${className}`}
    aria-labelledby="dialog-title"
    onCancel={(event) => { event.preventDefault(); onCloseRef.current(); }}
  >
    <div className="dialog-heading">
      <h2 id="dialog-title">{title}</h2>
      <button type="button" className="icon-button" title="Đóng" aria-label="Đóng" onClick={onClose}><X size={19} /></button>
    </div>
    {children}
  </dialog>;
}

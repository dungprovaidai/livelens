import type { LiveEvent, NotificationSettings } from '../shared/contracts';
import { normalizeOrigin, type Connection } from './client.ts';

const settingsKey = 'livelens.preferences.v1';
const originKey = 'livelens.backend';
const tokenKey = 'livelens.token.v2';
export const defaultSettings: NotificationSettings = {
  sound: true, desktop: false, giftAlerts: true, commentAlerts: false, keywords: [],
};

export function readSetting(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences remain usable in memory when storage is blocked.
  }
}

export function readPreferences(): NotificationSettings {
  try {
    return { ...defaultSettings, ...JSON.parse(readSetting(settingsKey) || '{}') };
  } catch {
    return defaultSettings;
  }
}

export function savePreferences(settings: NotificationSettings) {
  writeSetting(settingsKey, JSON.stringify(settings));
}

export function readConnection(): Connection {
  let origin: string;
  try {
    origin = normalizeOrigin(readSetting(originKey) || '');
  } catch {
    return { origin: '', token: '' };
  }

  try {
    const saved = JSON.parse(sessionStorage.getItem(tokenKey) || 'null');
    if (saved?.origin === origin && typeof saved.token === 'string') {
      return { origin, token: saved.token };
    }
  } catch {
    // A private or restricted browser can still configure a connection in memory.
  }
  return { origin, token: '' };
}

export function saveConnection(connection: Connection) {
  const origin = normalizeOrigin(connection.origin);
  writeSetting(originKey, origin);
  try {
    if (connection.token) sessionStorage.setItem(tokenKey, JSON.stringify({ origin, token: connection.token }));
    else sessionStorage.removeItem(tokenKey);
    sessionStorage.removeItem('livelens.token');
  } catch {
    // Keep the token available only for the lifetime of the page.
  }
}

let audio: AudioContext | undefined;

export async function unlockSound(): Promise<boolean> {
  try {
    if (audio?.state === 'closed') audio = undefined;
    audio ??= new AudioContext();
    if (audio.state !== 'running') await audio.resume();
    return audio.state === 'running';
  } catch {
    return false;
  }
}

function playSound() {
  if (audio?.state !== 'running') return false;
  try {
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    const now = audio.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.setValueAtTime(1174, now + 0.22);
    volume.gain.setValueAtTime(0.001, now);
    volume.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
    volume.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    volume.gain.exponentialRampToValueAtTime(0.18, now + 0.24);
    volume.gain.exponentialRampToValueAtTime(0.001, now + 0.46);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.48);
    oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
    return true;
  } catch {
    return false;
  }
}

export async function testSound() {
  return await unlockSound() && playSound();
}

export function normalizeText(value: string) {
  return value.normalize('NFD').replace(/\p{Mark}/gu, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi');
}

export async function requestDesktopPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notifyEvent(event: LiveEvent, settings: NotificationSettings, demo: boolean) {
  const { gift, user, comment, type } = event;
  const name = user?.nickname || user?.username || 'Một người xem';
  let description = '';
  if (type === 'gift.completed' && settings.giftAlerts && gift) {
    description = `${name} đã tặng ${gift.name} ×${gift.quantity}`;
  }
  if (type === 'chat' && settings.commentAlerts && comment) {
    const matches = !settings.keywords.length || settings.keywords.some((word) => normalizeText(comment).includes(normalizeText(word)));
    if (matches) description = `${name}: ${comment}`;
  }
  if (!description) return;
  const sounded = settings.sound ? playSound() : undefined;
  if (!settings.desktop || !('Notification' in window) || Notification.permission !== 'granted') return sounded;
  if (document.visibilityState === 'visible' && document.hasFocus()) return sounded;
  try {
    const title = type === 'chat' ? `${demo ? 'Demo · ' : ''}${name} bình luận · LiveLens`
      : demo ? 'LiveLens · Dữ liệu mẫu' : 'LiveLens · TikTok LIVE';
    const notification = new Notification(title, {
      body: (type === 'chat' && comment ? comment : description).slice(0, 300),
      tag: `livelens:${event.sessionId}:${event.id}`, silent: true,
    });
    notification.onclick = () => {
      window.focus();
      window.location.hash = '#overview';
      notification.close();
    };
  } catch {
    // Some mobile browsers require a service worker for desktop notifications.
  }
  return sounded;
}

import { randomUUID } from 'node:crypto';

const usernamePattern = /^[a-z0-9._]{1,24}$/i;
const targetHosts = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const shortHosts = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

function targetError(message, code = 'INVALID_TARGET') {
  return Object.assign(new Error(message), { code });
}

export function parseTikTokTarget(input) {
  const invalid = () => targetError('Nhập @tên_người_dùng hoặc liên kết TikTok đầy đủ như https://www.tiktok.com/@ten/live.');
  if (typeof input !== 'string' || input.length > 2048) throw invalid();
  let target = input.trim();
  if (!target.startsWith('@')) {
    const match = /^(?:https:\/\/)?([a-z0-9.-]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#[^\s]*)?$/i.exec(target);
    if (!match || /[\\\s]/.test(target)) throw invalid();
    const host = match[1].toLowerCase();
    if (shortHosts.has(host) || (targetHosts.has(host) && /^\/t\//i.test(match[2] ?? ''))) {
      throw targetError('Mở liên kết rút gọn trong TikTok, rồi sao chép liên kết LIVE đầy đủ của nhà sáng tạo.', 'SHORT_LINK');
    }
    const path = /^\/@([a-z0-9._]+)(?:\/live)?\/?$/i.exec(match[2] ?? '');
    if (!targetHosts.has(host) || !path) throw invalid();
    target = `@${path[1]}`;
  }

  const username = target.slice(1);
  if (!usernamePattern.test(username) || username.endsWith('.')) throw invalid();
  return username.toLowerCase();
}

export function safeId(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value && value !== '0') return value.slice(0, 160);
    if (typeof value === 'bigint' && value !== 0n) return value.toString();
    if (Number.isSafeInteger(value) && value !== 0) return String(value);
  }
  return '';
}

function text(limit, ...values) {
  return (values.find((value) => typeof value === 'string' && value.length > 0) ?? '').slice(0, limit);
}

function imageUrl(...values) {
  return values.flatMap((value) => typeof value === 'string' ? [value] : value?.urlList ?? [])
    .find((value) => typeof value === 'string' && /^https:\/\//i.test(value) && value.length <= 2048);
}

function getUser(payload) {
  const raw = payload.user ?? payload;
  const username = text(100, raw.displayId, raw.uniqueId, payload.uniqueId);
  const id = safeId(raw.id, raw.userId, payload.userId, raw.secUid, username);
  const avatar = imageUrl(raw.avatarThumb, raw.avatarMedium, raw.profilePictureUrl, payload.profilePictureUrl);
  return {
    id: id || 'unknown',
    username: username || id || 'nguoi_xem',
    nickname: text(200, raw.nickname, payload.nickname) || username || 'Người xem',
    ...(avatar && { avatar }),
  };
}

function timestamp(payload) {
  const value = payload.common?.createTime ?? payload.createTime ?? payload.timestamp;
  const time = Number(value);
  const milliseconds = time < 100_000_000_000 ? time * 1000 : time;
  return new Date(Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8.64e15
    ? milliseconds : Date.now()).toISOString();
}

function messageId(payload) {
  return safeId(payload.common?.msgId, payload.msgId, payload.messageId, payload.logId, payload.common?.logId);
}

function key(...parts) {
  return JSON.stringify(parts);
}

function roomId(payload, sessionRoom) {
  return safeId(payload.common?.roomId, payload.roomId, sessionRoom);
}

export function normalizeChat(payload, sessionRoom) {
  const comment = text(8000, payload.content, payload.comment);
  if (!comment) return null;
  const id = messageId(payload);
  return {
    event: { id: id || randomUUID(), type: 'chat', timestamp: timestamp(payload), user: getUser(payload), comment },
    sourceKey: id ? key('chat', roomId(payload, sessionRoom), id) : null,
  };
}

function nonnegativeInteger(...values) {
  for (const raw of values) {
    if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\d+$/.test(raw))) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
}

export function normalizeAudience(payload, sessionRoom, type) {
  const id = messageId(payload);
  const event = { id: id || randomUUID(), type, timestamp: timestamp(payload) };
  if (type === 'viewers') {
    const count = nonnegativeInteger(payload.viewerCount, payload.total);
    if (count === undefined) return null;
    event.viewerCount = count;
  } else {
    if (type === 'member' && payload.action !== undefined && Number(payload.action) !== 1) return null;
    event.user = getUser(payload);
    if (type === 'like') {
      event.likeCount = nonnegativeInteger(payload.likeCount, payload.count) ?? 0;
      const total = nonnegativeInteger(payload.totalLikeCount, payload.total);
      if (!event.likeCount && total === undefined) return null;
      if (total !== undefined) event.totalLikeCount = total;
    }
    if (type === 'share') event.shareCount = positiveInteger(payload.shareCount) ?? 1;
    if (event.user.id === 'unknown' && type !== 'like') return null;
  }
  return { event, sourceKey: id ? key(type, roomId(payload, sessionRoom), id) : null };
}

function positiveInteger(...values) {
  for (const candidate of values) {
    const value = Number(candidate);
    if (Number.isSafeInteger(value) && value > 0) return Math.min(value, 1_000_000);
  }
}

function giftType(...values) {
  for (const value of values) {
    const type = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (Number.isSafeInteger(type) && type >= 0) return type;
  }
}

function cacheRecent(cache, id, value) {
  cache.delete(id);
  cache.set(id, value);
  if (cache.size > 2048) cache.delete(cache.keys().next().value);
}

export class GiftNormalizer {
  #ungrouped = new Map();
  #details = new Map();

  normalize(payload, sessionRoom) {
    const gift = payload.gift ?? {};
    const id = safeId(payload.giftId, gift.id, payload.extendedGiftInfo?.id);
    if (!id) return null;

    const user = getUser(payload);
    const recipient = safeId(payload.toUser?.id, payload.toUser?.userId, payload.toUser?.displayId,
      payload.toMemberId, payload.toMemberIdInt, payload.receiverUserId);
    const group = safeId(payload.groupId, payload.group_id, payload.orderId);
    const scope = key(roomId(payload, sessionRoom), user.id, recipient, id);
    const sourceId = messageId(payload);
    const upstreamId = sourceId || randomUUID();
    const quantity = positiveInteger(payload.repeatCount, payload.comboCount) ?? 1;
    const details = this.#giftDetails(key(scope, group), gift, payload);
    const isStreak = details.type === undefined || details.type === 1;
    const isFinal = !isStreak || Number(payload.repeatEnd) === 1;
    const comboKey = isStreak
      ? group ? key(scope, 'group', group) : this.#ungroupedKey(scope, payload, sourceId, isFinal)
      : null;
    const sourceParts = ['gift', scope, group, sourceId];
    if (isStreak) sourceParts.push(isFinal, quantity);
    return {
      event: {
        id: upstreamId,
        timestamp: timestamp(payload),
        type: isFinal ? 'gift.completed' : 'gift.progress',
        user,
        gift: {
          id,
          name: details.name || `Quà ${id}`,
          quantity,
          streakId: comboKey ?? key(scope, 'message', upstreamId),
          isFinal,
          ...(details.diamonds && { diamonds: details.diamonds }),
          ...(details.image && { image: details.image }),
        },
      },
      sourceKey: sourceId ? key(...sourceParts) : null,
      comboKey,
      completionKey: isFinal ? comboKey : null,
    };
  }

  #giftDetails(id, gift, payload) {
    const now = Date.now();
    const old = this.#details.get(id);
    const previous = old && now - old.updatedAt < 300_000 ? old : {};
    const extended = payload.extendedGiftInfo;
    const type = giftType(gift.type, gift.giftType, payload.giftType, extended?.type);
    const name = text(200, gift.name, payload.giftName, extended?.name);
    const diamonds = positiveInteger(gift.diamondCount, payload.diamondCount, extended?.diamond_count);
    const image = imageUrl(gift.image, gift.icon, payload.giftPictureUrl, gift.image?.url_list, extended?.image?.url_list);
    const details = {
      type: type ?? (gift.combo === true ? 1 : previous.type),
      name: name || previous.name,
      diamonds: diamonds ?? previous.diamonds,
      image: image || previous.image,
      updatedAt: now,
    };
    cacheRecent(this.#details, id, details);
    return details;
  }

  #ungroupedKey(scope, payload, sourceId, isFinal) {
    const now = Date.now();
    const previous = this.#ungrouped.get(scope);
    const active = previous && now - previous.updatedAt < 120_000 ? previous : null;
    let id = active?.id;
    if (!id || (!isFinal && (active.completed || payload.isFirstSent === true) && sourceId !== active.sourceId)
      || (isFinal && active.completed && sourceId !== active.sourceId)) {
      id = sourceId || randomUUID();
    }
    const completed = isFinal || (active?.id === id && active.completed);
    cacheRecent(this.#ungrouped, scope, { id, updatedAt: now, completed, sourceId });
    return key(scope, 'ungrouped', id);
  }
}

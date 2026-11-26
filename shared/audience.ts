import type { AudienceData, LiveEvent, ViewerSummary } from './contracts.ts';

export function normalizeAudienceText(value: string) {
  return value.normalize('NFD').replace(/\p{Mark}/gu, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi');
}

export function emptyAudience(): AudienceData {
  return { currentViewers: null, peakViewers: null, updatedAt: null, totalLikes: null, viewers: [], samples: [] };
}

export function updateViewer(previous: ViewerSummary | undefined, event: LiveEvent): ViewerSummary | null {
  if (!event.user?.id || event.user.id === 'unknown') return null;
  const viewer = previous ? { ...previous, user: { ...previous.user, ...event.user } } : {
    user: event.user, firstSeen: event.timestamp, lastSeen: event.timestamp,
    comments: 0, gifts: 0, likes: 0, joins: 0, follows: 0, shares: 0,
  };
  if (previous && event.user.username === event.user.id) viewer.user.username = previous.user.username;
  if (previous && event.user.nickname === 'Người xem') viewer.user.nickname = previous.user.nickname;
  viewer.firstSeen = viewer.firstSeen < event.timestamp ? viewer.firstSeen : event.timestamp;
  viewer.lastSeen = viewer.lastSeen > event.timestamp ? viewer.lastSeen : event.timestamp;
  viewer.comments += Number(event.type === 'chat');
  viewer.gifts += event.type === 'gift.completed' ? event.gift?.quantity ?? 0 : 0;
  viewer.likes += event.type === 'like' ? event.likeCount ?? 0 : 0;
  viewer.joins += Number(event.type === 'member');
  viewer.follows += Number(event.type === 'follow');
  viewer.shares += event.type === 'share' ? event.shareCount ?? 1 : 0;
  return viewer;
}

export function addAudienceEvent(data: AudienceData, event: LiveEvent): AudienceData {
  const next = { ...data };
  if (event.type === 'viewers' && event.viewerCount !== undefined) {
    next.currentViewers = event.viewerCount;
    next.peakViewers = Math.max(data.peakViewers ?? 0, event.viewerCount);
    next.updatedAt = event.timestamp;
    next.samples = [...data.samples, { seq: event.seq, timestamp: event.timestamp, count: event.viewerCount }];
  }
  if (event.totalLikeCount !== undefined) next.totalLikes = Math.max(data.totalLikes ?? 0, event.totalLikeCount);
  const index = data.viewers.findIndex((viewer) => viewer.user.id === event.user?.id);
  const viewer = updateViewer(data.viewers[index], event);
  if (viewer) next.viewers = index < 0 ? [...data.viewers, viewer] : data.viewers.map((item, position) => position === index ? viewer : item);
  return next;
}

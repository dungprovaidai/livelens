export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'ended' | 'error';
export type EventType = 'chat' | 'gift.progress' | 'gift.completed' | 'status' | 'viewers' | 'member' | 'like' | 'follow' | 'share';
export interface LiveUser { id: string; username: string; nickname: string; avatar?: string }
export interface LiveGift { id: string; name: string; quantity: number; streakId: string; isFinal: boolean; diamonds?: number; image?: string }
export interface LiveEvent {
  id: string; seq: number; sessionId: string; type: EventType; timestamp: string;
  user?: LiveUser; comment?: string; gift?: LiveGift; status?: SessionStatus; message?: string;
  viewerCount?: number; likeCount?: number; totalLikeCount?: number; shareCount?: number;
}
export interface LiveSession {
  id: string; uniqueId: string; roomId: string | null; mode: 'live' | 'demo'; status: SessionStatus;
  createdAt: string; endedAt: string | null; lastEventAt: string | null; error: string | null;
  stats: { comments: number; gifts: number; gifters: number; events: number };
}
export interface NotificationSettings { sound: boolean; desktop: boolean; giftAlerts: boolean; commentAlerts: boolean; keywords: string[] }
export interface HistoryResponse { events: LiveEvent[]; nextCursor: number; hasMore: boolean }
export interface HealthResponse { ok: boolean; version: string; storage: 'sqlite' | 'postgres'; authRequired: boolean }
export interface ViewerSummary {
  user: LiveUser; firstSeen: string; lastSeen: string;
  comments: number; gifts: number; likes: number; joins: number; follows: number; shares: number;
}
export interface ViewerSample { seq: number; timestamp: string; count: number }
export interface AudienceData {
  currentViewers: number | null; peakViewers: number | null; updatedAt: string | null; totalLikes: number | null;
  viewers: ViewerSummary[]; samples: ViewerSample[];
}
export interface AudienceResponse extends AudienceData {
  knownViewers: number; joins: number; likes: number; follows: number; shares: number;
  total: number; offset: number; hasMore: boolean;
}

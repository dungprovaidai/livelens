# LiveLens — approved workflow and implementation decisions

User asked for a custom web app that accepts a TikTok LIVE link and observes comments/gifts in real time, then explicitly requested code. This implements the design described in the conversation without another approval gate.

## Product
Vietnamese dashboard named LiveLens, one active room at a time. Paste link/@username, start/stop, live chat, gift streak cards, aggregate totals, user/keyword filtering, pause autoscroll, sound and opt-in browser notifications, session history, CSV export. React frontend; continuous Node.js listener; SSE; persistent storage.

## Runtime decisions
- Node 24 runtime. Production Docker Compose uses PostgreSQL. Local quickstart defaults to built-in SQLite so it works without a database install.
- Static private Sites deployment is a usable demo/client, not a continuously running Node server. Full backend source is included; run it locally or on an always-on server. An optional backend URL in settings connects the hosted client. Never fake a live connection or silently fall back to demo.
- Demo is explicitly labeled at all times and works offline/in a static deployment. Real mode is available through the Node backend, using tiktok-live-connector 2.5.0. No TikTok credentials are bundled; SIGN_API_KEY is an optional server-side Euler signing key.
- Authentication: APP_TOKEN protects remote API calls; no auth is allowed only for loopback-bound development. Token is kept in browser session memory/sessionStorage, not bundled source or URL. Explicit CORS allowlist for remote clients. Untrusted comments are rendered as text.
- Canonical TikTok live/profile URLs and @username accepted, arbitrary domains rejected. Short links show a helpful instruction to paste the full creator LIVE link; no arbitrary URL fetching.
- Gift counts are cumulative. Show progress; count each completed streak exactly once. Isolate room/sender/recipient/gift/group, preserve string IDs, keep source duplicate detection separate from streak aggregation.
- Persist received events before publishing. SSE reconnect replays stored events after cursor. Source disconnection is shown as a possible data gap; no promise of full TikTok backfill.
- A storage write failure stops intake and makes health return HTTP 503 with `STORAGE_ERROR`. Session reads overlay the failure from memory if the database cannot persist it. Fix storage and restart before starting another session.
- One active session, guarded against concurrent starts; reconnect backoff and stop cancel pending connections/timers; stream end is distinct from transport disconnect. Register listeners once. Process restart must leave saved history truthful and explicitly mark interruptions.
- Notifications default to gift alerts/sound enabled, comment popups disabled; desktop permission only on user request. Works while browser is open. No promised background phone push.
- Restored sessions show an enable-sound action until audio is running. Pointer/keyboard gestures also resume audio. Refresh session lists every five seconds and on tab focus/visibility to discover changes from other tabs.
- Listen to raw v3 ROOM_USER (`total`), MEMBER (join action 1), LIKE (`count`, `total`), FOLLOW and SHARE. Viewer totals are independent of identified accounts. Unknown viewer counts remain null, while a valid zero is retained. Missing or unsafe counts are rejected.
- Project audience totals, identified accounts and viewer samples in the same database transaction as each inserted event. Deduplication happens before projection, including gift completion deduplication. Auxiliary tables and a per-session sequence cursor rebuild older sessions in bounded transactions without rewriting original events. Node 24 loads the shared TypeScript audience helper directly; runtime Docker copies `shared/` too.
- Query viewer summaries from stored per-account totals, with search, filters and pagination across the full session. Chart responses contain at most about 120 samples spread over the session; peak viewer count uses every received sample. Per-account event history filters by exact user ID. CSV uses user-ID pagination so concurrent new accounts cannot shift offsets and duplicate existing rows.
- The Notifications page offers a real test tone and a single action to enable all-comment sound. This explicitly enables comment alerts and clears keyword filters. Audio playback failures cannot throw into event-stream processing. Browser and OS mute controls still affect audible output.
- The reader shows comment sound settings explicitly and restores its enable action if playback fails. A separate desktop-notification action requests browser permission, enables all-comment alerts and clears keywords while preserving the sound preference. Desktop notifications appear only while the document is hidden or unfocused; chat titles name the commenter and bodies contain the comment. An event-specific tag prevents multiple tabs from duplicating the same notification. Clicking a notification focuses the reader. Reloaded history snapshots do not trigger notifications.

## API contract
All response objects use shared/contracts.ts. JSON error responses: `{error: string, code?: string}`.
- GET /api/health -> HealthResponse (public); HTTP 503 with `STORAGE_ERROR` after a storage failure.
- GET /api/live-sessions -> {sessions: LiveSession[]} (newest first)
- POST /api/live-sessions {url:string,mode:'live'|'demo'} -> 201 {session:LiveSession}, 400 invalid URL, 409 active session
- GET /api/live-sessions/:id -> {session:LiveSession}
- POST /api/live-sessions/:id/stop -> {session:LiveSession}
- GET /api/live-sessions/:id/history?after=0&limit=300 -> HistoryResponse. Omit after for latest bounded page, ascending seq. When after is present, read ascending from cursor. Use `before` instead of `after` to read older pages, returned ascending. `search` (up to 200 characters) searches the full saved session without Vietnamese accent distinctions. `type=all|chat|gift` filters the event kind; `userId` selects one exact account ID. `nextCursor` is the last returned seq; `hasMore` indicates additional matches in the selected direction.
- GET /api/live-sessions/:id/events?after=123 -> SSE frames `id: seq`, `event: event`, `data: LiveEvent JSON`. Streaming fetch accepts Authorization header; no secret in query string.
- GET /api/live-sessions/:id/export -> CSV with formula-safe cells.
- GET /api/live-sessions/:id/audience -> AudienceResponse. `search` (max 200 characters), `filter=all|chat|gift`, `sort=recent|comments|gifts|likes|joins`, `offset` and `limit` (1–200; default 50). Global counts and chart remain independent of the filtered viewer page.
- GET /api/live-sessions/:id/audience-export -> formula-safe CSV for all identified accounts in the session.

Settings remain local to the browser; no pretend PATCH route. The UI may poll session metadata to update aggregate totals, while SSE delivers events. Standalone demo implements the same contracts entirely locally and is visibly separate.

## Visual direction
Vietnamese comment reader: deep midnight sidebar, pale canvas, white cards and green primary actions. Comments default to 22px, adjustable from 18–30px, with smaller sender details and the latest row highlighted. The reader fills the desktop height; statistics, gifts and recent top senders sit in a narrow side column. Fullscreen reading, pause on scroll, older-event pagination and full-session search preserve the main focus on comments. Mobile navigation sits at the bottom. Demo and real sources remain explicit.

## Verification scope
Meaningful automated tests for URL validation, gift cumulative/final/dedupe and concurrency, persistent history, auth/CORS, stop vs pending connect, SSE replay, CSV safety. Browser QA for start/stop demo, real mode validation, filtering, history, settings, export, responsive overflow. Real TikTok receipt requires a currently live link and an environment that can connect; report if not exercised.

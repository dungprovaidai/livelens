import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTikTokTarget, normalizeAudience, normalizeChat, GiftNormalizer } from '../server/normalize.mjs';

test('TikTok targets accept handles and full TikTok profile or LIVE URLs', () => {
  for (const input of [
    '@Creator.1', 'https://www.tiktok.com/@Creator.1/live?lang=vi',
    'https://m.tiktok.com/@Creator.1/', 'tiktok.com/@Creator.1/live',
  ]) {
    assert.equal(parseTikTokTarget(input), 'creator.1');
  }
});

test('TikTok targets reject redirects, lookalike domains and non-LIVE routes', () => {
  for (const input of [
    'https://www.tiktok.com.example.org/@Creator/live',
    'https://www.tiktok.com@evil.org/@Creator/live',
    'https://someone@www.tiktok.com/@Creator/live',
    'https://www.tiktok.com:8010/@Creator/live',
    'http://www.tiktok.com/@Creator/live',
    'https://www.tiktok.com/@Creator/video/1',
    'https://www.tiktok.com/@Creator/live/..',
    'https://www.tiktok.com/@Creator/live/extra',
    'https://www.tiktok.com/@Creator/live\\other',
    '@creator.',
  ]) {
    assert.throws(() => parseTikTokTarget(input), { code: 'INVALID_TARGET' });
  }
  assert.throws(() => parseTikTokTarget('https://vm.tiktok.com/Zgood/'), { code: 'SHORT_LINK' });
});

test('chat normalization preserves 64-bit IDs and reads the v3 payload', () => {
  const { event, sourceKey } = normalizeChat({
    common: { msgId: '9223372036854775801', roomId: '9223372036854775803', createTime: '1770000000000' },
    user: {
      id: '9223372036854775802', displayId: 'tiktoker', nickname: 'Người xem',
      avatarThumb: { urlList: ['https://example.net/avatar.png'] },
    },
    content: 'Xin chào!',
  });
  assert.equal(event.id, '9223372036854775801');
  assert.equal(event.user.id, '9223372036854775802');
  assert.equal(event.comment, 'Xin chào!');
  assert.equal(event.user.avatar, 'https://example.net/avatar.png');
  assert.equal(event.timestamp, '2026-02-02T02:40:00.000Z');
  assert.match(sourceKey, /9223372036854775801/);
});

function gift(overrides = {}) {
  return {
    common: { msgId: '9198765432109876543', roomId: '9098765432109876543' },
    giftId: '9898765432109876543',
    user: { id: '9398765432109876543', displayId: 'nguoi_gui', nickname: 'Người gửi' },
    toUser: { id: '9498765432109876543' },
    groupId: '9298765432109876543',
    repeatCount: 1,
    repeatEnd: 0,
    gift: { type: 1, name: 'Hoa hồng', diamondCount: 1 },
    ...overrides,
  };
}

test('gift source deduplication distinguishes cumulative updates sharing a message ID', () => {
  const normalize = new GiftNormalizer();
  const phases = [gift(), gift({ repeatCount: 2 }), gift({ repeatCount: 5 }),
    gift({ repeatCount: 5, repeatEnd: 1 })].map((payload) => normalize.normalize(payload));
  assert.deepEqual(phases.map(({ event }) => [event.type, event.gift.quantity]), [
    ['gift.progress', 1], ['gift.progress', 2], ['gift.progress', 5], ['gift.completed', 5],
  ]);
  assert.equal(new Set(phases.map(({ sourceKey }) => sourceKey)).size, 4);
  assert.equal(new Set(phases.map(({ event }) => event.gift.streakId)).size, 1);
  assert.equal(phases[3].event.gift.id, '9898765432109876543');
  const finalWithNewMessageId = normalize.normalize(gift({
    common: { msgId: '9198765432109876544', roomId: '9098765432109876543' },
    repeatCount: 5, repeatEnd: 1,
  }));
  assert.notEqual(finalWithNewMessageId.sourceKey, phases[3].sourceKey);
  assert.equal(finalWithNewMessageId.completionKey, phases[3].completionKey);
});

test('gift streaks stay independent by room, sender, recipient, gift and group', () => {
  const normalize = new GiftNormalizer();
  const scopes = [
    gift(),
    gift({ common: { msgId: '9198765432109876543', roomId: 'second-room' } }),
    gift({ user: { id: 'second-sender', displayId: 'nguoi_gui_2' } }),
    gift({ toUser: { id: 'second-recipient' } }),
    gift({ giftId: 'second-gift' }),
    gift({ groupId: 'second-group' }),
  ];
  const issued = scopes.map((payload) => normalize.normalize(payload));
  const finals = scopes.reverse().map((payload) => normalize.normalize({ ...payload, repeatEnd: 1 }));
  assert.equal(new Set(issued.map(({ event }) => event.gift.streakId)).size, 6);
  assert.deepEqual(finals.map(({ event }) => event.gift.streakId),
    issued.toReversed().map(({ event }) => event.gift.streakId));
  assert.equal(new Set(finals.map(({ completionKey }) => completionKey)).size, 6);
});

test('non-streak gifts complete immediately, independent of gift ID', () => {
  const normalize = new GiftNormalizer();
  const first = normalize.normalize(gift({ gift: { type: 2, name: 'Ngôi sao' }, repeatCount: 3 }));
  const second = normalize.normalize(gift({
    common: { msgId: 'different-message', roomId: '9098765432109876543' },
    gift: { type: 2, name: 'Ngôi sao' },
  }));
  assert.equal(first.event.type, 'gift.completed');
  assert.equal(first.event.gift.quantity, 3);
  assert.equal(second.event.type, 'gift.completed');
  assert.notEqual(first.event.gift.streakId, second.event.gift.streakId);
  assert.equal(first.completionKey, null);
});

test('gift updates retain streak and display metadata when later packets omit it', () => {
  const normalize = new GiftNormalizer();
  const first = normalize.normalize(gift());
  const progress = normalize.normalize(gift({ gift: undefined, repeatCount: 2 }));
  const final = normalize.normalize(gift({ gift: undefined, repeatCount: 5, repeatEnd: 1 }));
  assert.equal(progress.event.type, 'gift.progress');
  assert.equal(final.event.type, 'gift.completed');
  assert.equal(final.event.gift.streakId, first.event.gift.streakId);
  assert.equal(final.event.gift.name, 'Hoa hồng');
  assert.equal(final.event.gift.diamonds, 1);
});

test('unknown gift type does not count cumulative quantities before an explicit final packet', () => {
  const normalize = new GiftNormalizer();
  const progress = normalize.normalize(gift({ gift: undefined, repeatCount: 2 }));
  const final = normalize.normalize(gift({ gift: undefined, repeatCount: 5, repeatEnd: 1 }));
  assert.equal(progress.event.type, 'gift.progress');
  assert.equal(final.event.type, 'gift.completed');
  assert.equal(final.event.gift.streakId, progress.event.gift.streakId);
});

test('audience normalization reads raw v3 counts, accepts zero and never treats cumulative users as current viewers', () => {
  const payload = { common: { msgId: '9999999999999999999', roomId: 'room' }, total: '123', totalUser: '9999' };
  assert.equal(normalizeAudience(payload, 'room', 'viewers').event.viewerCount, 123);
  assert.equal(normalizeAudience({ ...payload, total: '0' }, 'room', 'viewers').event.viewerCount, 0);
  assert.equal(normalizeAudience({ totalUser: '9999' }, 'room', 'viewers'), null);
  for (const invalid of [null, '', true, -1, '12.5', '9007199254740993', Infinity]) {
    assert.equal(normalizeAudience({ total: invalid }, 'room', 'viewers'), null);
  }
  const like = normalizeAudience({ ...payload, user: { id: '9223372036854775802', displayId: 'viewer' }, count: 4, total: '1500' }, 'room', 'like');
  assert.equal(like.event.likeCount, 4);
  assert.equal(like.event.totalLikeCount, 1500);
  assert.equal(like.event.user.id, '9223372036854775802');
  assert.equal(normalizeAudience({ user: { id: 'viewer' }, action: 3 }, 'room', 'member'), null);
  assert.equal(normalizeAudience({ action: 1 }, 'room', 'member'), null);
});

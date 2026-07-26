import { Hono } from 'hono';
import { getFriendByLineUserId, getLineAccounts, jstNow, type Friend } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { verifyCallerLineUserId } from '../services/liff-auth.js';
import { attachTagAndFireSideEffects } from '../services/friend-tag-attach.js';
import {
  businessDate,
  expiryDate,
  readWelcome,
  writeWelcome,
  welcomeStatus,
} from '../services/welcome-perk.js';
import {
  comebackStatus,
  ensureComebackVoucher,
  readComeback,
  resolveComebackTagId,
  writeComeback,
} from '../services/comeback-perk.js';
import type { Env } from '../index.js';

/**
 * Stamp card API for LIFF clients.
 *
 * Auth boundary: mounted under `/api/liff/`, which authMiddleware skips for
 * staff auth. Identity comes from the LIFF id_token, verified server-side by
 * `verifyCallerLineUserId` against LINE's verify endpoint. The friend row is
 * resolved from the verified `sub` — clients never pass a friend id, so one
 * customer can never read or mutate another's card.
 *
 * Anti-abuse: `claim` additionally requires the in-store code (STAMP_QR_CODE).
 * The printed QR embeds it, so a stamp can only be earned by someone who has
 * seen the code. A same-day replay is rejected by the `stamp_last_date` check,
 * which bounds a leaked photo of the QR to one stamp per day rather than an
 * unlimited farm.
 */
const stampRoutes = new Hono<Env>();

/** Stamps needed for one reward. Reaching it resets the card and banks a reward. */
export const STAMP_GOAL = 5;
/** Card count that triggers the "almost there" nudge push. */
const NUDGE_AT = 3;

export interface StampState {
  count: number;
  lastDate: string | null;
  /** Issue dates of the vouchers still in hand, oldest first. */
  rewardDates: string[];
  rewardsPending: number;
  rewardsTotal: number;
}

/** JST calendar date (YYYY-MM-DD) used for the one-stamp-per-day rule. */
export function jstDate(now: string = jstNow()): string {
  return now.slice(0, 10);
}

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Read stamp fields out of `friends.metadata`.
 *
 * metadata is a free-form JSON blob shared with forms and other features, so
 * this only ever touches the `stamp_*` keys and tolerates malformed JSON by
 * falling back to an empty card.
 */
/**
 * Voucher issue dates still in hand, oldest first, with expired ones dropped.
 *
 * Vouchers earned before per-voucher dates existed have no issue date. Padding
 * them with today rather than voiding them means an early customer keeps what
 * they earned; the alternative silently confiscates it on deploy.
 */
function readRewardDates(raw: Record<string, unknown>, today: string): string[] {
  const stored = Array.isArray(raw.stamp_reward_dates)
    ? raw.stamp_reward_dates.filter((d): d is string => typeof d === 'string' && d.length >= 10)
    : null;
  const dates = stored ?? [];
  if (stored === null) {
    for (let i = 0; i < toInt(raw.stamp_rewards_pending); i++) dates.push(today);
  }
  return dates.filter((d) => {
    const last = expiryDate(d);
    return last !== null && today <= last;
  });
}

export function readState(metadataJson: string | null | undefined, today: string = businessDate()): StampState {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(metadataJson || '{}');
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const lastDate = raw.stamp_last_date;
  const rewardDates = readRewardDates(raw, today);
  return {
    count: Math.min(toInt(raw.stamp_count), STAMP_GOAL - 1),
    lastDate: typeof lastDate === 'string' && lastDate ? lastDate : null,
    rewardDates,
    rewardsPending: rewardDates.length,
    rewardsTotal: toInt(raw.stamp_rewards_total),
  };
}

/** Merge stamp fields back into metadata, preserving every other key. */
export function writeState(metadataJson: string | null | undefined, state: StampState): string {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(metadataJson || '{}');
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  return JSON.stringify({
    ...raw,
    stamp_count: state.count,
    stamp_last_date: state.lastDate,
    stamp_reward_dates: state.rewardDates,
    // Kept in sync with the dates array so the admin friend view and any
    // metadata segment rules keep reading a plain number.
    stamp_rewards_pending: state.rewardDates.length,
    stamp_rewards_total: state.rewardsTotal,
  });
}

async function persist(db: D1Database, friend: Friend, state: StampState): Promise<void> {
  await db
    .prepare(`UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?`)
    .bind(writeState(friend.metadata, state), jstNow(), friend.id)
    .run();
}

async function resolveFriend(
  c: { req: { header: (name: string) => string | undefined } },
  env: Env['Bindings'],
): Promise<{ status: 'invalid_token' } | { status: 'no_friend' } | { status: 'ok'; friend: Friend }> {
  const lineUserId = await verifyCallerLineUserId(c.req.header('Authorization'), env);
  if (!lineUserId) return { status: 'invalid_token' };
  const friend = await getFriendByLineUserId(env.DB, lineUserId);
  if (!friend) return { status: 'no_friend' };
  return { status: 'ok', friend };
}

/**
 * Tag to attach when a stamp is earned, or null when the feature is unconfigured.
 *
 * Scanning the in-store QR is the one signal that reliably proves a visit, so
 * wiring it to a tag is what lets the post-visit follow-up run without staff
 * remembering to tag by hand. Kept optional (and blank-tolerant) so an unset or
 * empty binding degrades to the previous no-tag behaviour rather than erroring.
 */
export function resolveVisitTagId(env: { STAMP_VISIT_TAG_ID?: string }): string | null {
  const raw = env.STAMP_VISIT_TAG_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** Constant-time-ish compare so the in-store code is not probeable by timing. */
function codeMatches(expected: string | undefined, provided: unknown): boolean {
  if (!expected || typeof provided !== 'string') return false;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

async function clientFor(env: Env['Bindings'], friend: Friend): Promise<LineClient | null> {
  const accounts = await getLineAccounts(env.DB);
  const account = accounts.find((a) => a.id === friend.line_account_id) ?? accounts[0];
  const token =
    (account as unknown as { channel_access_token?: string } | undefined)?.channel_access_token ??
    env.LINE_CHANNEL_ACCESS_TOKEN;
  return token ? new LineClient(token) : null;
}

function rewardFlex(rewardsPending: number, expiresOn: string | null): Record<string, unknown> {
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: 'スタンプが満杯になりました',
          weight: 'bold',
          size: 'xs',
          color: '#C9A227',
        },
        { type: 'text', text: 'バスクチーズケーキ 1つ無料', weight: 'bold', size: 'xl', wrap: true },
        {
          type: 'text',
          text: `5回のご来店、ありがとうございます🌙\n無料券が ${rewardsPending} 枚たまっています。次回のご来店でお使いください。`,
          size: 'sm',
          color: '#666666',
          wrap: true,
        },
        { type: 'separator', margin: 'lg' },
        {
          type: 'text',
          text: 'プレーン・キャラメルからお選びいただけます。スタンプカードの画面をスタッフにお見せください。',
          size: 'sm',
          color: '#666666',
          wrap: true,
          margin: 'lg',
        },
        ...(expiresOn
          ? [
              {
                type: 'text',
                text: `有効期限：${expiresOn} まで`,
                size: 'sm',
                color: '#C9A227',
                weight: 'bold',
                wrap: true,
                margin: 'md',
              },
            ]
          : []),
      ],
    },
  };
}

/** Current card state for the signed-in customer. */
stampRoutes.get('/api/liff/stamps/me', async (c) => {
  const resolved = await resolveFriend(c, c.env);
  if (resolved.status === 'invalid_token') return c.json({ error: 'unauthorized' }, 401);
  if (resolved.status === 'no_friend') return c.json({ error: 'friend_not_found' }, 404);

  const comebackState = await ensureComebackVoucher(
    c.env.DB,
    resolved.friend,
    resolveComebackTagId(c.env),
  );
  // ensureComebackVoucher may have just written metadata; re-read so the card
  // reflects the voucher it issued on this very request.
  const metadata = comebackState.issuedDate
    ? writeComeback(resolved.friend.metadata, comebackState)
    : resolved.friend.metadata;
  const state = readState(metadata);
  const welcome = readWelcome(metadata);
  return c.json({
    count: state.count,
    goal: STAMP_GOAL,
    rewardsPending: state.rewardsPending,
    rewardsTotal: state.rewardsTotal,
    stampedToday: state.lastDate === jstDate(),
    displayName: resolved.friend.display_name,
    // Oldest voucher expires first, and that is the one `redeem` spends.
    rewardExpiresOn: expiryDate(state.rewardDates[0] ?? null),
    welcome: {
      status: welcomeStatus(welcome),
      issuedDate: welcome.issuedDate,
      usedAt: welcome.usedAt,
      expiresOn: expiryDate(welcome.issuedDate),
    },
    comeback: {
      status: comebackStatus(comebackState),
      issuedDate: comebackState.issuedDate,
      usedAt: comebackState.usedAt,
      expiresOn: expiryDate(comebackState.issuedDate),
    },
  });
});

/** Burn the comeback voucher. One per lifetime, same as the welcome one. */
stampRoutes.post('/api/liff/stamps/comeback/redeem', async (c) => {
  const resolved = await resolveFriend(c, c.env);
  if (resolved.status === 'invalid_token') return c.json({ error: 'unauthorized' }, 401);
  if (resolved.status === 'no_friend') return c.json({ error: 'friend_not_found' }, 404);

  const friend = resolved.friend;
  const state = readComeback(friend.metadata);
  const status = comebackStatus(state);
  if (status !== 'usable') return c.json({ error: status }, 409);

  const usedAt = jstNow();
  await c.env.DB.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(writeComeback(friend.metadata, { ...state, usedAt }), usedAt, friend.id)
    .run();

  return c.json({ ok: true, usedAt });
});

/**
 * Burn the friend-add drink voucher. One per lifetime: once `usedAt` is set it
 * is never cleared, so re-adding the account cannot re-arm it.
 */
stampRoutes.post('/api/liff/stamps/welcome/redeem', async (c) => {
  const resolved = await resolveFriend(c, c.env);
  if (resolved.status === 'invalid_token') return c.json({ error: 'unauthorized' }, 401);
  if (resolved.status === 'no_friend') return c.json({ error: 'friend_not_found' }, 404);

  const friend = resolved.friend;
  const welcome = readWelcome(friend.metadata);
  const status = welcomeStatus(welcome);
  if (status !== 'usable') return c.json({ error: status }, 409);

  const usedAt = jstNow();
  await c.env.DB.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(writeWelcome(friend.metadata, { ...welcome, usedAt }), usedAt, friend.id)
    .run();

  return c.json({ ok: true, usedAt, today: businessDate() });
});

/** Earn one stamp. Requires the in-store code and is capped at one per JST day. */
stampRoutes.post('/api/liff/stamps/claim', async (c) => {
  const resolved = await resolveFriend(c, c.env);
  if (resolved.status === 'invalid_token') return c.json({ error: 'unauthorized' }, 401);
  if (resolved.status === 'no_friend') return c.json({ error: 'friend_not_found' }, 404);

  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  if (!codeMatches(c.env.STAMP_QR_CODE, body.code)) {
    return c.json({ error: 'invalid_code' }, 403);
  }

  const friend = resolved.friend;
  const state = readState(friend.metadata);
  const today = jstDate();
  if (state.lastDate === today) {
    return c.json(
      {
        error: 'already_stamped_today',
        count: state.count,
        goal: STAMP_GOAL,
        rewardsPending: state.rewardsPending,
      },
      409,
    );
  }

  const next: StampState = { ...state, count: state.count + 1, lastDate: today };
  let rewarded = false;
  if (next.count >= STAMP_GOAL) {
    next.count = 0;
    next.rewardDates = [...state.rewardDates, businessDate()];
    next.rewardsPending = next.rewardDates.length;
    next.rewardsTotal = state.rewardsTotal + 1;
    rewarded = true;
  }
  await persist(c.env.DB, friend, next);

  // A claim means the customer is standing in the shop, so mark the visit. The
  // helper is idempotent — it only fires side effects (post-visit scenario
  // enrolment, tag_change event) the first time — so repeat visitors re-stamp
  // without re-enrolling. Best-effort for the same reason as the pushes below:
  // the stamp is already committed and must not fail on a tagging error.
  const visitTagId = resolveVisitTagId(c.env);
  if (visitTagId) {
    try {
      await attachTagAndFireSideEffects(c.env.DB, friend.id, visitTagId);
    } catch (err) {
      console.error('stamps: visit tag attach failed', err);
    }
  }

  // Push notifications are best-effort: the stamp is already committed, so a
  // LINE API failure must not surface as a failed claim.
  try {
    const client = await clientFor(c.env, friend);
    if (client) {
      if (rewarded) {
        await client.pushFlexMessage(
          friend.line_user_id,
          'スタンプが満杯になりました',
          rewardFlex(next.rewardsPending, expiryDate(next.rewardDates[0] ?? null)),
        );
      } else if (next.count === NUDGE_AT) {
        await client.pushTextMessage(
          friend.line_user_id,
          `スタンプが${NUDGE_AT}個になりました🌙\n\nあと${STAMP_GOAL - NUDGE_AT}回のご来店で、バスクチーズケーキが1つ無料になります。\n\nいつも足を運んでいただき、ありがとうございます。`,
        );
      }
    }
  } catch {
    // ignore — see comment above
  }

  return c.json({
    ok: true,
    count: next.count,
    goal: STAMP_GOAL,
    rewarded,
    rewardsPending: next.rewardsPending,
  });
});

/** Spend one banked reward. Requires the in-store code so it can only happen on site. */
stampRoutes.post('/api/liff/stamps/redeem', async (c) => {
  const resolved = await resolveFriend(c, c.env);
  if (resolved.status === 'invalid_token') return c.json({ error: 'unauthorized' }, 401);
  if (resolved.status === 'no_friend') return c.json({ error: 'friend_not_found' }, 404);

  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  if (!codeMatches(c.env.STAMP_QR_CODE, body.code)) {
    return c.json({ error: 'invalid_code' }, 403);
  }

  const state = readState(resolved.friend.metadata);
  if (state.rewardsPending <= 0) return c.json({ error: 'no_reward' }, 409);

  // Spend the oldest first — that is the one closest to expiring.
  const rewardDates = state.rewardDates.slice(1);
  const next: StampState = { ...state, rewardDates, rewardsPending: rewardDates.length };
  await persist(c.env.DB, resolved.friend, next);
  return c.json({ ok: true, count: next.count, goal: STAMP_GOAL, rewardsPending: next.rewardsPending });
});

export default stampRoutes;

import { Hono } from 'hono';
import { getFriendByLineUserId, getLineAccounts, jstNow, type Friend } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { verifyCallerLineUserId } from '../services/liff-auth.js';
import type { Env } from '../index.js';

/**
 * Letting a customer cancel their own booking from LINE.
 *
 * Bookings are not rows in a bookings table — they are form submissions that a
 * Google Apps Script turned into calendar events. The calendar is the ledger:
 * the availability check sums the party sizes of `【予約】…様 N名` events, so a
 * booking is only really cancelled once that event is gone. Everything here
 * exists to get the calendar event deleted and to keep the customer's own list
 * in step with it.
 *
 * Auth boundary: mounted under `/api/liff/`, which authMiddleware skips. The
 * caller is identified by their LIFF id_token, verified server-side, and every
 * query is scoped to the friend that resolves from it — a submission id alone
 * is never enough to cancel someone else's table.
 */
const reservations = new Hono<Env>();

export interface ReservationRow {
  id: string;
  /** JST wall-clock start, ISO-ish `YYYY-MM-DDTHH:mm`. */
  startsAt: string;
  visitDate: string;
  visitTime: string;
  people: number;
  customerName: string;
  occasion: string | null;
  notes: string | null;
}

/**
 * The booking form, or null when unconfigured.
 *
 * Kept in an env binding rather than looked up by shape: the survey form also
 * takes free-text answers, and guessing which form is "the booking one" would
 * quietly start cancelling the wrong thing the day a third form is added.
 */
export function resolveBookingFormId(env: { BOOKING_FORM_ID?: string }): string | null {
  const raw = env.BOOKING_FORM_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** Where to send the "a customer just cancelled" heads-up, or null to skip it. */
export function resolveOwnerLineUserId(env: { OWNER_LINE_USER_ID?: string }): string | null {
  const raw = env.OWNER_LINE_USER_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** `2名` / `11名以上` → number. Mirrors parsePeople in the Apps Script. */
export function parsePeople(partySize: unknown, other: unknown): number {
  const fromOther = String(other ?? '').match(/\d+/);
  if (String(partySize ?? '').startsWith('11名以上') && fromOther) {
    return Math.min(parseInt(fromOther[0], 10), 99);
  }
  const m = String(partySize ?? '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 1;
}

/**
 * `2026-08-07` + `21:30` → JST wall-clock minutes since that date's midnight.
 *
 * `24:00以降（金・土のみ）` is the last slot on a late night and means 00:00 the
 * next morning, exactly as the Apps Script reads it. Returning minutes rather
 * than a Date keeps the two in step without re-deriving the timezone twice.
 */
export function parseStartMinutes(visitTime: unknown): number | null {
  const raw = String(visitTime ?? '');
  if (raw.startsWith('24:00')) return 24 * 60;
  const t = raw.match(/(\d{1,2}):(\d{2})/);
  if (!t) return null;
  return parseInt(t[1], 10) * 60 + parseInt(t[2], 10);
}

/** UTC epoch ms for a JST wall-clock date + minute offset. */
export function jstEpochMs(visitDate: unknown, minutes: number): number | null {
  const d = String(visitDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return null;
  const base = Date.UTC(parseInt(d[1], 10), parseInt(d[2], 10) - 1, parseInt(d[3], 10));
  // JST is UTC+9, so a JST wall clock is that many hours earlier in UTC.
  return base + (minutes - 9 * 60) * 60_000;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Display string for the start, carrying 24:00+ through instead of rolling the date. */
function formatStart(visitDate: string, minutes: number): string {
  return `${visitDate}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

interface SubmissionRow {
  id: string;
  friend_id: string | null;
  data: string;
  created_at: string;
}

function parseData(row: SubmissionRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.data || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A submission turned into a reservation, or null when it is not a live booking.
 *
 * Submissions are also written for nights the Apps Script turned away, so a row
 * only counts once we know the webhook accepted it. `_cancelled_at` is written
 * back here on cancel; rows that carry it are done with.
 */
export function toReservation(row: SubmissionRow, nowMs: number): ReservationRow | null {
  const data = parseData(row);
  if (data._cancelled_at) return null;
  const webhook = data._webhookResult as { success?: unknown } | undefined;
  if (webhook && webhook.success === false) return null;

  const minutes = parseStartMinutes(data.visit_time);
  if (minutes === null) return null;
  const startMs = jstEpochMs(data.visit_date, minutes);
  if (startMs === null) return null;
  // Past bookings drop off the list. Cancelling one would delete nothing (the
  // calendar event has already been and gone) while looking like it worked.
  if (startMs <= nowMs) return null;

  return {
    id: row.id,
    startsAt: formatStart(String(data.visit_date), minutes),
    visitDate: String(data.visit_date),
    visitTime: String(data.visit_time),
    people: parsePeople(data.party_size, data.party_size_other),
    customerName: String(data.customer_name ?? 'お名前未記入'),
    occasion: data.occasion ? String(data.occasion) : null,
    notes: data.notes ? String(data.notes) : null,
  };
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

async function clientFor(env: Env['Bindings'], friend: Friend): Promise<LineClient | null> {
  const accounts = await getLineAccounts(env.DB);
  const account = accounts.find((a) => a.id === friend.line_account_id) ?? accounts[0];
  const token =
    (account as unknown as { channel_access_token?: string } | undefined)?.channel_access_token ??
    env.LINE_CHANNEL_ACCESS_TOKEN;
  return token ? new LineClient(token) : null;
}

/** The customer's own upcoming bookings, soonest first. */
reservations.get('/api/liff/reservations/me', async (c) => {
  const formId = resolveBookingFormId(c.env);
  if (!formId) return c.json({ error: 'not_configured' }, 503);

  const resolved = await resolveFriend(c, c.env);
  if (resolved.status === 'invalid_token') return c.json({ error: 'unauthorized' }, 401);
  if (resolved.status === 'no_friend') return c.json({ error: 'friend_not_found' }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT id, friend_id, data, created_at FROM form_submissions
      WHERE form_id = ? AND friend_id = ?
      ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(formId, resolved.friend.id)
    .all<SubmissionRow>();

  const nowMs = Date.now();
  const list = (rows.results ?? [])
    .map((r) => toReservation(r, nowMs))
    .filter((r): r is ReservationRow => r !== null)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return c.json({ reservations: list });
});

/**
 * Cancel one booking.
 *
 * Order matters: the calendar event is deleted first, and only a confirmed
 * delete gets written back as `_cancelled_at`. Marking it cancelled while the
 * event survived would hide a booking that still occupies seats — the customer
 * would think they were done and the table would stay blocked all night.
 */
reservations.post('/api/liff/reservations/:id/cancel', async (c) => {
  const formId = resolveBookingFormId(c.env);
  if (!formId) return c.json({ error: 'not_configured' }, 503);

  const resolved = await resolveFriend(c, c.env);
  if (resolved.status === 'invalid_token') return c.json({ error: 'unauthorized' }, 401);
  if (resolved.status === 'no_friend') return c.json({ error: 'friend_not_found' }, 404);
  const friend = resolved.friend;

  // Scoped to this friend, so a guessed id belonging to someone else is a 404.
  const row = await c.env.DB.prepare(
    `SELECT id, friend_id, data, created_at FROM form_submissions
      WHERE id = ? AND form_id = ? AND friend_id = ?`,
  )
    .bind(c.req.param('id'), formId, friend.id)
    .first<SubmissionRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const reservation = toReservation(row, Date.now());
  if (!reservation) return c.json({ error: 'not_cancellable' }, 409);

  const form = await c.env.DB.prepare(`SELECT on_submit_webhook_url FROM forms WHERE id = ?`)
    .bind(formId)
    .first<{ on_submit_webhook_url: string | null }>();
  if (!form?.on_submit_webhook_url) return c.json({ error: 'not_configured' }, 503);

  const data = parseData(row);
  let webhook: { success?: unknown; reason?: unknown } | null = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(form.on_submit_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        action: 'cancel',
        visit_date: data.visit_date,
        visit_time: data.visit_time,
        party_size: data.party_size,
        party_size_other: data.party_size_other,
        customer_name: data.customer_name,
      }),
    });
    clearTimeout(timeout);
    if (res.ok) webhook = (await res.json()) as { success?: unknown; reason?: unknown };
  } catch (err) {
    console.error('reservations: cancel webhook failed', err);
  }

  if (!webhook || webhook.success !== true) {
    // The calendar still holds the booking. Say so rather than pretending.
    const reason = webhook?.reason === 'not_found' ? 'already_gone' : 'calendar_failed';
    return c.json({ error: reason }, 502);
  }

  const cancelledAt = jstNow();
  await c.env.DB.prepare(`UPDATE form_submissions SET data = ? WHERE id = ?`)
    .bind(JSON.stringify({ ...data, _cancelled_at: cancelledAt }), row.id)
    .run();

  // Notifications are best-effort: the seats are already free, and a LINE
  // failure must not read to the customer as a cancellation that did not take.
  try {
    const client = await clientFor(c.env, friend);
    if (client) {
      const when = `${reservation.visitDate} ${reservation.visitTime}`;
      await client.pushTextMessage(
        friend.line_user_id,
        `ご予約をキャンセルしました。\n\n${when}／${reservation.people}名\n\nまたのご利用をお待ちしています🌙`,
      );
      const owner = resolveOwnerLineUserId(c.env);
      if (owner && owner !== friend.line_user_id) {
        await client.pushTextMessage(
          owner,
          `【キャンセル】\n${when}／${reservation.customerName} 様 ${reservation.people}名\n\nカレンダーの予定は削除済みです。`,
        );
      }
    }
  } catch (err) {
    console.error('reservations: cancel notification failed', err);
  }

  return c.json({ ok: true, cancelledAt });
});

export default reservations;
export { reservations };

import { jstNow, type Friend } from '@line-crm/db';

/**
 * Friend-add perk: a same-day drink voucher plus the first stamp.
 *
 * Both live in `friends.metadata` next to the stamp card fields, so no schema
 * change is needed and the stamp screen can render everything from one fetch.
 *
 * The voucher is deliberately one-per-lifetime: `welcome_used_at` is only ever
 * written, never cleared, so a customer cannot re-arm it by re-adding the
 * account after blocking it.
 */

/** Hour (JST) at which a business day rolls over. */
const DAY_ROLLOVER_HOUR = 5;

/**
 * Days the voucher stays usable, counted from (and including) the day it was
 * issued. Someone who joins at the counter can use it that same night; someone
 * who joins from Instagram has a month to come in. The 25-day reminder in the
 * welcome scenario lands five days before this runs out.
 */
export const VALID_DAYS = 30;

export interface WelcomeState {
  /** Business date the voucher was issued for, or null when never issued. */
  issuedDate: string | null;
  /** JST timestamp the voucher was burned, or null while still usable. */
  usedAt: string | null;
  /** Whether the friend-add stamp has already been credited. */
  stampGiven: boolean;
}

/**
 * Business date (YYYY-MM-DD) for a JST timestamp.
 *
 * The shop trades past midnight (to 24:00, or 25:00 on Fri/Sat), so a
 * calendar-date rule would expire a voucher issued at 23:50 while the customer
 * is still sitting at the counter. Treat everything before 05:00 as belonging
 * to the previous day instead.
 */
export function businessDate(now: string = jstNow()): string {
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return now.slice(0, 10);
  d.setHours(d.getHours() - DAY_ROLLOVER_HOUR);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readWelcome(metadataJson: string | null | undefined): WelcomeState {
  const raw = parseMetadata(metadataJson);
  const issued = raw.welcome_issued_date;
  const used = raw.welcome_used_at;
  return {
    issuedDate: typeof issued === 'string' && issued ? issued : null,
    usedAt: typeof used === 'string' && used ? used : null,
    stampGiven: raw.welcome_stamp_given === true,
  };
}

export function writeWelcome(metadataJson: string | null | undefined, state: WelcomeState): string {
  return JSON.stringify({
    ...parseMetadata(metadataJson),
    welcome_issued_date: state.issuedDate,
    welcome_used_at: state.usedAt,
    welcome_stamp_given: state.stampGiven,
  });
}

export type WelcomeStatus = 'none' | 'usable' | 'used' | 'expired';

/** Last business date the voucher can be used, or null when never issued. */
export function expiryDate(issuedDate: string | null): string | null {
  if (!issuedDate) return null;
  const d = new Date(`${issuedDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + VALID_DAYS - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Status to actually render, as opposed to the true state.
 *
 * A used voucher stays on screen for the rest of that business day so staff can
 * confirm at the counter that it really was redeemed, and so the customer is not
 * left wondering whether it ever existed. After that it disappears: the stamp
 * card is the point of the screen, and spent vouchers would otherwise pile up
 * underneath it forever.
 *
 * Expired vouchers are hidden outright — there is nothing to be done with one,
 * so showing it only leaves a bad taste.
 */
export function displayStatus(
  status: WelcomeStatus,
  usedAt: string | null,
  today: string = businessDate(),
): WelcomeStatus {
  if (status === 'expired') return 'none';
  if (status === 'used') return usedAt && businessDate(usedAt) === today ? 'used' : 'none';
  return status;
}

/** What the customer should see for the voucher right now. */
export function welcomeStatus(state: WelcomeState, today: string = businessDate()): WelcomeStatus {
  if (!state.issuedDate) return 'none';
  if (state.usedAt) return 'used';
  const last = expiryDate(state.issuedDate);
  if (!last) return 'expired';
  return today <= last ? 'usable' : 'expired';
}

/**
 * Grant the friend-add perk. Idempotent: a re-follow neither re-issues the
 * voucher nor hands out a second stamp.
 *
 * Note the stamp is credited *without* touching `stamp_last_date`. That field
 * guards the one-per-day rule for the in-store QR; leaving it alone means a
 * customer who adds the account at the table can still scan the poster the
 * same night and end the evening with two stamps, which is the intent — the
 * welcome stamp is a gift, not a visit record.
 */
export async function grantWelcomePerk(
  db: D1Database,
  friend: Pick<Friend, 'id' | 'metadata'>,
): Promise<{ issued: boolean; stamped: boolean }> {
  const state = readWelcome(friend.metadata);
  const issued = state.issuedDate === null && state.usedAt === null;
  const stamped = !state.stampGiven;
  if (!issued && !stamped) return { issued: false, stamped: false };

  const raw = parseMetadata(friend.metadata);
  const next: Record<string, unknown> = { ...raw };

  if (issued) {
    next.welcome_issued_date = businessDate();
    // Write the null explicitly. The welcome scenario's 25-day reminder is
    // gated on `metadata_equals {welcome_used_at: null}`, and that check is a
    // strict comparison — an absent key reads as undefined and would never
    // match, silently skipping the reminder for everyone.
    next.welcome_used_at = null;
  }
  if (stamped) {
    const current = Number(raw.stamp_count);
    next.stamp_count = (Number.isFinite(current) && current > 0 ? Math.floor(current) : 0) + 1;
    next.welcome_stamp_given = true;
  }

  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(next), jstNow(), friend.id)
    .run();

  return { issued, stamped };
}

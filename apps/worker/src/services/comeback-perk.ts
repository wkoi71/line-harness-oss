import { jstNow } from '@line-crm/db';
import { businessDate, expiryDate } from './welcome-perk.js';

/**
 * Comeback voucher for lapsed customers.
 *
 * Issued lazily — the first time someone carrying the "at risk" tag opens their
 * stamp card — rather than at tagging time. The tag arrives by two different
 * routes (the post-visit scenario's final step, and staff tagging by hand), and
 * hooking both would mean two places to keep in step. Opening the card is the
 * single point every recipient passes through, and the 30-day clock starting
 * then is also fairer: it runs from when they actually saw the offer.
 *
 * Same one-per-lifetime rule as the welcome voucher: `comeback_used_at` is only
 * ever written, never cleared.
 */
export interface ComebackState {
  issuedDate: string | null;
  usedAt: string | null;
}

export type ComebackStatus = 'none' | 'usable' | 'used' | 'expired';

function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readComeback(metadataJson: string | null | undefined): ComebackState {
  const raw = parseMetadata(metadataJson);
  const issued = raw.comeback_issued_date;
  const used = raw.comeback_used_at;
  return {
    issuedDate: typeof issued === 'string' && issued ? issued : null,
    usedAt: typeof used === 'string' && used ? used : null,
  };
}

export function writeComeback(metadataJson: string | null | undefined, state: ComebackState): string {
  return JSON.stringify({
    ...parseMetadata(metadataJson),
    comeback_issued_date: state.issuedDate,
    comeback_used_at: state.usedAt,
  });
}

export function comebackStatus(state: ComebackState, today: string = businessDate()): ComebackStatus {
  if (!state.issuedDate) return 'none';
  if (state.usedAt) return 'used';
  const last = expiryDate(state.issuedDate);
  if (!last) return 'expired';
  return today <= last ? 'usable' : 'expired';
}

/** Tag that makes someone eligible, or null when the feature is unconfigured. */
export function resolveComebackTagId(env: { COMEBACK_TAG_ID?: string }): string | null {
  const raw = env.COMEBACK_TAG_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * Issue the voucher if the friend carries the eligibility tag and has never had
 * one. Returns the (possibly unchanged) state so the caller can render without
 * a second read.
 */
export async function ensureComebackVoucher(
  db: D1Database,
  friend: { id: string; metadata: string | null },
  tagId: string | null,
): Promise<ComebackState> {
  const state = readComeback(friend.metadata);
  if (!tagId || state.issuedDate || state.usedAt) return state;

  const tagged = await db
    .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
    .bind(friend.id, tagId)
    .first();
  if (!tagged) return state;

  const next: ComebackState = { issuedDate: businessDate(), usedAt: null };
  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(writeComeback(friend.metadata, next), jstNow(), friend.id)
    .run();
  return next;
}

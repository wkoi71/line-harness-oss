import { describe, it, expect } from 'vitest';
import { businessDate, readWelcome, writeWelcome, welcomeStatus } from './welcome-perk.js';

describe('welcome-perk: businessDate', () => {
  it('keeps late-night trading on the same business day', () => {
    // The shop runs to 24:00 (25:00 Fri/Sat). A voucher issued at 23:50 must
    // still be usable at 00:30 while the customer is sitting there.
    expect(businessDate('2026-07-26T23:50:00+09:00')).toBe('2026-07-26');
    expect(businessDate('2026-07-27T00:30:00+09:00')).toBe('2026-07-26');
    expect(businessDate('2026-07-27T04:59:00+09:00')).toBe('2026-07-26');
  });

  it('rolls over at 05:00', () => {
    expect(businessDate('2026-07-27T05:00:00+09:00')).toBe('2026-07-27');
    expect(businessDate('2026-07-27T20:00:00+09:00')).toBe('2026-07-27');
  });

  it('falls back to the plain date when the timestamp is unparseable', () => {
    expect(businessDate('not a date')).toBe('not a date');
  });
});

describe('welcome-perk: readWelcome', () => {
  it('treats missing or malformed metadata as never issued', () => {
    for (const input of [null, undefined, '', '{}', 'broken{']) {
      expect(readWelcome(input)).toEqual({ issuedDate: null, usedAt: null, stampGiven: false });
    }
  });

  it('reads the stored fields', () => {
    const json = JSON.stringify({
      welcome_issued_date: '2026-07-26',
      welcome_used_at: '2026-07-26T22:10:00+09:00',
      welcome_stamp_given: true,
    });
    expect(readWelcome(json)).toEqual({
      issuedDate: '2026-07-26',
      usedAt: '2026-07-26T22:10:00+09:00',
      stampGiven: true,
    });
  });
});

describe('welcome-perk: writeWelcome', () => {
  it('preserves the stamp card fields living in the same metadata blob', () => {
    const before = JSON.stringify({ stamp_count: 3, stamp_last_date: '2026-07-25' });
    const after = JSON.parse(
      writeWelcome(before, { issuedDate: '2026-07-26', usedAt: null, stampGiven: true }),
    );
    expect(after.stamp_count).toBe(3);
    expect(after.stamp_last_date).toBe('2026-07-25');
    expect(after.welcome_issued_date).toBe('2026-07-26');
  });
});

describe('welcome-perk: welcomeStatus', () => {
  const issued = { issuedDate: '2026-07-26', usedAt: null, stampGiven: true };

  it('is usable only on the issuing business day', () => {
    expect(welcomeStatus(issued, '2026-07-26')).toBe('usable');
    expect(welcomeStatus(issued, '2026-07-27')).toBe('expired');
  });

  it('stays used forever, even on the day it was issued', () => {
    // The whole point of the one-per-lifetime rule: burning it must not be
    // undone by re-adding the account or by the clock.
    const used = { ...issued, usedAt: '2026-07-26T22:10:00+09:00' };
    expect(welcomeStatus(used, '2026-07-26')).toBe('used');
    expect(welcomeStatus(used, '2027-01-01')).toBe('used');
  });

  it('reports none when nothing was ever issued', () => {
    expect(welcomeStatus({ issuedDate: null, usedAt: null, stampGiven: false }, '2026-07-26')).toBe('none');
  });
});

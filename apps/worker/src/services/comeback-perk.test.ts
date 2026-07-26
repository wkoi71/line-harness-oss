import { describe, it, expect } from 'vitest';
import { comebackStatus, readComeback, resolveComebackTagId, writeComeback } from './comeback-perk.js';

describe('comeback-perk: readComeback', () => {
  it('treats missing or malformed metadata as never issued', () => {
    for (const input of [null, undefined, '', '{}', 'broken{']) {
      expect(readComeback(input)).toEqual({ issuedDate: null, usedAt: null });
    }
  });
});

describe('comeback-perk: writeComeback', () => {
  it('leaves the stamp and welcome fields in the same blob alone', () => {
    const before = JSON.stringify({ stamp_count: 2, welcome_used_at: '2026-07-01T21:00:00+09:00' });
    const after = JSON.parse(writeComeback(before, { issuedDate: '2026-07-26', usedAt: null }));
    expect(after.stamp_count).toBe(2);
    expect(after.welcome_used_at).toBe('2026-07-01T21:00:00+09:00');
    expect(after.comeback_issued_date).toBe('2026-07-26');
  });
});

describe('comeback-perk: comebackStatus', () => {
  const issued = { issuedDate: '2026-07-26', usedAt: null };

  it('is usable from the issue day through the 30th day', () => {
    expect(comebackStatus(issued, '2026-07-26')).toBe('usable');
    expect(comebackStatus(issued, '2026-08-24')).toBe('usable');
    expect(comebackStatus(issued, '2026-08-25')).toBe('expired');
  });

  it('stays used forever once burned', () => {
    const used = { ...issued, usedAt: '2026-07-26T22:00:00+09:00' };
    expect(comebackStatus(used, '2026-07-26')).toBe('used');
    expect(comebackStatus(used, '2027-01-01')).toBe('used');
  });

  it('is none when never issued', () => {
    expect(comebackStatus({ issuedDate: null, usedAt: null }, '2026-07-26')).toBe('none');
  });
});

describe('comeback-perk: resolveComebackTagId', () => {
  it('treats unset, blank and whitespace-only config as disabled', () => {
    expect(resolveComebackTagId({})).toBeNull();
    expect(resolveComebackTagId({ COMEBACK_TAG_ID: '' })).toBeNull();
    expect(resolveComebackTagId({ COMEBACK_TAG_ID: '  ' })).toBeNull();
  });

  it('trims a pasted value', () => {
    expect(resolveComebackTagId({ COMEBACK_TAG_ID: ' tag-1\n' })).toBe('tag-1');
  });
});

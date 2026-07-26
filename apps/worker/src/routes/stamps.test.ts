import { describe, it, expect } from 'vitest';
import { readState, writeState, jstDate, resolveVisitTagId, STAMP_GOAL } from './stamps.js';

describe('stamps: readState', () => {
  it('treats missing/empty metadata as an empty card', () => {
    for (const input of [null, undefined, '', '{}']) {
      expect(readState(input)).toEqual({
        count: 0,
        lastDate: null,
        rewardDates: [],
        rewardsPending: 0,
        rewardsTotal: 0,
      });
    }
  });

  it('falls back to an empty card on malformed JSON instead of throwing', () => {
    expect(readState('not json{')).toEqual({
      count: 0,
      lastDate: null,
      rewardDates: [],
      rewardsPending: 0,
      rewardsTotal: 0,
    });
  });

  it('reads stamp fields', () => {
    const json = JSON.stringify({
      stamp_count: 3,
      stamp_last_date: '2026-07-25',
      stamp_reward_dates: ['2026-07-20'],
      stamp_rewards_pending: 1,
      stamp_rewards_total: 4,
    });
    expect(readState(json, '2026-07-25')).toEqual({
      count: 3,
      lastDate: '2026-07-25',
      rewardDates: ['2026-07-20'],
      rewardsPending: 1,
      rewardsTotal: 4,
    });
  });

  it('clamps a corrupted count below the goal so a card can never sit full', () => {
    const json = JSON.stringify({ stamp_count: 99 });
    expect(readState(json).count).toBe(STAMP_GOAL - 1);
  });

  it('coerces negative and non-numeric counters to zero', () => {
    const json = JSON.stringify({
      stamp_count: -5,
      stamp_rewards_pending: 'abc',
      stamp_rewards_total: null,
    });
    expect(readState(json)).toMatchObject({ count: 0, rewardsPending: 0, rewardsTotal: 0 });
  });
});

describe('stamps: writeState', () => {
  it('preserves unrelated metadata keys written by other features', () => {
    const before = JSON.stringify({ visit_date: '2026-08-01', customer_name: '山田' });
    const after = JSON.parse(
      writeState(before, { count: 2, lastDate: '2026-07-25', rewardDates: [], rewardsPending: 0, rewardsTotal: 0 }),
    );
    expect(after.visit_date).toBe('2026-08-01');
    expect(after.customer_name).toBe('山田');
    expect(after.stamp_count).toBe(2);
  });

  it('round-trips through readState', () => {
    const state = {
      count: 4,
      lastDate: '2026-07-25',
      rewardDates: ['2026-07-24', '2026-07-25'],
      rewardsPending: 2,
      rewardsTotal: 7,
    };
    expect(readState(writeState('{}', state), '2026-07-25')).toEqual(state);
  });

  it('does not throw when the existing metadata is malformed', () => {
    const after = JSON.parse(
      writeState('broken{', { count: 1, lastDate: null, rewardDates: [], rewardsPending: 0, rewardsTotal: 0 }),
    );
    expect(after.stamp_count).toBe(1);
  });
});

describe('stamps: jstDate', () => {
  it('extracts the calendar date used for the one-per-day rule', () => {
    expect(jstDate('2026-07-25T23:59:59+09:00')).toBe('2026-07-25');
    expect(jstDate('2026-07-26T00:00:01+09:00')).toBe('2026-07-26');
  });
});

describe('stamps: 無料券の30日期限', () => {
  const issued = (dates: string[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ stamp_reward_dates: dates, stamp_rewards_total: dates.length, ...extra });

  it('期限内の券だけを数える', () => {
    const s = readState(issued(['2026-07-01', '2026-07-20']), '2026-07-26');
    expect(s.rewardsPending).toBe(2);
    expect(s.rewardDates).toEqual(['2026-07-01', '2026-07-20']);
  });

  it('30日を過ぎた券は落とす（発行日から30日目までが有効）', () => {
    expect(readState(issued(['2026-07-01']), '2026-07-30').rewardsPending).toBe(1);
    expect(readState(issued(['2026-07-01']), '2026-07-31').rewardsPending).toBe(0);
  });

  it('期限切れだけを落として、生きている券は残す', () => {
    const s = readState(issued(['2026-06-01', '2026-07-20']), '2026-07-26');
    expect(s.rewardDates).toEqual(['2026-07-20']);
    expect(s.rewardsPending).toBe(1);
  });

  it('発行日を持たない古い券は没収せず、当日発行として扱う', () => {
    // 日付を持つ前に獲得した券。ここで消すと、貯めてくれた人から
    // デプロイした瞬間に取り上げることになる。
    const legacy = JSON.stringify({ stamp_rewards_pending: 2, stamp_rewards_total: 2 });
    const s = readState(legacy, '2026-07-26');
    expect(s.rewardsPending).toBe(2);
    expect(s.rewardDates).toEqual(['2026-07-26', '2026-07-26']);
  });

  it('writeState は日付と枚数を同期させる', () => {
    const after = JSON.parse(
      writeState('{}', {
        count: 0,
        lastDate: null,
        rewardDates: ['2026-07-20'],
        rewardsPending: 99, // ずれていても日付の数が正
        rewardsTotal: 3,
      }),
    );
    expect(after.stamp_reward_dates).toEqual(['2026-07-20']);
    expect(after.stamp_rewards_pending).toBe(1);
  });
});

describe('stamps: resolveVisitTagId', () => {
  it('returns the configured tag id', () => {
    expect(resolveVisitTagId({ STAMP_VISIT_TAG_ID: 'tag-123' })).toBe('tag-123');
  });

  it('treats unset, blank and whitespace-only config as disabled', () => {
    // A blank binding must not reach the tag helper — an empty tag_id would
    // insert a dangling friend_tags row rather than fail loudly.
    expect(resolveVisitTagId({})).toBeNull();
    expect(resolveVisitTagId({ STAMP_VISIT_TAG_ID: '' })).toBeNull();
    expect(resolveVisitTagId({ STAMP_VISIT_TAG_ID: '   ' })).toBeNull();
  });

  it('trims surrounding whitespace from a pasted value', () => {
    expect(resolveVisitTagId({ STAMP_VISIT_TAG_ID: '  tag-123\n' })).toBe('tag-123');
  });

  it('ignores a non-string binding', () => {
    expect(resolveVisitTagId({ STAMP_VISIT_TAG_ID: 123 as unknown as string })).toBeNull();
  });
});

describe('stamps: reward cycle', () => {
  // Mirrors the claim handler's transition so the reset/bank rule is pinned by
  // a test even though the handler itself needs a live D1 binding.
  function advance(state: ReturnType<typeof readState>, today: string) {
    if (state.lastDate === today) return { state, rewarded: false, blocked: true };
    const next = { ...state, count: state.count + 1, lastDate: today };
    let rewarded = false;
    if (next.count >= STAMP_GOAL) {
      next.count = 0;
      next.rewardsPending += 1;
      next.rewardsTotal += 1;
      rewarded = true;
    }
    return { state: next, rewarded, blocked: false };
  }

  it('banks a reward and resets the card on the 5th stamp', () => {
    let state = readState('{}');
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
    let rewardedOn = -1;
    days.forEach((d, i) => {
      const r = advance(state, d);
      state = r.state;
      if (r.rewarded) rewardedOn = i;
    });
    expect(rewardedOn).toBe(4);
    expect(state.count).toBe(0);
    expect(state.rewardsPending).toBe(1);
    expect(state.rewardsTotal).toBe(1);
  });

  it('rewards again on the second cycle — the tag-scenario design could not', () => {
    let state = readState('{}');
    for (let i = 1; i <= 10; i++) {
      state = advance(state, `2026-07-${String(i).padStart(2, '0')}`).state;
    }
    expect(state.rewardsTotal).toBe(2);
    expect(state.rewardsPending).toBe(2);
    expect(state.count).toBe(0);
  });

  it('blocks a second stamp on the same JST day', () => {
    let state = readState('{}');
    state = advance(state, '2026-07-25').state;
    const again = advance(state, '2026-07-25');
    expect(again.blocked).toBe(true);
    expect(again.state.count).toBe(1);
  });
});

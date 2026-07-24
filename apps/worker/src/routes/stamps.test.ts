import { describe, it, expect } from 'vitest';
import { readState, writeState, jstDate, STAMP_GOAL } from './stamps.js';

describe('stamps: readState', () => {
  it('treats missing/empty metadata as an empty card', () => {
    for (const input of [null, undefined, '', '{}']) {
      expect(readState(input)).toEqual({
        count: 0,
        lastDate: null,
        rewardsPending: 0,
        rewardsTotal: 0,
      });
    }
  });

  it('falls back to an empty card on malformed JSON instead of throwing', () => {
    expect(readState('not json{')).toEqual({
      count: 0,
      lastDate: null,
      rewardsPending: 0,
      rewardsTotal: 0,
    });
  });

  it('reads stamp fields', () => {
    const json = JSON.stringify({
      stamp_count: 3,
      stamp_last_date: '2026-07-25',
      stamp_rewards_pending: 1,
      stamp_rewards_total: 4,
    });
    expect(readState(json)).toEqual({
      count: 3,
      lastDate: '2026-07-25',
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
      writeState(before, { count: 2, lastDate: '2026-07-25', rewardsPending: 0, rewardsTotal: 0 }),
    );
    expect(after.visit_date).toBe('2026-08-01');
    expect(after.customer_name).toBe('山田');
    expect(after.stamp_count).toBe(2);
  });

  it('round-trips through readState', () => {
    const state = { count: 4, lastDate: '2026-07-25', rewardsPending: 2, rewardsTotal: 7 };
    expect(readState(writeState('{}', state))).toEqual(state);
  });

  it('does not throw when the existing metadata is malformed', () => {
    const after = JSON.parse(
      writeState('broken{', { count: 1, lastDate: null, rewardsPending: 0, rewardsTotal: 0 }),
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

import { describe, it, expect, vi } from 'vitest';
import { isTransientD1Error, withD1Retry } from '../src/retry.js';

const noSleep = async () => {};

describe('isTransientD1Error', () => {
  it('matches the connection drop D1 actually returns', () => {
    expect(isTransientD1Error(new Error('D1_ERROR: Network connection lost.'))).toBe(true);
  });

  it('matches storage timeouts and internal errors', () => {
    expect(
      isTransientD1Error(new Error('D1_ERROR: Storage operation exceeded timeout')),
    ).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: Internal error'))).toBe(true);
  });

  it('does not match real failures', () => {
    expect(isTransientD1Error(new Error('D1_ERROR: no such table: friends'))).toBe(false);
    expect(isTransientD1Error(new Error('UNIQUE constraint failed'))).toBe(false);
  });

  it('accepts non-Error throwables', () => {
    expect(isTransientD1Error('D1_ERROR: Network connection lost.')).toBe(true);
    expect(isTransientD1Error(null)).toBe(false);
  });
});

describe('withD1Retry', () => {
  it('returns the value without retrying when the call succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withD1Retry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error and returns the later success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('D1_ERROR: Network connection lost.'))
      .mockResolvedValue('ok');
    await expect(withD1Retry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured attempts and rethrows', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('D1_ERROR: Network connection lost.'));
    await expect(withD1Retry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow(
      'Network connection lost',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-transient error immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('D1_ERROR: no such table: friends'));
    await expect(withD1Retry(fn, { sleep: noSleep })).rejects.toThrow('no such table');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially between attempts', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error('D1_ERROR: Network connection lost.'));
    await expect(
      withD1Retry(fn, {
        attempts: 3,
        baseDelayMs: 50,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([50, 100]);
  });
});

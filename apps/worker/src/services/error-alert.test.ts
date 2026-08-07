import { describe, expect, test, vi, beforeEach } from 'vitest';

/**
 * 壊れたことが届くこと、そして届きすぎないこと。
 *
 * LINEのプッシュは課金対象で、毎分の cron から鳴りうる。上限が効かないと
 * 故障そのものより通知のほうが高くつくので、抑制の検証を厚くしてある。
 */

const pushTextMessage = vi.fn(async (_to: string, _text: string): Promise<void> => undefined);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushTextMessage = pushTextMessage;
  },
}));

/** account_settings をメモリで代用する。キーごとの値を素直に持つだけ。 */
const store = new Map<string, string>();
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLineAccounts: vi.fn(async () => [{ id: 'acc1', channel_access_token: 'tok' }]),
  getAccountSetting: vi.fn(async (_db: unknown, _acc: string, key: string) => store.get(key) ?? null),
  setAccountSetting: vi.fn(async (_db: unknown, _acc: string, key: string, value: string) => {
    store.set(key, value);
  }),
}));

const { alertOwner, alertText, summarize } = await import('./error-alert.js');

const ENV = { DB: {} as D1Database, OWNER_LINE_USER_ID: 'U_owner' };
const T0 = Date.parse('2026-08-07T12:00:00Z');

beforeEach(() => {
  store.clear();
  pushTextMessage.mockClear();
  pushTextMessage.mockResolvedValue(undefined);
});

describe('本文の整形', () => {
  test('Error は name と message だけにする', () => {
    expect(summarize(new Error('boom'))).toBe('Error: boom');
  });

  test('スタックは1行目だけ載せる', () => {
    const e = new Error('boom');
    e.message = 'boom\n    at foo (/x.js:1:1)\n    at bar';
    expect(summarize(e)).toBe('Error: boom');
  });

  test('長すぎる本文は切る', () => {
    expect(summarize('x'.repeat(500)).length).toBeLessThanOrEqual(301);
  });

  test('抑制した件数を文面に載せる', () => {
    const text = alertText('cron_error', 'Error: boom', 3, new Date(T0 + 9 * 3600_000));
    expect(text).toContain('定期処理でエラー');
    expect(text).toContain('他3件');
  });

  test('抑制ゼロなら余計な行を出さない', () => {
    expect(alertText('route_error', 'x', 0, new Date(T0))).not.toContain('他');
  });
});

describe('送信と抑制', () => {
  test('初回は届く', async () => {
    expect(await alertOwner(ENV, 'cron_error', new Error('boom'), T0)).toBe(true);
    expect(pushTextMessage).toHaveBeenCalledTimes(1);
  });

  test('30分以内の同じ種類は抑える', async () => {
    await alertOwner(ENV, 'cron_error', new Error('a'), T0);
    expect(await alertOwner(ENV, 'cron_error', new Error('b'), T0 + 60_000)).toBe(false);
    expect(await alertOwner(ENV, 'cron_error', new Error('c'), T0 + 29 * 60_000)).toBe(false);
    expect(pushTextMessage).toHaveBeenCalledTimes(1);
  });

  test('30分たてばまた届き、抑えた件数が載る', async () => {
    await alertOwner(ENV, 'cron_error', new Error('a'), T0);
    await alertOwner(ENV, 'cron_error', new Error('b'), T0 + 60_000);
    await alertOwner(ENV, 'cron_error', new Error('c'), T0 + 120_000);

    expect(await alertOwner(ENV, 'cron_error', new Error('d'), T0 + 31 * 60_000)).toBe(true);
    expect(String(pushTextMessage.mock.calls[1][1])).toContain('他2件');
  });

  test('種類が違えば別々に届く', async () => {
    expect(await alertOwner(ENV, 'cron_error', 'a', T0)).toBe(true);
    expect(await alertOwner(ENV, 'route_error', 'b', T0)).toBe(true);
    expect(await alertOwner(ENV, 'booking_webhook_error', 'c', T0)).toBe(true);
    expect(pushTextMessage).toHaveBeenCalledTimes(3);
  });

  test('1時間に6通を超えたら止まる（毎分のcronで焼かれない）', async () => {
    const kinds = ['cron_error', 'route_error', 'booking_webhook_error', 'line_push_error'] as const;
    let sent = 0;
    // 種類ごとのクールダウンをまたぎつつ、1時間ずっと鳴らし続ける
    for (let m = 0; m < 60; m++) {
      for (const k of kinds) {
        if (await alertOwner(ENV, k, 'boom', T0 + m * 60_000)) sent++;
      }
    }
    expect(sent).toBe(6);
    expect(pushTextMessage).toHaveBeenCalledTimes(6);
  });

  test('上限に達した後、1時間の窓が明ければまた送れる', async () => {
    const kinds = ['cron_error', 'route_error', 'booking_webhook_error', 'line_push_error'] as const;
    for (const k of kinds) await alertOwner(ENV, k, 'x', T0); // 4通
    for (const k of kinds) await alertOwner(ENV, k, 'x', T0 + 31 * 60_000); // 上限6で打ち止め
    expect(pushTextMessage).toHaveBeenCalledTimes(6);

    // booking_webhook_error は T0 以来送れていない。クールダウンは明けているので、
    // ここで止まっているのは時間あたりの上限のほう。
    expect(await alertOwner(ENV, 'booking_webhook_error', 'x', T0 + 59 * 60_000)).toBe(false);
    // 窓が明ければ再開する
    expect(await alertOwner(ENV, 'booking_webhook_error', 'x', T0 + 61 * 60_000)).toBe(true);
  });

  test('宛先未設定なら何もしない', async () => {
    expect(await alertOwner({ DB: {} as D1Database }, 'cron_error', 'x', T0)).toBe(false);
    expect(pushTextMessage).not.toHaveBeenCalled();
  });

  test('送信に失敗しても例外を投げず、次回また試せる', async () => {
    pushTextMessage.mockRejectedValueOnce(new Error('line down'));
    expect(await alertOwner(ENV, 'cron_error', 'x', T0)).toBe(false);
    // 失敗を「送信済み」として記録しないので、次の機会に再挑戦できる
    expect(await alertOwner(ENV, 'cron_error', 'x', T0 + 1000)).toBe(true);
  });
});

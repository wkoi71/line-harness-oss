import { describe, expect, test, vi, beforeEach } from 'vitest';

/**
 * 予約が入った・取り消されたことがお店に届くこと。
 *
 * 台帳がGoogleカレンダーなので、通知が来なければ店側はカレンダーを開くまで
 * 気づけない。とくにキャンセルは予定が黙って消えるだけなので見落としやすい。
 */

const pushTextMessage = vi.fn(async (_to: string, _text: string): Promise<void> => undefined);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushTextMessage = pushTextMessage;
  },
}));

const getLineAccounts = vi.fn(async () => [{ id: 'acc1', channel_access_token: 'tok' }]);
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLineAccounts,
}));

const { bookingText, cancelText, notifyOwner, resolveOwnerLineUserId } = await import(
  './owner-notify.js'
);

const ENV = { DB: {} as D1Database, OWNER_LINE_USER_ID: 'U_owner' };

beforeEach(() => {
  pushTextMessage.mockClear();
  pushTextMessage.mockResolvedValue(undefined);
  getLineAccounts.mockResolvedValue([{ id: 'acc1', channel_access_token: 'tok' }]);
});

describe('宛先の解決', () => {
  test('未設定・空文字は宛先なし', () => {
    expect(resolveOwnerLineUserId({})).toBeNull();
    expect(resolveOwnerLineUserId({ OWNER_LINE_USER_ID: '   ' })).toBeNull();
    expect(resolveOwnerLineUserId({ OWNER_LINE_USER_ID: ' U1 ' })).toBe('U1');
  });
});

describe('文面', () => {
  test('新規予約は日時・人数・お名前・電話・要望を載せる', () => {
    const text = bookingText({
      visitDate: '2026-08-07',
      visitTime: '21:00',
      people: 4,
      customerName: '山田 太郎',
      phone: '090-1234-5678',
      occasion: '記念日・お祝い',
      notes: '甲殻類アレルギーあり',
    });
    expect(text).toContain('【新しいご予約】');
    expect(text).toContain('2026-08-07 21:00');
    expect(text).toContain('山田 太郎 様 4名');
    expect(text).toContain('090-1234-5678');
    expect(text).toContain('甲殻類アレルギーあり');
  });

  test('空欄の項目は行ごと出さない', () => {
    const text = bookingText({
      visitDate: '2026-08-07',
      visitTime: '21:00',
      people: 2,
      customerName: '西 美津穂',
      phone: '',
      occasion: null,
      notes: '   ',
    });
    expect(text).not.toContain('お電話');
    expect(text).not.toContain('ご利用シーン');
    expect(text).not.toContain('ご要望');
  });

  test('キャンセルは削除済みだと分かる', () => {
    const text = cancelText({
      visitDate: '2026-08-07',
      visitTime: '21:00',
      people: 4,
      customerName: '山田 太郎',
    });
    expect(text).toContain('【キャンセル】');
    expect(text).toContain('削除済み');
  });
});

describe('送信', () => {
  test('宛先へ1通押す', async () => {
    expect(await notifyOwner(ENV, 'test')).toBe(true);
    expect(pushTextMessage).toHaveBeenCalledWith('U_owner', 'test');
  });

  test('宛先未設定なら何もしない', async () => {
    expect(await notifyOwner({ DB: {} as D1Database }, 'test')).toBe(false);
    expect(pushTextMessage).not.toHaveBeenCalled();
  });

  test('オーナー本人の予約でも送る（自分でテストして確かめられるように）', async () => {
    // 宛先と予約者が同一でも抑止しない。黙ると設定漏れと区別がつかない。
    expect(await notifyOwner(ENV, '【新しいご予約】')).toBe(true);
    expect(pushTextMessage).toHaveBeenCalledTimes(1);
  });

  test('送信に失敗しても例外を投げない', async () => {
    pushTextMessage.mockRejectedValueOnce(new Error('line down'));
    expect(await notifyOwner(ENV, 'test')).toBe(false);
  });

  test('トークンが取れなければ送らない', async () => {
    getLineAccounts.mockResolvedValue([]);
    expect(await notifyOwner(ENV, 'test')).toBe(false);
    expect(pushTextMessage).not.toHaveBeenCalled();
  });
});

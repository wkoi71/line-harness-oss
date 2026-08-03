import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

/**
 * お客様が自分の予約をLINEからキャンセルできること、そして
 * 「消えていないのに消えたことにしない」こと。
 *
 * 席が空くのはカレンダーの予定が消えたときだけなので、Apps Script が成功を
 * 返さなかった場合に取消済みとして記録してしまうと、席が埋まったまま一覧から
 * 消えるという最悪の壊れ方をする。そこを重点的に固める。
 */

const authMocks = { verifyCallerLineUserId: vi.fn(async () => 'U_test') };
vi.mock('../services/liff-auth.js', () => authMocks);

// 引数の型を書いておかないと mock.calls が空タプル扱いになり、宛先の検証が書けない。
const pushTextMessage = vi.fn(async (_to: string, _text: string): Promise<void> => undefined);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushTextMessage = pushTextMessage;
  },
}));

const dbMocks = {
  getFriendByLineUserId: vi.fn(),
  getLineAccounts: vi.fn(async () => [{ id: 'acc1', channel_access_token: 'tok' }]),
};
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...dbMocks,
}));

const { default: reservations, toReservation, parsePeople, parseStartMinutes, jstEpochMs } =
  await import('./reservations.js');

const FORM_ID = 'form-booking';
const FRIEND = { id: 'f1', line_user_id: 'U_test', line_account_id: 'acc1', metadata: null };
const WEBHOOK = 'https://script.google.com/macros/s/xxx/exec';

/** 明日の21:00。テストが日付をまたいでも未来であり続ける。 */
function tomorrow(): string {
  const d = new Date(Date.now() + 24 * 3600_000 + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}

function submission(over: Record<string, unknown> = {}) {
  return {
    id: 'sub1',
    friend_id: 'f1',
    created_at: '2026-08-03T12:00:00',
    data: JSON.stringify({
      visit_date: tomorrow(),
      visit_time: '21:00',
      party_size: '4名',
      customer_name: '山田 太郎',
      ...over,
    }),
  };
}

/** 最小限のD1スタブ。UPDATE が走ったかを writes に残す。 */
function makeDb(opts: { row?: unknown; rows?: unknown[] } = {}) {
  const writes: string[] = [];
  return {
    writes,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () =>
          sql.includes('FROM forms') ? { on_submit_webhook_url: WEBHOOK } : (opts.row ?? null),
        all: async () => ({ results: opts.rows ?? [] }),
        run: async () => {
          writes.push(String(args[0]));
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
}

function makeApp(db: unknown, env: Record<string, unknown> = {}) {
  const app = new Hono();
  app.route('/', reservations);
  return {
    app,
    env: { DB: db, BOOKING_FORM_ID: FORM_ID, OWNER_LINE_USER_ID: 'U_owner', ...env },
  };
}

const AUTH = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };

beforeEach(() => {
  dbMocks.getFriendByLineUserId.mockResolvedValue(FRIEND);
  authMocks.verifyCallerLineUserId.mockResolvedValue('U_test');
  pushTextMessage.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function mockCalendar(body: unknown, ok = true) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok,
    json: async () => body,
  });
}

describe('純関数', () => {
  test('人数は「11名以上」のときだけ自由記述を優先する', () => {
    expect(parsePeople('4名', '')).toBe(4);
    expect(parsePeople('11名以上', '15名')).toBe(15);
    expect(parsePeople('11名以上', '')).toBe(11);
    expect(parsePeople('', '')).toBe(1);
  });

  test('24:00枠は翌0時として扱う', () => {
    expect(parseStartMinutes('21:30')).toBe(21 * 60 + 30);
    expect(parseStartMinutes('24:00以降（金・土のみ）')).toBe(24 * 60);
    expect(parseStartMinutes('相談したい')).toBeNull();
  });

  test('JSTの壁時計をUTCに直す', () => {
    // 2026-08-07 21:00 JST = 12:00Z
    expect(jstEpochMs('2026-08-07', 21 * 60)).toBe(Date.parse('2026-08-07T12:00:00Z'));
    // 24:00枠は翌日15:00Z（＝翌0時JST）
    expect(jstEpochMs('2026-08-07', 24 * 60)).toBe(Date.parse('2026-08-07T15:00:00Z'));
  });

  test('キャンセル済み・お断り・過去の予約は一覧に出ない', () => {
    const now = Date.parse('2026-08-04T00:00:00Z');
    const live = { ...submission(), data: JSON.stringify({ visit_date: '2026-08-07', visit_time: '21:00', party_size: '4名', customer_name: 'A' }) };
    expect(toReservation(live, now)).not.toBeNull();

    const cancelled = { ...live, data: JSON.stringify({ ...JSON.parse(live.data), _cancelled_at: 'x' }) };
    expect(toReservation(cancelled, now)).toBeNull();

    const rejected = { ...live, data: JSON.stringify({ ...JSON.parse(live.data), _webhookResult: { success: false } }) };
    expect(toReservation(rejected, now)).toBeNull();

    const past = { ...live, data: JSON.stringify({ ...JSON.parse(live.data), visit_date: '2026-08-01' }) };
    expect(toReservation(past, now)).toBeNull();
  });
});

describe('GET /api/liff/reservations/me', () => {
  test('未設定なら503', async () => {
    const { app, env } = makeApp(makeDb(), { BOOKING_FORM_ID: undefined });
    const res = await app.request('/api/liff/reservations/me', { headers: AUTH }, env);
    expect(res.status).toBe(503);
  });

  test('トークンが無効なら401', async () => {
    authMocks.verifyCallerLineUserId.mockResolvedValue(null as unknown as string);
    const { app, env } = makeApp(makeDb());
    const res = await app.request('/api/liff/reservations/me', { headers: AUTH }, env);
    expect(res.status).toBe(401);
  });

  test('自分の今後の予約だけが返る', async () => {
    const { app, env } = makeApp(makeDb({ rows: [submission()] }));
    const res = await app.request('/api/liff/reservations/me', { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reservations: unknown[] };
    expect(body.reservations).toHaveLength(1);
  });
});

describe('POST /api/liff/reservations/:id/cancel', () => {
  test('カレンダーから消えたらキャンセル済みとして記録する', async () => {
    mockCalendar({ success: true, cancelled: true });
    const db = makeDb({ row: submission() });
    const { app, env } = makeApp(db);

    const res = await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(res.status).toBe(200);
    expect(db.writes).toHaveLength(1);
    expect(JSON.parse(db.writes[0])._cancelled_at).toBeTruthy();
  });

  test('Apps Script が成功を返さなければ取消済みにしない', async () => {
    mockCalendar({ success: false, reason: 'error' });
    const db = makeDb({ row: submission() });
    const { app, env } = makeApp(db);

    const res = await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'calendar_failed' });
    expect(db.writes).toHaveLength(0);
  });

  test('カレンダーに予定が無ければ already_gone、記録も残さない', async () => {
    mockCalendar({ success: false, reason: 'not_found' });
    const db = makeDb({ row: submission() });
    const { app, env } = makeApp(db);

    const res = await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'already_gone' });
    expect(db.writes).toHaveLength(0);
  });

  test('通信が落ちても取消済みにしない', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const db = makeDb({ row: submission() });
    const { app, env } = makeApp(db);

    const res = await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(res.status).toBe(502);
    expect(db.writes).toHaveLength(0);
  });

  test('他人の予約は404（DBクエリが友だちで絞られている）', async () => {
    const db = makeDb({ row: null });
    const { app, env } = makeApp(db);

    const res = await app.request('/api/liff/reservations/other/cancel', { method: 'POST', headers: AUTH }, env);

    expect(res.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('すでにキャンセル済みなら409で、カレンダーを触らない', async () => {
    const db = makeDb({ row: submission({ _cancelled_at: '2026-08-03T12:00:00' }) });
    const { app, env } = makeApp(db);

    const res = await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(res.status).toBe(409);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('お客様とオーナーの両方に通知する', async () => {
    mockCalendar({ success: true });
    const { app, env } = makeApp(makeDb({ row: submission() }));

    await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(pushTextMessage).toHaveBeenCalledTimes(2);
    expect(pushTextMessage.mock.calls[0][0]).toBe('U_test');
    expect(pushTextMessage.mock.calls[1][0]).toBe('U_owner');
    expect(String(pushTextMessage.mock.calls[1][1])).toContain('【キャンセル】');
  });

  test('通知が失敗してもキャンセル自体は成立する', async () => {
    mockCalendar({ success: true });
    pushTextMessage.mockRejectedValueOnce(new Error('line down'));
    const db = makeDb({ row: submission() });
    const { app, env } = makeApp(db);

    const res = await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(res.status).toBe(200);
    expect(db.writes).toHaveLength(1);
  });

  test('オーナー未設定なら通知はお客様だけ', async () => {
    mockCalendar({ success: true });
    const { app, env } = makeApp(makeDb({ row: submission() }), { OWNER_LINE_USER_ID: undefined });

    await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    expect(pushTextMessage).toHaveBeenCalledTimes(1);
  });

  test('Apps Script には action:cancel と予約内容を渡す', async () => {
    mockCalendar({ success: true });
    const { app, env } = makeApp(makeDb({ row: submission() }));

    await app.request('/api/liff/reservations/sub1/cancel', { method: 'POST', headers: AUTH }, env);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(WEBHOOK);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      action: 'cancel',
      visit_time: '21:00',
      party_size: '4名',
      customer_name: '山田 太郎',
    });
  });
});

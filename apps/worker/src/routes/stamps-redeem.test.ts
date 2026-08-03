import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * ウェルカム券／カムバック券の使用が、店内QRの合言葉なしには通らないこと。
 *
 * どちらも一生に1回で、使うと元に戻せない。以前はスタンプの無料券だけが
 * 合言葉で守られていて、この2つは自宅からでも消費できた。
 */

const authMocks = { verifyCallerLineUserId: vi.fn(async () => 'U_test') };
vi.mock('../services/liff-auth.js', () => authMocks);

const dbMocks = { getFriendByLineUserId: vi.fn() };
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...dbMocks,
}));

const { default: stampRoutes } = await import('./stamps.js');
const { businessDate } = await import('../services/welcome-perk.js');

const CODE = 'in-store-code';

/** 書き込みが起きたかを見たいので、run() の呼び出しを記録するだけのDB。 */
function makeDb() {
  const writes: unknown[][] = [];
  return {
    writes,
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          writes.push(args);
          return { meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

function makeApp(db: unknown) {
  const app = new Hono();
  app.route('/', stampRoutes);
  return { app, env: { DB: db, STAMP_QR_CODE: CODE } };
}

function post(app: Hono, path: string, body: unknown, env: unknown) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** 今日発行・未使用＝使える状態の友だち。 */
function usableFriend(kind: 'welcome' | 'comeback') {
  const key = kind === 'welcome' ? 'welcome_issued_date' : 'comeback_issued_date';
  return { id: 'f1', metadata: JSON.stringify({ [key]: businessDate() }) };
}

const CASES = [
  { kind: 'welcome' as const, path: '/api/liff/stamps/welcome/redeem', label: 'ウェルカム券' },
  { kind: 'comeback' as const, path: '/api/liff/stamps/comeback/redeem', label: 'カムバック券' },
];

beforeEach(() => {
  authMocks.verifyCallerLineUserId.mockClear();
  dbMocks.getFriendByLineUserId.mockReset();
});

describe.each(CASES)('$label の使用は店内QRを要求する', ({ kind, path }) => {
  test('合言葉が無ければ403で、使用済みにもしない', async () => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(usableFriend(kind));
    const db = makeDb();
    const { app, env } = makeApp(db);

    const res = await post(app, path, {}, env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
    expect(db.writes).toHaveLength(0);
  });

  test('合言葉が違えば403', async () => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(usableFriend(kind));
    const db = makeDb();
    const { app, env } = makeApp(db);

    const res = await post(app, path, { code: 'wrong-code-xx' }, env);

    expect(res.status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });

  test('正しい合言葉なら使用できる', async () => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(usableFriend(kind));
    const db = makeDb();
    const { app, env } = makeApp(db);

    const res = await post(app, path, { code: CODE }, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(db.writes).toHaveLength(1);
  });

  test('合言葉の検査は本人確認より後（他人の券は合言葉を知っていても使えない）', async () => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    const db = makeDb();
    const { app, env } = makeApp(db);

    const res = await post(app, path, { code: CODE }, env);

    expect(res.status).toBe(404);
    expect(db.writes).toHaveLength(0);
  });
});

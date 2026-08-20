import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// 受け皿 (auto_replies.is_fallback) の分岐だけを見るテスト。
// どのキーワードにも当たらなかったテキストのときに 1 通だけ返り、
// キーワードに当たったときや postback では返らないことを確認する。

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

const automationMocks = vi.hoisted(() => ({ willReply: false }));

vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn().mockResolvedValue([]),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn().mockResolvedValue([]),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn().mockReturnValue('2026-08-20T15:11:50.000+09:00'),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
  getTemplateById: vi.fn().mockResolvedValue(null),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn().mockResolvedValue(true),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
  willAutomationSendMessage: vi.fn(async () => automationMocks.willReply),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: (type: string, content: string) => ({ type, text: content }),
  expandVariables: (content: string) => content,
  resolveMetadata: vi.fn().mockResolvedValue({}),
  messageToLogPayload: (msg: { type: string; text: string }) => ({
    messageType: msg.type,
    content: msg.text,
  }),
}));

import { getFriendByLineUserId, upsertChatOnMessage } from '@line-crm/db';
import { webhook } from './webhook.js';

const FALLBACK_TEXT = '個別のお問い合わせにはお答えできません';
const KEYWORD_TEXT = '20:00〜24:00です';

interface Rule {
  keyword: string;
  match_type: string;
  response_type: string;
  response_content: string;
  template_id: string | null;
  line_account_id: string | null;
  is_fallback: number;
  created_at: string;
}

const keywordRule: Rule = {
  keyword: '営業時間',
  match_type: 'contains',
  response_type: 'text',
  response_content: KEYWORD_TEXT,
  template_id: null,
  line_account_id: null,
  is_fallback: 0,
  created_at: '2026-01-01T00:00:00.000',
};

const fallbackRule: Rule = {
  keyword: '（受け皿）',
  match_type: 'exact',
  response_type: 'text',
  response_content: FALLBACK_TEXT,
  template_id: null,
  line_account_id: null,
  is_fallback: 1,
  created_at: '2026-08-01T00:00:00.000',
};

/** auto_replies の 2 本のクエリだけ canned rows を返し、他は無害に受け流す DB スタブ */
function stubDB(rules: Rule[]) {
  return {
    prepare(sql: string) {
      const isFallbackQuery = sql.includes('is_fallback = 1');
      const isKeywordQuery = sql.includes('FROM auto_replies') && !isFallbackQuery;
      const stmt = {
        bind: () => stmt,
        run: async () => ({}),
        all: async () => ({
          results: isKeywordQuery ? rules.filter((r) => r.is_fallback === 0) : [],
        }),
        first: async () =>
          isFallbackQuery ? (rules.find((r) => r.is_fallback === 1) ?? null) : null,
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function textEvent(text: string) {
  return {
    type: 'message',
    replyToken: 'reply-token',
    message: { type: 'text', id: 'message-1', text },
    timestamp: 1755670310000,
    source: { type: 'user', userId: 'U-test' },
    webhookEventId: 'event-1',
    deliveryContext: { isRedelivery: false },
    mode: 'active',
  };
}

function postbackEvent(data: string) {
  return {
    type: 'postback',
    replyToken: 'reply-token-postback',
    postback: { data },
    timestamp: 1755670310000,
    source: { type: 'user', userId: 'U-test' },
    webhookEventId: 'event-2',
    deliveryContext: { isRedelivery: false },
    mode: 'active',
  };
}

async function post(event: unknown, rules: Rule[]) {
  const app = new Hono();
  app.route('/', webhook);
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;

  const res = await app.request(
    '/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
      body: JSON.stringify({ destination: 'bot', events: [event] }),
    },
    { ...baseEnv, DB: stubDB(rules) },
    executionCtx,
  );
  const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
  if (processing) await processing;
  return res;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

function sentTexts(): string[] {
  return lineClientMocks.replyMessage.mock.calls.map(
    (c) => (c[1] as Array<{ text: string }>)[0].text,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  automationMocks.willReply = false;
  vi.mocked(getFriendByLineUserId).mockResolvedValue({
    id: 'friend-1',
    line_user_id: 'U-test',
    display_name: 'テスト',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-06-18T12:00:00.000+09:00',
    updated_at: '2026-06-18T12:00:00.000+09:00',
  } as never);
  vi.mocked(upsertChatOnMessage).mockResolvedValue({} as never);
});

describe('受け皿 (auto_replies.is_fallback)', () => {
  test('キーワードに当たったら受け皿は出ない (返信は 1 通)', async () => {
    await post(textEvent('営業時間'), [keywordRule, fallbackRule]);
    expect(sentTexts()).toEqual([KEYWORD_TEXT]);
  });

  test('どのキーワードにも当たらなければ受け皿を 1 通返す', async () => {
    await post(textEvent('こんばんは'), [keywordRule, fallbackRule]);
    expect(sentTexts()).toEqual([FALLBACK_TEXT]);
  });

  test('受け皿を返しても unread にはする (未対応 inbox から消さない)', async () => {
    await post(textEvent('こんばんは'), [keywordRule, fallbackRule]);
    expect(vi.mocked(upsertChatOnMessage)).toHaveBeenCalledWith(expect.anything(), 'friend-1');
  });

  test('受け皿が未設定なら何も送らない (既存アカウントの挙動を変えない)', async () => {
    await post(textEvent('こんばんは'), [keywordRule]);
    expect(sentTexts()).toEqual([]);
  });

  test('postback (リッチメニューのタップ) では受け皿を出さない', async () => {
    await post(postbackEvent('tag:premium'), [keywordRule, fallbackRule]);
    expect(sentTexts()).toEqual([]);
  });

  test('IF-THEN 自動化が返信する構成なら受け皿を出さない (2 通防止)', async () => {
    automationMocks.willReply = true;
    await post(textEvent('こんばんは'), [keywordRule, fallbackRule]);
    expect(sentTexts()).toEqual([]);
  });

  test('silent な受け皿は送信しない', async () => {
    await post(textEvent('こんばんは'), [
      keywordRule,
      { ...fallbackRule, response_type: 'silent', response_content: '' },
    ]);
    expect(sentTexts()).toEqual([]);
  });
});

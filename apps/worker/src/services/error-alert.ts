import { getAccountSetting, getLineAccounts, setAccountSetting } from '@line-crm/db';
import { notifyOwner } from './owner-notify.js';

/**
 * 壊れたことをお店に知らせる。
 *
 * この仕組みが要るのは、まずいことほど静かに起きるから。予約用の Apps Script が
 * 落ちると、お客様には「お席をご用意できませんでした」と届く。満席のときと同じ
 * 文面なので、店も客も故障だと気づかないまま予約を取り逃がす。同じことが
 * cron の停止（配信とリマインドが止まる）やチャネルトークンの失効（送信が全部
 * 落ちる）でも起きる。どれも画面上は何も変わらない。
 *
 * ── 送りすぎない ──
 * LINEのプッシュは課金対象。壊れ方によっては毎分の cron から延々と鳴りうるので、
 * 上限を2段構えにしてある。
 *   1. 種類ごとに30分のクールダウン（同じ故障を連呼しない）
 *   2. 全体で1時間6通まで（複数種が同時に壊れても財布とトーク欄を守る）
 * 抑制した分は次の通知に「他N件」として載せるので、握りつぶしにはならない。
 *
 * 通知に失敗しても呼び出し元は続行する。通知の不達で本来の処理を落とさない。
 */

/** 通知の種類。行が無限に増えないよう、ここに列挙したものだけを使う。 */
export type AlertKind =
  | 'route_error'
  | 'cron_error'
  | 'booking_webhook_error'
  | 'line_push_error';

const LABEL: Record<AlertKind, string> = {
  route_error: 'APIでエラー',
  cron_error: '定期処理でエラー',
  booking_webhook_error: '予約カレンダー連携でエラー',
  line_push_error: 'LINE送信でエラー',
};

/** 同じ種類を連呼しない間隔。 */
const COOLDOWN_MS = 30 * 60_000;
/** 1時間あたりの通知上限。壊れ方が派手でもここで頭打ちになる。 */
const HOURLY_CAP = 6;
const BUDGET_KEY = 'error_alert:_budget';
/** 文面に載せるエラー本文の長さ。長いスタックをそのまま送らない。 */
const DETAIL_MAX = 300;

interface KindState {
  lastSentAt: number;
  suppressed: number;
}

interface Budget {
  windowStart: number;
  sent: number;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 本文を通知に載せられる形に均す。
 *
 * スタックトレースは1行目だけ取る。以降は File/URL が並ぶだけで、LINEのトークで
 * 読めるものではないため。長さも切る。
 */
export function summarize(detail: unknown, max: number = DETAIL_MAX): string {
  const text =
    detail instanceof Error
      ? `${detail.name}: ${detail.message}`
      : typeof detail === 'string'
        ? detail
        : (() => {
            try {
              return JSON.stringify(detail);
            } catch {
              return String(detail);
            }
          })();
  const firstLine = text.split('\n')[0]!.trim();
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

export function alertText(
  kind: AlertKind,
  detail: string,
  suppressed: number,
  now: Date,
): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return [
    `⚠️ ${LABEL[kind]}`,
    '',
    `${hh}:${mm}`,
    detail,
    ...(suppressed > 0 ? ['', `※ 直前の30分に同じものが他${suppressed}件`] : []),
    '',
    'ログ: npx wrangler tail',
  ].join('\n');
}

/**
 * 1件通知する。抑制されたときは false を返す（呼び出し元は無視してよい）。
 *
 * 例外は投げない。エラー通知の失敗でエラーを増やしても仕方がない。
 */
export async function alertOwner(
  env: {
    DB: D1Database;
    OWNER_LINE_USER_ID?: string;
    LINE_CHANNEL_ACCESS_TOKEN?: string;
  },
  kind: AlertKind,
  detail: unknown,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (!env.OWNER_LINE_USER_ID?.trim()) return false;

    const accounts = await getLineAccounts(env.DB);
    const accountId = accounts[0]?.id;
    if (!accountId) return false;

    const kindKey = `error_alert:${kind}`;
    const state = parse<KindState>(await getAccountSetting(env.DB, accountId, kindKey), {
      lastSentAt: 0,
      suppressed: 0,
    });

    // 同じ種類はクールダウン中なら数えるだけ。
    if (nowMs - state.lastSentAt < COOLDOWN_MS) {
      await setAccountSetting(
        env.DB,
        accountId,
        kindKey,
        JSON.stringify({ ...state, suppressed: state.suppressed + 1 }),
      );
      return false;
    }

    const budget = parse<Budget>(await getAccountSetting(env.DB, accountId, BUDGET_KEY), {
      windowStart: 0,
      sent: 0,
    });
    const fresh = nowMs - budget.windowStart >= 3600_000;
    const sent = fresh ? 0 : budget.sent;
    if (sent >= HOURLY_CAP) {
      await setAccountSetting(
        env.DB,
        accountId,
        kindKey,
        JSON.stringify({ ...state, suppressed: state.suppressed + 1 }),
      );
      return false;
    }

    const ok = await notifyOwner(
      env,
      alertText(kind, summarize(detail), state.suppressed, new Date(nowMs + 9 * 3600_000)),
    );
    if (!ok) return false;

    await setAccountSetting(
      env.DB,
      accountId,
      kindKey,
      JSON.stringify({ lastSentAt: nowMs, suppressed: 0 }),
    );
    await setAccountSetting(
      env.DB,
      accountId,
      BUDGET_KEY,
      JSON.stringify({ windowStart: fresh ? nowMs : budget.windowStart, sent: sent + 1 }),
    );
    return true;
  } catch (err) {
    console.error('error-alert: failed to alert', err);
    return false;
  }
}

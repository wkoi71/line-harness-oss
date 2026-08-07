import { getLineAccounts } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

/**
 * 予約が入ったとき・取り消されたときに、お店へLINEで知らせる。
 *
 * 予約の台帳はGoogleカレンダーなので、放っておくと店側が気づくのは
 * カレンダーを開いたときだけになる。とくにキャンセルは「予定が黙って
 * 消える」だけなので見落としやすい。
 *
 * 送れなくても予約自体は成立しているため、呼び出し側は必ず失敗を握りつぶす。
 * 通知の不達で予約が落ちるほうが害が大きい。
 */

/** 通知の宛先。未設定なら通知しない（機能ごと無効になるだけ）。 */
export function resolveOwnerLineUserId(env: { OWNER_LINE_USER_ID?: string }): string | null {
  const raw = env.OWNER_LINE_USER_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export interface BookingNotice {
  visitDate: string;
  visitTime: string;
  people: number;
  customerName: string;
  phone?: string | null;
  occasion?: string | null;
  notes?: string | null;
}

function line(label: string, value: unknown): string | null {
  const v = String(value ?? '').trim();
  return v ? `${label}：${v}` : null;
}

/** 新規予約の知らせ。要望とアレルギーは仕込みに関わるので必ず載せる。 */
export function bookingText(b: BookingNotice): string {
  return [
    '【新しいご予約】',
    '',
    `${b.visitDate} ${b.visitTime}`,
    `${b.customerName} 様 ${b.people}名`,
    line('お電話', b.phone),
    line('ご利用シーン', b.occasion),
    line('ご要望', b.notes),
    '',
    'カレンダーに登録済みです。',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** キャンセルの知らせ。カレンダーからはすでに消えている。 */
export function cancelText(b: Pick<BookingNotice, 'visitDate' | 'visitTime' | 'people' | 'customerName'>): string {
  return [
    '【キャンセル】',
    '',
    `${b.visitDate} ${b.visitTime}`,
    `${b.customerName} 様 ${b.people}名`,
    '',
    'カレンダーの予定は削除済みです。',
  ].join('\n');
}

/**
 * お店へ1通押す。宛先未設定・トークン未解決なら黙って何もしない。
 *
 * 通知は「気づくため」のものなので、失敗しても呼び出し元の処理は続ける。
 * 例外は投げずに false を返す。
 *
 * オーナー本人の予約でも送る。自分で予約して確かめるのが唯一の動作確認手段
 * なので、そこで黙ると壊れているのか設定漏れなのか分からなくなる。お客様向けの
 * 確定メッセージとは中身が別（電話番号・ご要望が載る店側の控え）なので、
 * 2通届いても重複にはならない。
 */
export async function notifyOwner(
  env: { DB: D1Database; OWNER_LINE_USER_ID?: string; LINE_CHANNEL_ACCESS_TOKEN?: string },
  text: string,
): Promise<boolean> {
  const owner = resolveOwnerLineUserId(env);
  if (!owner) return false;

  try {
    const accounts = await getLineAccounts(env.DB);
    const token =
      (accounts[0] as unknown as { channel_access_token?: string } | undefined)?.channel_access_token ??
      env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) return false;
    await new LineClient(token).pushTextMessage(owner, text);
    return true;
  } catch (err) {
    console.error('owner-notify: push failed', err);
    return false;
  }
}

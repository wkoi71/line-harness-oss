import { describe, expect, test } from 'vitest';

/**
 * `/o` が NFC タグからの導線として成立すること。
 *
 * NFC は端末の既定ブラウザで開く。`liff.line.me` を直接タグに書くと Safari が
 * それを開き、LINEアプリに渡らず「メールアドレスとパスワードでログイン」を
 * 要求される（2026-08-09 に実機で確認）。`/o` を挟んで「LINEで開く」を
 * 踏ませるのが回避策で、そのとき合言葉(sc)を落とすとスタンプが押せない。
 */

// index.ts が既定でエクスポートするのは Hono アプリではなく Worker のハンドラ。
const { default: worker } = await import('../index.js');

const LIFF = '2010831620-kYXEtFNt';
const SC = 'DHZmM97BNiRh7SMlEjb9gkjJIqk9SObv';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function call(query: string, ua: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://example.com/o?${query}`, { headers: { 'user-agent': ua } }),
    {} as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}

async function open(query: string, ua: string = IPHONE): Promise<string> {
  const res = await call(query, ua);
  expect(res.status).toBe(200);
  return res.text();
}

/** ページに埋まっている liff.line.me のリンク先を取り出す。 */
function liffHref(html: string): string {
  const m = html.match(/href="(https:\/\/liff\.line\.me[^"]*)"/);
  return m ? m[1].replace(/&amp;/g, '&') : '';
}

describe('/o — NFC・OpenChat 向けのラッパー', () => {
  test('スタンプの合言葉を落とさずに渡す', async () => {
    const href = liffHref(await open(`liffId=${LIFF}&page=stamp&sc=${SC}`));
    expect(href).toContain(`liff.line.me/${LIFF}`);
    expect(href).toContain('page=stamp');
    expect(href).toContain(`sc=${SC}`);
  });

  test('スマホには「LINEで開く」ボタンを出す（Safariのログイン画面に落とさない）', async () => {
    const html = await open(`liffId=${LIFF}&page=stamp&sc=${SC}`);
    expect(html).toContain('LINEで開く');
  });

  test('友だち追加ゲートの無いページは通さない', async () => {
    // form / book は ref 帰属もゲートも素通りするので、意図的に対象外にしてある
    for (const page of ['form', 'book']) {
      const href = liffHref(await open(`liffId=${LIFF}&page=${page}`));
      expect(href).not.toContain(`page=${page}`);
    }
  });

  test('既存の許可ページは通したまま', async () => {
    for (const page of ['salon-book', 'event', 'event-me']) {
      const href = liffHref(await open(`liffId=${LIFF}&page=${page}`));
      expect(href).toContain(`page=${page}`);
    }
  });

  test('sc が無ければ付けない', async () => {
    expect(liffHref(await open(`liffId=${LIFF}&page=stamp`))).not.toContain('sc=');
  });

  test('liffId の形式が不正なら 400', async () => {
    const res = await call('liffId=../evil', IPHONE);
    expect(res.status).toBe(400);
  });

  test('Android は LINE アプリを名指しする intent:// を出す', async () => {
    const html = await open(
      `liffId=${LIFF}&page=stamp&sc=${SC}`,
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36',
    );
    expect(html).toContain('intent://');
    expect(html).toContain('jp.naver.line.android');
  });
});

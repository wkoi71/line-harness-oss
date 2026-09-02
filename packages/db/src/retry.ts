/**
 * D1 の一過性エラーを飲み込むための再試行。
 *
 * D1 は正常時でもごく稀に `D1_ERROR: Network connection lost.` を返す。Worker と
 * D1 の間のコネクションが切れただけで、直後に同じクエリを投げれば通る。実際
 * cron (5分毎) では 1日に数回この形で落ちていて、そのたび scheduled 全体が
 * 中断し、店には「定期処理でエラー」が届いていた。中身は何も壊れていない。
 *
 * 再試行してよいのは「もう一度実行しても結果が変わらない」処理だけ。読み取りは
 * 常に安全。書き込みは注意が要る — コネクション断は「コミット済みの応答が
 * 返ってこなかった」場合にも起きるので、非冪等な INSERT をここに通すと二重に
 * 入りうる。冪等なもの (UPSERT、条件付き UPDATE) 以外には使わない。
 */

/** 再試行して意味のあるエラーか。文面でしか判別できない (D1 は型を持たない)。 */
export function isTransientD1Error(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('network connection lost') ||
    lower.includes('storage operation exceeded timeout') ||
    lower.includes('d1_error: internal error')
  );
}

export interface D1RetryOptions {
  /** 最初の1回を含む実行回数。 */
  attempts?: number;
  /** 1回目の待ち時間 (ms)。以降は倍にする。 */
  baseDelayMs?: number;
  /** テスト用。既定は setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 一過性エラーなら間を置いて再実行する。それ以外はそのまま投げ直す。
 *
 * 最後の試行も失敗したら投げる。恒常的に落ちているなら、それは知らせるべき障害。
 */
export async function withD1Retry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 50, sleep = defaultSleep }: D1RetryOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientD1Error(err) || i === attempts - 1) throw err;
      lastErr = err;
      console.warn(
        `[d1-retry] transient error, retrying (${i + 1}/${attempts - 1}):`,
        err instanceof Error ? err.message : err,
      );
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

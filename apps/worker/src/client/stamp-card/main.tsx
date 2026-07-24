import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface StampCardContext {
  idToken: string;
  /** In-store code lifted from the QR (`?sc=`). Absent when opened from the rich menu. */
  code: string | null;
}

interface CardState {
  count: number;
  goal: number;
  rewardsPending: number;
  rewardsTotal: number;
  stampedToday: boolean;
  displayName: string | null;
}

type Banner =
  | { kind: 'earned'; count: number; goal: number }
  | { kind: 'rewarded'; rewardsPending: number }
  | { kind: 'already' }
  | { kind: 'redeemed'; rewardsPending: number }
  | { kind: 'error'; message: string };

const INK = '#12141a';
const GOLD = '#c9a227';
const PAPER = '#f7f5f0';

async function api(path: string, idToken: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function Stamps({ count, goal }: { count: number; goal: number }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 10, margin: '28px 0 8px' }}>
      {Array.from({ length: goal }, (_, i) => {
        const filled = i < count;
        return (
          <div
            key={i}
            aria-label={filled ? 'スタンプ済み' : '未スタンプ'}
            style={{
              width: 46,
              height: 46,
              borderRadius: '50%',
              border: `2px solid ${filled ? GOLD : 'rgba(18,20,26,0.18)'}`,
              background: filled ? GOLD : 'transparent',
              color: INK,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              fontWeight: 700,
              transition: 'all .25s ease',
            }}
          >
            {filled ? '★' : ''}
          </div>
        );
      })}
    </div>
  );
}

function StampCard({ ctx }: { ctx: StampCardContext }): JSX.Element {
  const [card, setCard] = useState<CardState | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);
  const claimed = useRef(false);

  const load = useCallback(async () => {
    const res = await api('/api/liff/stamps/me', ctx.idToken);
    if (!res.ok) {
      setBanner({
        kind: 'error',
        message:
          res.status === 404
            ? 'お友だち登録が確認できませんでした。友だち追加のうえ、もう一度お試しください。'
            : 'カードを読み込めませんでした。時間をおいてお試しください。',
      });
      return;
    }
    setCard((await res.json()) as CardState);
  }, [ctx.idToken]);

  const claim = useCallback(async () => {
    if (!ctx.code || claimed.current) return;
    claimed.current = true;
    setBusy(true);
    const res = await api('/api/liff/stamps/claim', ctx.idToken, { code: ctx.code });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      if (data.rewarded) {
        setBanner({ kind: 'rewarded', rewardsPending: Number(data.rewardsPending ?? 0) });
      } else {
        setBanner({
          kind: 'earned',
          count: Number(data.count ?? 0),
          goal: Number(data.goal ?? 5),
        });
      }
    } else if (res.status === 409) {
      setBanner({ kind: 'already' });
    } else if (res.status === 403) {
      setBanner({ kind: 'error', message: 'このQRコードは使えませんでした。店内のQRをお読み取りください。' });
    } else {
      setBanner({ kind: 'error', message: 'スタンプを押せませんでした。スタッフにお声がけください。' });
    }
    await load();
    setBusy(false);
  }, [ctx.code, ctx.idToken, load]);

  const redeem = useCallback(async () => {
    if (!ctx.code) {
      setBanner({
        kind: 'error',
        message: '無料券は店内でのご利用のみです。店内のQRを読み取ってからお試しください。',
      });
      return;
    }
    if (!window.confirm('無料券を1枚使用します。スタッフの前で押してください。よろしいですか？')) return;
    setBusy(true);
    const res = await api('/api/liff/stamps/redeem', ctx.idToken, { code: ctx.code });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      setBanner({ kind: 'redeemed', rewardsPending: Number(data.rewardsPending ?? 0) });
    } else {
      setBanner({ kind: 'error', message: '使用できませんでした。スタッフにお声がけください。' });
    }
    await load();
    setBusy(false);
  }, [ctx.code, ctx.idToken, load]);

  useEffect(() => {
    void (async () => {
      await load();
      await claim();
    })();
  }, [load, claim]);

  const bannerText = ((): { text: string; tone: 'good' | 'warn' } | null => {
    if (!banner) return null;
    switch (banner.kind) {
      case 'earned':
        return {
          text: `スタンプを1つ押しました🌙 あと${banner.goal - banner.count}個で無料券です`,
          tone: 'good',
        };
      case 'rewarded':
        return {
          text: `満杯です！バスクチーズケーキの無料券が${banner.rewardsPending}枚たまりました🎉`,
          tone: 'good',
        };
      case 'already':
        return { text: '本日はスタンプ済みです。またのご来店をお待ちしています🌙', tone: 'warn' };
      case 'redeemed':
        return {
          text: `無料券を1枚使用しました。残り${banner.rewardsPending}枚です`,
          tone: 'good',
        };
      case 'error':
        return { text: banner.message, tone: 'warn' };
    }
  })();

  return (
    <div
      style={{
        maxWidth: 480,
        margin: '0 auto',
        padding: '24px 20px 48px',
        fontFamily: "'Hiragino Sans','Yu Gothic',system-ui,sans-serif",
        color: INK,
        background: PAPER,
        minHeight: '100vh',
      }}
    >
      <p style={{ fontSize: 12, letterSpacing: '.18em', color: GOLD, fontWeight: 700, margin: 0 }}>
        YORU. SWEETS &amp; BAR
      </p>
      <h1 style={{ fontSize: 22, margin: '6px 0 0', fontWeight: 700 }}>スタンプカード</h1>
      {card?.displayName && (
        <p style={{ fontSize: 13, color: '#77767c', margin: '6px 0 0' }}>{card.displayName} さん</p>
      )}

      {bannerText && (
        <div
          role="status"
          style={{
            marginTop: 18,
            padding: '12px 14px',
            borderRadius: 10,
            fontSize: 14,
            lineHeight: 1.6,
            background: bannerText.tone === 'good' ? 'rgba(201,162,39,0.14)' : 'rgba(18,20,26,0.06)',
            border: `1px solid ${bannerText.tone === 'good' ? 'rgba(201,162,39,0.45)' : 'rgba(18,20,26,0.12)'}`,
          }}
        >
          {bannerText.text}
        </div>
      )}

      <div
        style={{
          marginTop: 20,
          background: '#fff',
          borderRadius: 14,
          padding: '20px 16px 24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
        }}
      >
        {card ? (
          <>
            <Stamps count={card.count} goal={card.goal} />
            <p style={{ textAlign: 'center', fontSize: 14, color: '#77767c', margin: '10px 0 0' }}>
              {card.count} / {card.goal} 個
              {card.count < card.goal && `　あと${card.goal - card.count}個で無料券`}
            </p>
            <p style={{ textAlign: 'center', fontSize: 12, color: '#9b9aa0', margin: '10px 0 0' }}>
              {card.stampedToday
                ? '本日のスタンプは押し済みです'
                : 'ご来店時に店内のQRコードを読み取ってください'}
            </p>
          </>
        ) : (
          <p style={{ textAlign: 'center', color: '#9b9aa0', fontSize: 14, padding: '28px 0' }}>
            読み込み中...
          </p>
        )}
      </div>

      {card && card.rewardsPending > 0 && (
        <div
          style={{
            marginTop: 16,
            background: INK,
            color: PAPER,
            borderRadius: 14,
            padding: '20px 16px',
          }}
        >
          <p style={{ fontSize: 12, color: GOLD, fontWeight: 700, margin: 0 }}>ご利用いただけます</p>
          <p style={{ fontSize: 19, fontWeight: 700, margin: '6px 0 0' }}>
            バスクチーズケーキ 無料券 ×{card.rewardsPending}
          </p>
          <p style={{ fontSize: 13, lineHeight: 1.7, margin: '10px 0 0', color: 'rgba(247,245,240,0.72)' }}>
            プレーン・抹茶・キャラメルからお選びいただけます。ご注文時にこの画面をスタッフにお見せください。
          </p>
          <button
            type="button"
            onClick={() => void redeem()}
            disabled={busy}
            style={{
              width: '100%',
              marginTop: 16,
              padding: '13px',
              border: 'none',
              borderRadius: 9,
              background: busy ? '#7a7364' : GOLD,
              color: INK,
              fontSize: 15,
              fontWeight: 700,
              fontFamily: 'inherit',
            }}
          >
            スタッフが使用する
          </button>
        </div>
      )}

      <div style={{ marginTop: 22, fontSize: 12, lineHeight: 1.9, color: '#77767c' }}>
        <p style={{ margin: 0, fontWeight: 700, color: INK }}>ご利用について</p>
        <p style={{ margin: 0 }}>・ご来店1回につきスタンプ1つ（1日1回まで）</p>
        <p style={{ margin: 0 }}>・スタンプ5つでバスクチーズケーキが1つ無料</p>
        <p style={{ margin: 0 }}>・無料券に有効期限はありません</p>
        <p style={{ margin: 0 }}>・満杯になるとカードは自動でリセットされ、また1つ目から貯まります</p>
        {card && card.rewardsTotal > 0 && (
          <p style={{ margin: '8px 0 0' }}>これまでに獲得した無料券：{card.rewardsTotal}枚</p>
        )}
      </div>
    </div>
  );
}

export function mountStampCard(container: HTMLElement, ctx: StampCardContext): void {
  createRoot(container).render(<StampCard ctx={ctx} />);
}

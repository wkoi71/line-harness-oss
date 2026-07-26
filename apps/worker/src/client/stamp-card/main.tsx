import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CANDLE_SIT, CANDLE_RUN, LOGO } from './assets.js';

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

// ─── Warm "candle" palette (matches the YORU. reference art) ───────────────
const PAGE = '#FBF6EA';
const CARD = '#FCFAF3';
const CARD_BORDER = '#ECBA53';
const GOLD = '#EAA93C';
const GOLD_DEEP = '#CE8E1E';
const INK = '#2B2620';
const LABEL = '#C6982F';
const ORANGE = '#EE8E28';
const MUTED = '#A99C84';
const PILL_BG = '#F7EBCF';
const PILL_TEXT = '#7A6636';
const RING = '#E6DAC0';
const FAINT = '#D9CBAE';
const FONT = "'Hiragino Maru Gothic ProN','Hiragino Sans','Yu Gothic',system-ui,sans-serif";

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

// ─── SVG art ───────────────────────────────────────────────────────────────

function Defs(): JSX.Element {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <linearGradient id="flameGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFD25A" />
          <stop offset="0.5" stopColor="#FBA735" />
          <stop offset="1" stopColor="#F2701F" />
        </linearGradient>
        <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F6CB63" />
          <stop offset="1" stopColor="#E1971F" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function Sparkle({ size = 16, color = GOLD, style }: { size?: number; color?: string; style?: React.CSSProperties }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d="M12 0 C13 7 17 11 24 12 C17 13 13 17 12 24 C11 17 7 13 0 12 C7 11 11 7 12 0 Z" fill={color} />
    </svg>
  );
}

/** Mini candle used inside stamp slots. */
function MiniCandle({ active }: { active: boolean }): JSX.Element {
  const stroke = active ? '#FFFFFF' : FAINT;
  const flame = active ? '#FFFFFF' : FAINT;
  return (
    <svg width="30" height="34" viewBox="0 0 48 56" aria-hidden>
      <path d="M24 4 C29 14 33 18 33 25 C33 32 29 36 24 36 C19 36 15 32 15 25 C15 18 19 14 24 4 Z" fill={active ? 'url(#flameGrad)' : 'none'} stroke={active ? 'none' : flame} strokeWidth="2.4" />
      <rect x="14" y="34" width="20" height="20" rx="6" fill={active ? '#FFFFFF' : 'none'} stroke={stroke} strokeWidth="2.6" />
      {active && (
        <>
          <circle cx="20.5" cy="44" r="1.8" fill={INK} />
          <circle cx="27.5" cy="44" r="1.8" fill={INK} />
        </>
      )}
    </svg>
  );
}

function StampSlot({ filled, first }: { filled: boolean; first?: boolean }): JSX.Element {
  return (
    <div style={{ position: 'relative', width: 58, height: 58, flex: '0 0 auto' }}>
      {filled && first && (
        <svg width="24" height="16" viewBox="0 0 24 16" style={{ position: 'absolute', top: -14, left: 17 }} aria-hidden>
          <path d="M12 0 V10 M4 3 L7 11 M20 3 L17 11" stroke={GOLD_DEEP} strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      )}
      <div
        style={{
          width: 58,
          height: 58,
          borderRadius: '50%',
          border: filled ? `2.5px solid ${GOLD_DEEP}` : `2.5px solid ${RING}`,
          background: filled ? 'url(#goldGrad)' : 'transparent',
          backgroundImage: filled ? 'linear-gradient(#F6CB63,#E1971F)' : 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: filled ? '0 3px 8px rgba(210,143,30,0.35)' : 'none',
        }}
      >
        <MiniCandle active={filled} />
      </div>
    </div>
  );
}

function StampRow({ count, goal }: { count: number; goal: number }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, margin: '26px 0 10px' }}>
      {Array.from({ length: goal }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
          <StampSlot filled={i < count} first={i === 0} />
          {i < goal - 1 && (
            <span style={{ display: 'flex', gap: 3, margin: '0 1px' }} aria-hidden>
              <span style={{ width: 3, height: 3, borderRadius: '50%', background: FAINT }} />
              <span style={{ width: 3, height: 3, borderRadius: '50%', background: FAINT }} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Ribbon({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ position: 'relative', width: 270, height: 46, margin: '0 auto' }}>
      <svg width="270" height="46" viewBox="0 0 270 46" style={{ position: 'absolute', inset: 0 }} aria-hidden>
        <path d="M0 8 L20 23 L0 38 L14 23 Z" fill={GOLD_DEEP} />
        <path d="M270 8 L250 23 L270 38 L256 23 Z" fill={GOLD_DEEP} />
        <rect x="16" y="2" width="238" height="42" rx="8" fill="url(#goldGrad)" stroke={GOLD_DEEP} strokeWidth="1.5" />
        <path d="M16 2 L8 12 L16 12 Z" fill={GOLD_DEEP} opacity="0.55" />
        <path d="M254 2 L262 12 L254 12 Z" fill={GOLD_DEEP} opacity="0.55" />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 800,
          fontSize: 15,
          color: '#5A431A',
        }}
      >
        {text}
      </div>
    </div>
  );
}

function FlameIcon({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2 C16 8 19 11 19 15 C19 19 16 22 12 22 C8 22 5 19 5 15 C5 11 8 8 12 2 Z" fill="url(#flameGrad)" />
    </svg>
  );
}

function ScallopFooter(): JSX.Element {
  return (
    <svg width="100%" height="70" viewBox="0 0 400 70" preserveAspectRatio="none" style={{ display: 'block', marginTop: 24 }} aria-hidden>
      <path
        d="M0 28 Q12 10 24 28 Q36 10 48 28 Q60 10 72 28 Q84 10 96 28 Q108 10 120 28 Q132 10 144 28 Q156 10 168 28 Q180 10 192 28 Q204 10 216 28 Q228 10 240 28 Q252 10 264 28 Q276 10 288 28 Q300 10 312 28 Q324 10 336 28 Q348 10 360 28 Q372 10 384 28 Q396 10 400 24 L400 70 L0 70 Z"
        fill="#F3E7CD"
      />
      <path d="M200 30 a10 10 0 1 0 4 18 a13 13 0 1 1 -4 -18 Z" fill={GOLD} />
      <path d="M120 46 l1.6 3.6 l3.6 1.6 l-3.6 1.6 l-1.6 3.6 l-1.6 -3.6 l-3.6 -1.6 l3.6 -1.6 Z" fill={GOLD} />
      <path d="M285 44 l1.6 3.6 l3.6 1.6 l-3.6 1.6 l-1.6 3.6 l-1.6 -3.6 l-3.6 -1.6 l3.6 -1.6 Z" fill={GOLD} />
      <circle cx="60" cy="52" r="2.4" fill={GOLD} />
      <circle cx="340" cy="52" r="2.4" fill={GOLD} />
    </svg>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

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
        setBanner({ kind: 'earned', count: Number(data.count ?? 0), goal: Number(data.goal ?? 5) });
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
        return { text: `スタンプを1つ押しました🌙 あと${banner.goal - banner.count}個で無料券です`, tone: 'good' };
      case 'rewarded':
        return { text: `満杯です！バスクチーズケーキの無料券が${banner.rewardsPending}枚たまりました🎉`, tone: 'good' };
      case 'already':
        return { text: '本日はスタンプ済みです。またのご来店をお待ちしています🌙', tone: 'warn' };
      case 'redeemed':
        return { text: `無料券を1枚使用しました。残り${banner.rewardsPending}枚です`, tone: 'good' };
      case 'error':
        return { text: banner.message, tone: 'warn' };
    }
  })();

  const remaining = card ? Math.max(0, card.goal - card.count) : 0;

  return (
    <div style={{ background: PAGE, minHeight: '100vh', fontFamily: FONT, color: INK, display: 'flex', flexDirection: 'column' }}>
      <Defs />
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '20px 20px 8px', position: 'relative' }}>
        {/* logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
          <img src={LOGO} alt="YORU. SWEETS & BAR" style={{ width: 96, height: 'auto' }} />
        </div>

        {/* header: title + mascot */}
        <div style={{ position: 'relative', minHeight: 158 }}>
          <div style={{ position: 'relative', zIndex: 2, paddingRight: 96 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, letterSpacing: '.12em', color: LABEL, fontWeight: 800 }}>
                YORU. SWEETS &amp; BAR
              </span>
              <Sparkle size={13} />
            </div>
            <h1 style={{ fontSize: 34, margin: '6px 0 4px', fontWeight: 800, letterSpacing: '.01em' }}>スタンプカード</h1>
            {card?.displayName && (
              <p style={{ fontSize: 17, color: INK, margin: 0, fontWeight: 700 }}>
                {card.displayName} <span style={{ fontSize: 14, fontWeight: 500 }}>さん</span>
              </p>
            )}
          </div>
          <div style={{ position: 'absolute', top: 0, right: -6, zIndex: 1 }}>
            <Sparkle size={20} style={{ position: 'absolute', top: 4, left: -14 }} />
            <Sparkle size={12} style={{ position: 'absolute', top: 44, right: 0 }} />
            <img src={CANDLE_SIT} alt="" style={{ width: 110, height: 'auto', display: 'block' }} />
          </div>
        </div>

        {bannerText && (
          <div
            role="status"
            style={{
              marginTop: 6,
              marginBottom: 2,
              padding: '11px 14px',
              borderRadius: 12,
              fontSize: 13.5,
              lineHeight: 1.6,
              background: bannerText.tone === 'good' ? '#FBF0D4' : '#F3ECDD',
              border: `1.5px solid ${bannerText.tone === 'good' ? GOLD : '#E4D6B8'}`,
              color: '#6A5A34',
            }}
          >
            {bannerText.text}
          </div>
        )}

        {/* stamp card panel */}
        <div
          style={{
            marginTop: 14,
            background: CARD,
            borderRadius: 22,
            border: `2px solid ${CARD_BORDER}`,
            boxShadow: '0 6px 18px rgba(210,160,60,0.16)',
            padding: '22px 16px 20px',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 6,
              border: `1.5px solid #F0DFB4`,
              borderRadius: 17,
              pointerEvents: 'none',
            }}
          />
          {card ? (
            <div style={{ position: 'relative' }}>
              <Ribbon text="5つ貯めて無料券をGET！" />
              <StampRow count={card.count} goal={card.goal} />
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 14, marginTop: 6 }}>
                <span style={{ fontSize: 30, fontWeight: 800 }}>
                  {card.count} <span style={{ color: MUTED }}>/</span> {card.goal}
                  <span style={{ fontSize: 17 }}> 個</span>
                </span>
                {remaining > 0 && (
                  <span style={{ fontSize: 17, fontWeight: 700, color: '#6A5A34' }}>
                    あと <span style={{ color: ORANGE, fontSize: 24, fontWeight: 800 }}>{remaining}</span> 個で無料券
                  </span>
                )}
              </div>
              <div
                style={{
                  margin: '14px auto 2px',
                  maxWidth: 320,
                  background: PILL_BG,
                  color: PILL_TEXT,
                  borderRadius: 999,
                  padding: '9px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                <Sparkle size={12} color={GOLD} />
                {card.stampedToday ? '本日のスタンプは押し済みです' : '店内のQRコードを読み取ってください'}
                <Sparkle size={12} color={GOLD} />
              </div>
            </div>
          ) : (
            <p style={{ textAlign: 'center', color: MUTED, fontSize: 14, padding: '34px 0' }}>読み込み中...</p>
          )}
        </div>

        {/* reward voucher */}
        {card && card.rewardsPending > 0 && (
          <div
            style={{
              marginTop: 16,
              background: 'linear-gradient(135deg,#FBEFCF,#F6E1AE)',
              border: `2px solid ${GOLD}`,
              borderRadius: 18,
              padding: '18px 16px',
            }}
          >
            <p style={{ fontSize: 12, color: GOLD_DEEP, fontWeight: 800, margin: 0, letterSpacing: '.04em' }}>
              ご利用いただけます
            </p>
            <p style={{ fontSize: 20, fontWeight: 800, margin: '6px 0 0' }}>
              バスクチーズケーキ 無料券 ×{card.rewardsPending}
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.7, margin: '10px 0 0', color: '#6A5A34' }}>
              プレーン・キャラメルからお選びいただけます。ご注文時にこの画面をスタッフにお見せください。
            </p>
            <button
              type="button"
              onClick={() => void redeem()}
              disabled={busy}
              style={{
                width: '100%',
                marginTop: 14,
                padding: '13px',
                border: 'none',
                borderRadius: 12,
                background: busy ? '#C9B27C' : INK,
                color: '#FFF7E6',
                fontSize: 15,
                fontWeight: 800,
                fontFamily: 'inherit',
              }}
            >
              スタッフが使用する
            </button>
          </div>
        )}

        {/* usage */}
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FlameIcon size={20} />
            <span style={{ fontSize: 18, fontWeight: 800 }}>ご利用について</span>
            <span
              style={{
                flex: 1,
                borderBottom: `2px dotted ${GOLD}`,
                opacity: 0.6,
                marginLeft: 4,
                marginBottom: 4,
              }}
            />
          </div>
          <div
            style={{
              marginTop: 12,
              background: '#FFFDF8',
              border: `1.5px solid #F0E6CE`,
              borderRadius: 16,
              padding: '14px 16px',
              position: 'relative',
            }}
          >
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 14.5, lineHeight: 1.95, color: '#4A4033' }}>
              {[
                'ご来店1回につきスタンプ1つ（1日1回まで）',
                'スタンプ5つでバスクチーズケーキが1つ無料',
                '無料券に有効期限はありません',
                '満杯になるとカードは自動でリセットされ、また1つ目から貯まります',
              ].map((t, i, arr) => (
                <li
                  key={t}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    paddingRight: i >= arr.length - 1 ? 78 : 0,
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: GOLD,
                      flex: '0 0 auto',
                      marginTop: 9,
                    }}
                  />
                  <span>{t}</span>
                </li>
              ))}
              {card && card.rewardsTotal > 0 && (
                <li style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 4 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: ORANGE, flex: '0 0 auto', marginTop: 9 }} />
                  <span>これまでに獲得した無料券：{card.rewardsTotal}枚</span>
                </li>
              )}
            </ul>
            <div style={{ position: 'absolute', right: 8, bottom: 4 }}>
              <img src={CANDLE_RUN} alt="" style={{ width: 68, height: 'auto', display: 'block' }} />
            </div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 'auto' }}>
        <ScallopFooter />
      </div>
    </div>
  );
}

export function mountStampCard(container: HTMLElement, ctx: StampCardContext): void {
  createRoot(container).render(<StampCard ctx={ctx} />);
}

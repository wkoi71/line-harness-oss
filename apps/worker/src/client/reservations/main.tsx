import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useState } from 'react';

/**
 * 予約の確認とキャンセル（`?page=reservations`）。
 *
 * 公式アカウントは個別のメッセージを受け付けない運用なので、お客様が自分で
 * 予約を取り消せる場所はここだけになる。キャンセルは取り消せないうえ、
 * 押した結果は「席が空く」という店側の実害に直結するので、
 * 何が消えるのかを画面に出したうえで確認を挟む。
 *
 * 配色と角丸はスタンプカード画面（client/stamp-card/main.tsx）に合わせている。
 * お客様から見ると同じ「YORU.のLINE画面」なので、別物に見えないほうがよい。
 */

export interface ReservationsContext {
  idToken: string;
}

interface Reservation {
  id: string;
  startsAt: string;
  visitDate: string;
  visitTime: string;
  people: number;
  customerName: string;
  occasion: string | null;
  notes: string | null;
}

const PAGE = '#FBF6EA';
const CARD = '#FCFAF3';
const GOLD = '#EAA93C';
const GOLD_DEEP = '#CE8E1E';
const INK = '#2B2620';
const MUTED = '#A99C84';
const RING = '#E6DAC0';
const DANGER = '#C2453B';
const FONT = "'Hiragino Maru Gothic ProN','Hiragino Sans','Yu Gothic',system-ui,sans-serif";

const TEL = '050-3092-1762';

/**
 * 応答が返らないまま放置しない。
 *
 * 予約の読み込みは id_token の検証でLINEのAPIを1本挟むので、そこが詰まると
 * 画面が「読み込み中…」のまま無言で止まる。お客様から見ると壊れているのか
 * 待てばいいのか分からないので、打ち切ってお電話に案内する。
 */
const TIMEOUT_MS = 15000;

async function api(path: string, idToken: string, body?: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    clearTimeout(timer);
  }
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * `2026-08-07T24:00` → `8月7日(金) 24:00`。
 *
 * 24時台はカレンダー上は翌0時だが、お客様にとっては「金曜の夜」なので、
 * 曜日は予約した日のまま出す。ここで翌日に繰り上げると「土曜で取ったのに
 * 金曜と書いてある」と逆に混乱する。
 */
function formatWhen(r: Reservation): string {
  const m = r.visitDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return `${r.visitDate} ${r.visitTime}`;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const time = r.startsAt.slice(11);
  return `${Number(m[2])}月${Number(m[3])}日(${WEEKDAYS[d.getDay()]}) ${time}`;
}

function ReservationsApp({ ctx }: { ctx: ReservationsContext }) {
  const [items, setItems] = useState<Reservation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api('/api/liff/reservations/me', ctx.idToken);
      if (!res.ok) {
        setItems([]);
        setError(
          res.status === 503
            ? 'ただいまこの画面はご利用いただけません。お手数ですがお電話ください。'
            : '予約の読み込みに失敗しました。時間をおいてお試しください。',
        );
        return;
      }
      const data = (await res.json()) as { reservations: Reservation[] };
      setItems(data.reservations ?? []);
    } catch (e) {
      setItems([]);
      setError(
        (e as { name?: string })?.name === 'AbortError'
          ? `読み込みに時間がかかっています。電波の良い場所でお試しいただくか、${TEL} までお電話ください。`
          : '通信に失敗しました。電波の良い場所でお試しください。',
      );
    }
  }, [ctx.idToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = useCallback(
    async (r: Reservation) => {
      const when = formatWhen(r);
      if (
        !window.confirm(
          `${when} ／ ${r.people}名 のご予約をキャンセルします。\n\n` +
            'この操作は取り消せません。よろしいですか？',
        )
      ) {
        return;
      }
      setBusyId(r.id);
      setError(null);
      try {
        const res = await api(`/api/liff/reservations/${r.id}/cancel`, ctx.idToken, {});
        if (res.ok) {
          setDone(when);
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(
            body.error === 'already_gone'
              ? 'このご予約はすでにキャンセルされているようです。ご不明な点はお電話ください。'
              : `キャンセルできませんでした。お手数ですが ${TEL} までお電話ください。`,
          );
        }
      } catch {
        setError(`キャンセルできませんでした。お手数ですが ${TEL} までお電話ください。`);
      }
      await load();
      setBusyId(null);
    },
    [ctx.idToken, load],
  );

  return (
    <div style={{ minHeight: '100vh', background: PAGE, fontFamily: FONT, color: INK, padding: '20px 16px 40px' }}>
      <p style={{ fontSize: 12, color: GOLD_DEEP, fontWeight: 800, letterSpacing: '.14em', margin: 0 }}>
        YORU. SWEETS &amp; BAR
      </p>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: '6px 0 0' }}>ご予約の確認</h1>
      <p style={{ fontSize: 13.5, color: MUTED, margin: '6px 0 0', lineHeight: 1.7 }}>
        キャンセルはこの画面からできます。日時のご変更は、お手数ですがキャンセルのうえ取り直してください。
      </p>

      {done && (
        <div
          style={{
            marginTop: 16,
            background: '#EAF6EC',
            border: '1.5px solid #9CCBA5',
            borderRadius: 14,
            padding: '14px 16px',
            fontSize: 14,
            lineHeight: 1.7,
          }}
        >
          {done} のご予約をキャンセルしました。
          <br />
          またのご利用をお待ちしています🌙
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 16,
            background: '#FBECEA',
            border: `1.5px solid ${DANGER}`,
            borderRadius: 14,
            padding: '14px 16px',
            fontSize: 14,
            lineHeight: 1.7,
            color: '#7A2B24',
          }}
        >
          {error}
        </div>
      )}

      {items === null && <p style={{ marginTop: 24, fontSize: 14, color: MUTED }}>読み込み中…</p>}

      {items !== null && items.length === 0 && !error && (
        <div
          style={{
            marginTop: 20,
            background: CARD,
            border: `1.5px solid ${RING}`,
            borderRadius: 18,
            padding: '26px 18px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>今後のご予約はありません</p>
          <p style={{ fontSize: 13, color: MUTED, margin: '10px 0 0', lineHeight: 1.7 }}>
            すでにお済みのご予約や、キャンセルされたご予約は表示されません。
          </p>
        </div>
      )}

      {items?.map((r) => (
        <div
          key={r.id}
          style={{
            marginTop: 16,
            background: CARD,
            border: `1.5px solid ${RING}`,
            borderRadius: 18,
            padding: '18px 16px',
          }}
        >
          <p style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>{formatWhen(r)}</p>
          <p style={{ fontSize: 15, fontWeight: 700, color: GOLD_DEEP, margin: '4px 0 0' }}>
            {r.people}名 ／ {r.customerName} 様
          </p>
          {r.occasion && (
            <p style={{ fontSize: 13, color: MUTED, margin: '8px 0 0' }}>ご利用シーン：{r.occasion}</p>
          )}
          {r.notes && <p style={{ fontSize: 13, color: MUTED, margin: '4px 0 0' }}>ご要望：{r.notes}</p>}

          <button
            type="button"
            disabled={busyId !== null}
            onClick={() => void cancel(r)}
            style={{
              marginTop: 16,
              width: '100%',
              padding: '13px 0',
              borderRadius: 999,
              border: `1.5px solid ${DANGER}`,
              background: busyId === r.id ? '#EDD9D6' : '#fff',
              color: DANGER,
              fontSize: 15,
              fontWeight: 800,
              fontFamily: FONT,
              opacity: busyId !== null && busyId !== r.id ? 0.5 : 1,
            }}
          >
            {busyId === r.id ? 'キャンセルしています…' : 'このご予約をキャンセルする'}
          </button>
        </div>
      ))}

      <div
        style={{
          marginTop: 24,
          background: '#FFFDF8',
          border: `1.5px solid #F0E6CE`,
          borderRadius: 16,
          padding: '14px 16px',
          fontSize: 13,
          lineHeight: 1.9,
          color: '#4A4033',
        }}
      >
        <p style={{ margin: 0, fontWeight: 800, color: GOLD_DEEP }}>ご注意</p>
        <p style={{ margin: '6px 0 0' }}>・キャンセル料はいただいておりません</p>
        <p style={{ margin: 0 }}>・お時間を過ぎたご予約はこの画面に出ません</p>
        <p style={{ margin: 0 }}>・貸切など、お電話でお取りしたご予約は表示されません</p>
        <a
          href={`tel:${TEL.replace(/-/g, '')}`}
          style={{
            display: 'block',
            marginTop: 12,
            padding: '12px 0',
            borderRadius: 999,
            background: GOLD,
            color: '#fff',
            fontSize: 15,
            fontWeight: 800,
            textAlign: 'center',
            textDecoration: 'none',
          }}
        >
          お店に電話する（{TEL}）
        </a>
      </div>
    </div>
  );
}

export function mountReservations(container: HTMLElement, ctx: ReservationsContext): void {
  createRoot(container).render(<ReservationsApp ctx={ctx} />);
}

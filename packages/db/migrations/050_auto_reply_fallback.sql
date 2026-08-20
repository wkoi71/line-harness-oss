-- 050: auto_replies に「受け皿」フラグを追加
--
-- 背景: LINE 公式アカウント側の「応答メッセージ」は Webhook と同時に発火するため、
-- キーワード自動返信と 2 通並んでしまう。公式側をオフにすれば重複は消えるが、
-- 今度はどのキーワードにも当たらない自由文が完全に無反応になる。
-- その受け皿を自前側に持つための列。
--
-- is_fallback = 1 の行はキーワード照合の対象外 (webhook.ts のテキスト/postback 経路)。
-- どのルールにもマッチしなかったテキストのときだけ、1 通だけ返信に使われる。
ALTER TABLE auto_replies ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0;

-- 受け皿はアカウントごとに数行しかない。無マッチ時の 1 クエリだけが使う部分インデックス。
CREATE INDEX IF NOT EXISTS idx_auto_replies_fallback
  ON auto_replies(line_account_id, created_at)
  WHERE is_fallback = 1;

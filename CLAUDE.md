# LINEharness - Claude Code 作業指示書

## 最初にやること（必須）

作業を始める前に、必ずNotionのLINEharnessDBを確認してから着手すること。

- LINEharnessDB URL: https://app.notion.com/p/37f5f6d272cb805bb63ddfa28a745627?v=cff5f6d272cb83bd902e083a094d9eee

確認する内容：
- ステータスが「進行中」のタスク
- 前回の中断ポイント・次のアクション
- 関連する設計決定・地雷メモ

---

## 環境情報

| 項目 | 値 |
|---|---|
| Worker URL | https://line-harnes.umiumi32425.workers.dev |
| Worker名 | line-harnes（sが1つ、重要） |
| LINE Channel ID | 2009952991 |
| LINEアカウントID | 38e79da1-62c1-4bee-9249-d64d12202f56 |
| 管理画面 | https://line-harnes-admin-a07d1ef5.pages.dev |
| API Key | a07d1ef541b3a5e1288de8f6f3285110db8a153bab4ace9ba44b2c190086790a |
| リポジトリ | line-harness-oss（GitHub） |
| 作業ディレクトリ | apps/worker |

---

## デプロイコマンド（必須）

cd apps/worker
npx wrangler deploy --config wrangler.toml --env production --name line-harnes

⚠️ --name line-harnes を必ず明示すること。
wrangler.tomlの [env.production] に name フィールドがないため、省略するとトップレベル設定（テスト環境）に誤デプロイされる。

---

## 地雷メモ（必読）

### SQLをwranglerで実行する時
--command のインライン指定は禁止。JSONを含むSQLはPowerShellの引用符処理で壊れる。

必ず --file 経由で実行する：
1. 一時SQLファイルを作成
2. wrangler d1 execute --remote --file=fix.sql で実行
3. 実行後にファイルを削除

### D1バインディングについて
wrangler.toml の [env.production] のD1 IDが実態と逆になっている可能性あり。
--name line-harnes で明示指定すれば回避できる。

### GitHubとデプロイ済みコードの乖離に注意
wrangler deploy はgit pushなしで直接Cloudflareにデプロイできる。
コード修正後は必ず git push origin main も実行すること。

### Cronとwebhookの配信タイミングの違い
- friend_add トリガー → webhook経由で即時配信
- tag_added トリガー → Cron経由（最大5分のタイムラグ）※即時配信化済み（Version ID: 37e11a70）

---

## 現在の残タスク（最終更新：2026/06/22）

最新情報は必ずNotionで確認すること。以下はあくまで参考。

### 🔴 最優先
- line_accounts テーブルが空（0件）のためWMが届かない
  - Channel ID: 2009952991、Channel Secret、Access Tokenを登録する
  - 管理画面 or 直接SQL INSERTで対応

### 🟡 中優先
- tag_added即時配信化の実機テスト（重複送信バグ修正後の検証）
- automation経由送信の messages_log 記録欠落バグ調査（wrangler tail で捕捉）

### 🟢 低優先
- wrangler.toml のD1バインディング修正
- WORKER_NAME / WORKER_PUBLIC_URL プレースホルダー修正

---

## 作業後にやること

作業を終えたら、Claude chat（claude.ai）側に結果を報告する。
Notionへの書き戻しはClaude chatが担当する。

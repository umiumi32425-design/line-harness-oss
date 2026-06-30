# LINEharness - Claude Code 作業指示書

## 最初にやること（必須）

作業を始める前に、必ずNotionのLINEharnessDBを確認してから着手すること。

- 現在のタスク（設計・開発）固定ページ: https://app.notion.com/p/38f5f6d272cb81abb2fed2012dcad790
  ※新規ページは作らず、毎回このページの中身を上書き更新すること
  ※ミス記録・データ記録などの蓄積型ログは従来通り別途タグ付きページを作成してよい

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
~~wrangler.toml の [env.production] のD1 IDが実態と逆になっている可能性あり。~~
✅ 2026/06/28 修正済み：[env.production.d1_databases] を line-harnes (f3815c86) に修正。
--name line-harnes で明示指定すれば回避できる（念のため継続）。

### GitHubとデプロイ済みコードの乖離に注意
wrangler deploy はgit pushなしで直接Cloudflareにデプロイできる。
コード修正後は必ず git push origin main も実行すること。

### Cronとwebhookの配信タイミングの違い
- friend_add トリガー → webhook経由で即時配信
- tag_added トリガー → event-bus.ts の add_tag ケースで即時配信（✅ 2026/06/28 claimステップ不一致バグ修正済み）
  - enrollFriendInScenario は current_step_order=-1 で初期化するため、claim時も -1 を渡す必要がある

### claimFriendScenarioForDelivery の仕様
event-bus.ts でシナリオ即時配信を行う際、`claimFriendScenarioForDelivery(db, id, -1)` と必ず -1 を渡すこと。
firstStep.step_order（=1など）を渡すと常に不一致でCron頼みになる。

---

## 作業後にやること

作業を終えたら、Notionの「現在のタスク（設計・開発）」固定ページを直接更新する（新規ページは作らない）。
- 完了したタスクは「直近の完了事項」に追記し、対応する「進行中・未着手タスク」の項目を削除する
- 新しい決定・中断ポイントがあれば即座に反映する
更新後、Claude chat（claude.ai）側にも作業結果を一言報告する（任意。固定ページを見れば状況は分かるため必須ではない）。

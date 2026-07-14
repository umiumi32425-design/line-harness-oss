# 流入経路ごとのWM出し分け設計 - 事前調査

- 調査日: 2026-07-14
- 目的: 7/15の設計セッションに向けた現状把握（実装・変更は行っていない）
- 対象リポジトリ: line-harness-oss

---

## 調査1: 現状のウェルカムシナリオ構造の棚卸し

### WM配信の起点（LINE `follow` webhook）

`apps/worker/src/routes/webhook.ts` の `event.type === 'follow'` ブロック（148〜321行目付近）が起点。

処理順序:

1. `upsertFriend` で `friends` レコードを作成/更新（168行目付近）
2. `friend.ref_code` を読み取り、`entry_routes` をrefCodeで検索（`getEntryRouteByRefCode`、200〜202行目）
3. **ゲーティングロジック**（203〜204行目）:
   ```ts
   const runAccountScenarios =
     !referralRoute || referralRoute.run_account_friend_add_scenarios !== 0;
   ```
4. **アカウント共通WMの列挙**（208〜209行目、コメントも実装込み）:
   ```ts
   // getActiveFriendAddScenarios filters is_active=1, trigger_type='friend_add', and account in SQL.
   const scenarios = runAccountScenarios ? await getActiveFriendAddScenarios(db, lineAccountId) : [];
   ```
5. `entry_routes.scenario_id` / `intro_template_id` があれば、上記とは別に追加のシナリオ登録・即時push（293〜317行目）。ただし `entry_routes.tag_id` はfollow webhook内では**一切参照されない**（後述）。
6. 最後に汎用イベントバスへ `friend_add` イベントを発火（320行目）。

### 「trigger_tagなしで全員同じWMが届く」の根拠

`packages/db/src/scenarios.ts:73-103` の `getActiveFriendAddScenarios` が実体:

```sql
SELECT s.id, s.name, ..., s.trigger_tag_id, ...
FROM scenarios s
WHERE s.is_active = 1
  AND s.trigger_type = 'friend_add'
  AND (s.line_account_id IS NULL OR s.line_account_id = ?)
ORDER BY s.created_at DESC
```

`trigger_tag_id` はSELECT句には含まれているが、**WHERE句では一切使われていない**。つまり `trigger_type = 'friend_add'` のシナリオは、`line_account_id` が一致（またはNULL＝アカウント非依存）する限り、新規友だち全員に無条件で列挙・登録される。`trigger_tag_id` はこのトリガー種別では実質的に無視されるデッドカラムになっている（`tag_added` 系の判定でのみ使われる。調査3参照）。

現状、新規友だちのWM出し分けが実現できている唯一の経路は `entry_routes.scenario_id` と `run_account_friend_add_scenarios` のオーバーライドのみで、`trigger_tag_id` 経由ではない。

### automations（別系統のIF-THENエンジン）との違い

`apps/worker/src/services/event-bus.ts` の `automations` テーブル（`packages/db/schema.sql:551-566`）は、`scenarios`（WM配信の実体）とは**別物**の汎用条件分岐エンジン。`event_type` + `conditions`(JSON) + `actions`(JSON) を持ち、`conditions.refCode` の完全一致条件をサポートしている（event-bus.ts:230-234）。

ただし、これは automations（タグ付与や個別メッセージ送信などのアクション実行）の話であり、**「WM」として捉えているscenarios経由の配信にはrefCode条件が存在しない**。この2系統を混同しないよう注意が必要。

### WM配信・イベント登録のトリガーになるイベント一覧

`fireEvent` の呼び出し箇所から確認できるイベント種別:

| event_type | 発火箇所 | 内容 |
|---|---|---|
| `friend_add` | `webhook.ts:320`（followイベント） | 新規友だち追加 |
| `tag_change` | `friends.ts:448,466` / `friend-tag-attach.ts:45` | タグ追加・削除（automations向け） |
| `cv_fire` | `stripe.ts:149` | Stripe決済成功 |
| `message_received` | `webhook.ts:611` | LINEメッセージ受信 |
| （カスタム） | `webhooks.ts:373` | 外部webhook経由の任意イベント種別 |

なお `scenarios.trigger_type = 'tag_added'` は上記の `automations` イベントとは別立てで、`friends.ts:436` / `event-bus.ts:265,400` / `friend-tag-attach.ts:31` の各所で直接 `trigger_tag_id` と比較するハードコードされた分岐になっている（automationsテーブルを経由しない）。

---

## 調査2: refCodeの一覧化

### スキーマ

**`packages/db/migrations/003_entry_routes.sql`**（refCode関連の最初期マイグレーション。作業指示書メモにある「038 entry_routes列追加」は本調査で該当ファイル名としては見つからず、実際に相当するのは後述の038番だが内容は列追加のみで、テーブル自体は003で作成済み）:

```sql
CREATE TABLE IF NOT EXISTS entry_routes (
  id          TEXT PRIMARY KEY,
  ref_code    TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  redirect_url TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entry_routes_ref ON entry_routes (ref_code);

CREATE TABLE IF NOT EXISTS ref_tracking (
  id              TEXT PRIMARY KEY,
  ref_code        TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends (id) ON DELETE CASCADE,
  entry_route_id  TEXT REFERENCES entry_routes (id) ON DELETE SET NULL,
  source_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ref_tracking_ref    ON ref_tracking (ref_code);
CREATE INDEX IF NOT EXISTS idx_ref_tracking_friend ON ref_tracking (friend_id);

ALTER TABLE friends ADD COLUMN ref_code TEXT;
```

**`packages/db/migrations/038_entry_routes_pool_and_push.sql`**（列追加のみ）:

```sql
-- Add pool_id (送り先 Pool), intro_template_id (即時 push テンプレ),
-- run_account_friend_add_scenarios (アカウント標準 friend_add シナリオ併走フラグ).
ALTER TABLE entry_routes ADD COLUMN pool_id TEXT REFERENCES traffic_pools (id) ON DELETE SET NULL;
ALTER TABLE entry_routes ADD COLUMN intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL;
ALTER TABLE entry_routes ADD COLUMN run_account_friend_add_scenarios INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_entry_routes_pool ON entry_routes (pool_id);
```

**`tracked_links`テーブル**（`migrations/006_tracked_links.sql`、以降 020/021/042で列追加）:

```sql
CREATE TABLE IF NOT EXISTS tracked_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_url TEXT NOT NULL,
  tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS link_clicks (
  id TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
（042で `og_title` / `og_description` / `og_image_url` を追加。migration 042はOGP関連であり、本題のrefCode設計とは直接関係しない。）

### 発行・付与・参照の経路

- **短縮リンク経路**: `/r/:ref`（`apps/worker/src/index.ts:205`）でランディングページを表示。`/r/:ref/help`（同380行目）は導線が詰まったユーザー向けの復帰導線。
- **LIFF/OAuth経由のクエリパラメータ**: `apps/worker/src/routes/liff.ts:306-318, 521-535` で `ref`, `redirect`, `form`, `gclid`, `fbclid`, `twclid`, `ttclid`, `utm_source`, `utm_medium`, `utm_campaign`, `account`, `uid`, `ig`, `pool`, `gate`, `xh`（X-Harness用ワンタイムトークン、`ref_code`としては保存されない）を受け取る。
- **`/auth/callback`**（liff.ts:590〜）: LINEログインの `state` パラメータ（base64 JSON）に上記属性一式を積んで往復させ、コールバック側で復元。

### 保存先

- `friends.ref_code`（マイグレーション003で追加した単一カラム）。書き込みは「ファーストタッチ勝ち」方式:
  ```ts
  // liff.ts:763-769
  if (ref && !ref.startsWith('xh:')) {
    await db
      .prepare(`UPDATE friends SET ref_code = ? WHERE id = ? AND ref_code IS NULL`)
      .bind(ref, friend.id)
      .run();
  ```
  同様のパターンが `liff.ts:1184`、`liff.ts:1256` にも存在。`xh:` プレフィックスのワンタイムトークンは明示的に除外される。
- **`ref_tracking`テーブル**: クリックレベルの全ログ（`entry_route_id`、各種UTM/クリックID、`user_agent`、`ip_address`）。書き込みは `recordRefTracking`（`packages/db/src/entry-routes.ts:220-272`）。
- **followイベント時の参照**: `webhook.ts:188-209`（調査1参照）。
- **LIFF経路での参照**: `applyRefAttribution()`（`liff.ts:113-134`）が `entry_routes` → 見つからなければ `tracked_links` の順でフォールバックし、`tag_id`/`scenario_id` を統一的に適用:
  ```ts
  // liff.ts:129-130
  const effectiveTagId = route?.tag_id ?? trackedLink?.tag_id ?? null;
  const effectiveScenarioId = route?.scenario_id ?? trackedLink?.scenario_id ?? null;
  ```
  **注意**: この `applyRefAttribution()` はLIFF/OAuth経路でのみ呼ばれ、素のLINE `follow` webhook（QRコードや友だち追加リンクから直接追加された場合）では呼ばれない。つまり `entry_routes.tag_id` は現状、LIFF経由の友だち追加以外では実質適用されていない可能性が高い（要7/15確認）。

`friends.metadata`（JSON）カラムは refCode 保存には使われておらず、専用カラム（`friends.ref_code`）が使われている。

### 実際に運用中のrefCode

リポジトリ内（migrations・src・テスト）に **ハードコードされたrefCode文字列は存在しない**（`ref_code = '...'` 等のパターンで全文検索してもヒットなし）。refCodeは管理画面「流入リンク」ページ（`apps/web/src/app/inflow-links/page.tsx`）から運用者が都度発行する運用で、固定・シードされたコード一覧は無い:

```ts
// apps/web/src/app/inflow-links/page.tsx:133
const url = `${WORKER_BASE}/r/${refCode}`
```

未登録のrefCode（`ref_tracking`に履歴だけあるもの）を後から`entry_routes`として登録するUIも存在する（同ファイル62-63行目コメント）。

**→ 実際に運用中の具体的なrefCode値はコード上からは特定できない。D1の`entry_routes`テーブルを直接確認する必要がある（本調査ではwrangler経由のリモートDB参照は行っていない）。**

---

## 調査3: 必要なタグ設計の叩き台

### 既存タグ体系のスキーマ

`packages/db/schema.sql:28-45`:

```sql
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3B82F6',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS friend_tags (
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_tags_tag_id ON friend_tags (tag_id);
```

`friend_id` + `tag_id` の複合主キーによる典型的な多対多。`tags.name` はアカウント非依存でグローバルにUNIQUE。友だち側にタグ名文字列カラムがあるわけではない。

**衝突リスクの確認**: refCode→専用タグという新構造は、既存の `friend_tags` の構造（多対多、名前グローバルユニーク）とは技術的に衝突しない。ただし `tags.name` がアカウント非依存でユニークなため、複数LINEアカウントを運用している場合に「同じrefCode名のタグ」を作ろうとすると名前衝突が起きうる（例: `ref:instagram` のようなタグ名を複数アカウントで使い回せない）。命名規則（アカウントプレフィックス付与など）の検討が必要。

### タグ付与・tag_addedトリガーの実装箇所

- `POST /api/friends/:id/tags`（`friends.ts:421-455`）: `addTagToFriend` → `tag_added`シナリオ登録ロジックを直接インライン実装（434-445行目）→ `fireEvent(db, 'tag_change', ...)`（448行目、automations向け）
- `DELETE /api/friends/:id/tags/:tagId`（`friends.ts:458-469`）
- automationsアクション `add_tag`（`event-bus.ts:252-415`）: 同様の `tag_added` シナリオ登録ロジックを**別途複製実装**（262-393行目）
- 共通ヘルパー `attachTagAndFireSideEffects`（`friend-tag-attach.ts:13-47`）: メニュー自動タグ（migration 045）などシステム経由の付与で使用。`INSERT OR IGNORE ... RETURNING changes` で初回付与時のみ副作用を発火するガード付き
- `applyRefAttribution()`（`liff.ts:113-134`）: LIFF経路でのrefCode由来タグ付与

**`tag_added`判定は3箇所（`friends.ts:436`、`event-bus.ts:265,400`、`friend-tag-attach.ts:31`）に同一ロジックが複製されている**:
```ts
scenario.trigger_type === 'tag_added' && scenario.is_active === 1 && scenario.trigger_tag_id === tagId
```

### 想定される変更箇所（選択肢の整理・設計は未確定）

**パターンA: refCode専用タグ + 既存tag_addedトリガーをそのまま使う**
- 変更点: refCode発行時（または follow webhook 内で）該当タグを `friend_tags` に付与するロジックを追加。WM側は `scenarios.trigger_type='tag_added'` + `trigger_tag_id` で新規automation/scenario作成のみで対応可能。
- メリット: 既存の `tag_added` 実行経路（3箇所）をそのまま使い回せる。DBスキーマ変更が最小（新規タグレコードの追加のみ）。
- デメリット: `tag_added`判定ロジックが3箇所に重複している現状の技術的負債をそのまま引き継ぐ。将来的なメンテナンス性は低い。また、LIFF経由以外（素のfollow webhook）でrefCode→タグ付与を行うには、`webhook.ts`のfollowハンドラに新規ロジック追加が必須（現状は `applyRefAttribution` を呼んでいないため）。

**パターンB: entry_routes.tag_id を素のfollow webhookでも適用するよう修正**
- 変更点: `webhook.ts`のfollowハンドラ内（203〜290行目付近）で、`referralRoute.tag_id` があれば `addTagToFriend` を呼ぶよう追加。合わせて `tag_added` シナリオの列挙・登録も同じハンドラ内で行う。
- メリット: 既存の `entry_routes` テーブル・管理画面（流入リンクUI）をそのまま活用でき、refCodeとタグの紐付けが一元管理される。LIFF経由・非LIFF経由（QRコード直遷移など）両方で一貫した挙動になる。
- デメリット: `run_account_friend_add_scenarios` との相互作用（両方併走した場合の配信順序・重複登録）を再設計する必要がある。既存の「アカウント共通WM」の挙動に影響が及ぶため、リグレッションテストの範囲が広がる。

**パターンC: automationsテーブルのrefCode条件（既存機能）をWM配信にも使えるよう拡張**
- 変更点: `automations`（`event_type='friend_add'`, `conditions.refCode`）を使い、アクションとして`start_scenario`相当の新規アクションタイプを追加。
- メリット: タグを経由せずrefCode直接分岐ができ、タグ体系を汚さない。
- デメリット: 現状 `executeAction` に `start_scenario` 系のアクションタイプが存在するか要確認（本調査では未確認）。automationsとscenarios/WMの責務が混ざり、2系統のIF-THENエンジンが並存する複雑さが増す。

いずれのパターンも、**タグ付与ロジックの重複排除（`attachTagAndFireSideEffects`への統一)** を並行して検討する価値がある。

---

## 7/15の設計セッションで判断すべき論点リスト

- `entry_routes.tag_id` を素のLINE `follow` webhook（QRコード等、LIFFを経由しない友だち追加）でも適用するか。現状はLIFF/OAuth経由でしか効かない（`applyRefAttribution`未呼び出し）。
- refCode→タグ→tag_addedトリガーの新構造を導入する場合、パターンA/B/Cのどれを採用するか（上記メリデメ参照）。
- `tags.name` がアカウント非依存でグローバルユニークな制約の下、複数LINEアカウント運用時のrefCode専用タグの命名規則をどうするか。
- `tag_added`判定ロジックが3箇所（`friends.ts`, `event-bus.ts`×2, `friend-tag-attach.ts`）に重複している現状を、新規実装のタイミングで統一するか、それとも別タスクとして切り離すか。
- `run_account_friend_add_scenarios` フラグと新設するrefCode専用WM（tag_addedベース）が両方有効な場合の配信順序・重複配信の扱いをどう定義するか。
- ~~現在D1の`entry_routes`に実際何件・どのrefCodeが登録されているか（本調査ではコード上のみ確認、リモートDBは未参照）。~~ **✅ 2026/07/14 本番D1（読み取り専用SELECT）で確認済み。以下の追記を参照。**

### 論点6 追記（2026/07/14 本番D1確認結果）

本番D1（`line-harnes`, `--env production --remote`）に対し、SELECTのみのクエリで以下を確認した（書き込みは一切行っていない）。

| テーブル | 件数 | 備考 |
|---|---|---|
| `entry_routes` | **0件** | `SELECT * FROM entry_routes` / `COUNT(*)` とも0。登録済みrefCodeなし |
| `tracked_links` | **0件** | フォールバック先も0件 |
| `ref_tracking` | **0件** | クリック履歴ログも0件 |
| `friends.ref_code IS NOT NULL` | **0件**（`GROUP BY ref_code`で0行） | 実際にrefCode付きで流入した友だちも現状ゼロ |

**結論**: refCode関連のテーブル・カラムはスキーマ上は用意されているが、**本番では現時点で一切データが投入されていない（グリーンフィールド状態）**。既存データとの後方互換や移行を気にする必要はなく、7/15の設計セッションでは「ゼロから作る前提」で構造を決めてよい。逆に言うと、`entry_routes.tag_id`が実運用でどう機能するかの実績データも存在しないため、パターンB（follow webhookでの`entry_routes.tag_id`適用）を採用する場合は実データでの検証ができておらず、設計段階でのレビューがより重要になる。
- automationsテーブルの`conditions.refCode`条件は`friend_add`イベントに対して使えるが、これは「アクション実行」であり「シナリオ（WM）配信」とは別エンジンである点を設計上どう整理するか（2系統併存を許容するか、将来的に統合するか）。

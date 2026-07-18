# CAST MANAGER WEB

ナイトクラブ・キャバレー向けキャスト管理システムのWeb版（Next.js + Firebase）。

既存のローカルHTML版（cast-manager-v2/index.html）を段階的に移行するプロジェクトです。

**実装状況:**
- PR1: 認証・承認・権限基盤・ユーザー管理・Firestore Rules
- PR2: 店舗マスター・キャスト一覧・キャスト登録/編集/アーカイブ・キャスト詳細
- PR3: 月別成績・推移グラフ8種・面談・目標・モチベーション・時給履歴
- PR3.5: ダッシュボード集計・ランキング7カテゴリ・検索対象修正・自動計算表示・面談編集（このzip）
- PR4以降（未実装）: Excelインポート・旧ローカルデータ移行・Excelエクスポート・完全削除

**PR3.5で追加された機能（既存ローカル版の仕様を移植）:**
- `/dashboard` 全面実装 — 在籍人数/今月売上(前月比)/平均時給(月・年)/平均実質時給/総支給額/本指名/顧客数/場内/同伴/出勤/給与差額・時給差額(合計・平均)/年間累計、平均時給の直近12ヶ月推移グラフ、面談アラート(30日以上or未面談・優先度ソート)、フォロー必要度「高」、次回面談予定(7日以内)、目標達成状況、今月・来月の誕生日
- `/ranking` — 旧版7カテゴリ(売上/指名/同伴/場内/出勤日数/出勤時間/実質時給)TOP15、重複排除・key>0のみ・降順は旧版と同一、同値時はcastIdで安定ソート、名前タップで詳細へ
- キャスト検索対象を旧版準拠に修正（源氏名・本名・メモ・担当者＋ふりがな、NFKC正規化）
- 月別成績フォームに自動計算パネル（給与差額/時給差額/実質時給/推定時間/日割平均/目標・下限ライン。保存データと同一の計算関数を使用）
- 面談記録の編集（競合検知付き。目標・モチベーションは重複作成防止のため編集対象外）

**PR3.5の実装メモ:**
- ダッシュボード集計は `src/lib/dashboard.ts` の純関数群に分離（旧版renderDashboardの式を移植・28ケースの一致テスト済み）
- 旧版の `wageHistory12 = genMonthRange().slice(-12)` は12〜23ヶ月前を取得する齟齬があったため、意図（直近12ヶ月・古→新）側を正として移植
- モチベアラート判定は旧版の「低い/注意」を新データ形式（"2:低い"等）へ適合（「低い」を含むかで判定）
- ダッシュボードは閲覧可能店舗の全成績を購読するため、データ量増大時は期間絞り込みの最適化を検討（残課題）

**PR3で追加された機能（既存ローカル版の仕様を移植）:**
- `/monthly` 月別成績ページ — 列順・計算式・総売上降順・目標達成の緑表示・出勤時間の`h*`推定表示まで既存版と同一。行タップでキャスト詳細へ遷移（既存版の不具合を修正）
- キャスト詳細に追加: 今月売上/年間売上/年間本指名/データ月数のサマリー、推移グラフ8種（売上・本指名本数・本指名組数・場内・同伴・出勤日数・給与差額・時給差額 / 直近12ヶ月・古い月→新しい月 / 売上グラフに目標ライン=時給×225・下限ライン=時給×90）、月別成績一覧、面談履歴、目標、モチベーション、時給履歴
- 面談記録フォームは既存版と同じ統合方式（面談＋目標＋モチベーションを1フォームで同時保存）
- 時給変更は wageHistory（追記のみ）へ記録し、キャストの時給も同時更新
- 月別成績のドキュメントIDは `{storeId}_{castId}_{YYYY-MM}` で月重複を構造的に防止。既存データがある場合は既存版と同じ「上書きしますか？」確認

**維持している計算式（変更禁止・既存版と同一）:**
- 給与差額 `payDiff = round(総売上 − 支給額)`
- 時給差額 `wageDiff = round(総売上 − 時給 × 労働時間)`（時間未入力時は出勤日数×4.5h）
- 実質時給 `realHourlyWage = round(支給額 ÷ 労働時間)`
- 売上目標ライン = 時給×225 / 下限ライン = 時給×90

**PR2で追加された画面:**
- `/casts` キャスト一覧（店舗切替・全店舗表示・源氏名/本名/ふりがな検索・在籍状態/ランク絞り込み・アーカイブ表示切替・更新ボタン）
- `/casts/[castId]` キャスト詳細（基本情報・メモ・記録情報。PR3でグラフ等のセクションを追加予定）
- `/stores` 店舗管理（owner専用。初期店舗 VIRGO / REGINA のワンクリック作成付き）

**PR2の運用メモ:**
- 「全店舗」は画面上の表示条件のみ。Firestoreへ `storeId: "__all__"` が保存されることはありません（Rulesでも拒否）
- キャスト編集は競合検知付き（他ユーザーが先に更新していた場合は上書きせず再編集を促す）
- キャストの完全削除は全ユーザー禁止（PR5でowner専用機能として実装予定）。非表示は「アーカイブ」を使用

---

## 技術構成

| 項目 | 内容 |
|---|---|
| フレームワーク | Next.js 14（App Router）+ TypeScript |
| 認証 | Firebase Authentication（メール/パスワード） |
| データベース | Cloud Firestore |
| ホスティング | Vercel（推奨） |

## 権限モデル

| role | 権限 |
|---|---|
| `owner` | 全店舗の閲覧・編集、ユーザー管理、店舗管理 |
| `admin` | `accessibleStoreIds` に含まれる店舗の閲覧・編集 |
| `viewer` | `accessibleStoreIds` に含まれる店舗の閲覧のみ |

| status | 状態 |
|---|---|
| `pending` | 利用申請済み・承認待ち（業務データへアクセス不可） |
| `approved` | 承認済み（利用可能） |
| `disabled` | 無効化（業務データへアクセス不可） |

新規登録者は必ず `role: viewer` / `status: pending` で作成されます。
クライアントから role や status を指定することはできません（Firestore Rulesで強制）。

---

## ⚠️ 重要: 権限変更処理は暫定実装です

`src/services/userAdminService.ts` にあるユーザー承認・権限変更・無効化・
最後のowner保護は、**PR1時点ではクライアント側のFirestoreトランザクションで
実装しています。**

クライアント側のowner数チェックは、同時操作や改変されたクライアントに対して
**完全な安全性を保証できません。** Firestore Rulesは自己role/status変更を
拒否しますが、「最後の承認済みownerの降格・無効化禁止」はRulesでは集計が
できないため厳密には表現できていません。

**本番運用前に、以下をCallable Cloud Functionsへ移行してください（残課題）:**

- [ ] `approveUser`（pendingユーザーの承認）
- [ ] `changeUserRole`（role変更・ownerへの昇格・ownerからの降格）
- [ ] `disableUser` / `enableUser`（無効化・再有効化）
- [ ] `setAccessibleStores`（accessibleStoreIds変更）
- [ ] 最後のowner保護のサーバー側での厳密な検証

サービス層の関数シグネチャはCallable Functionsと同じ形（引数in/例外でエラー）
に揃えているため、移行時は関数本体を `httpsCallable(...)` 呼び出しへ
差し替えるだけで済む設計です。UIコンポーネントは必ずこのサービス層経由で
操作しており、usersドキュメントを直接更新している箇所はありません。

---

## セットアップ手順

### 1. Firebaseプロジェクトの作成

1. [Firebaseコンソール](https://console.firebase.google.com/) で「プロジェクトを追加」
2. プロジェクト名を入力（例: `cast-manager`）して作成
3. プロジェクトの設定 > 全般 > マイアプリ > 「ウェブアプリを追加」（`</>`アイコン）
4. 表示される `firebaseConfig` の値を控える

### 2. Firebase Authenticationの有効化

1. Firebaseコンソール > 構築 > Authentication > 「始める」
2. ログイン方法タブ > 「メール / パスワード」を有効にする

### 3. Cloud Firestoreの作成

1. Firebaseコンソール > 構築 > Firestore Database > 「データベースを作成」
2. ロケーションを選択（例: `asia-northeast1`（東京））
3. **本番モード**で開始（Rulesは後でデプロイする）

### 4. ローカル環境の準備

```bash
# 依存パッケージのインストール
npm install

# 環境変数の設定
cp .env.example .env.local
# .env.local を開き、手順1で控えた firebaseConfig の値を設定する
```

### 5. Firestore Rules / インデックスのデプロイ

```bash
# Firebase CLI（未インストールの場合）
npm install -g firebase-tools
firebase login

# プロジェクトの紐付け
cp .firebaserc.example .firebaserc
# .firebaserc を開き "your-project-id" を実際のプロジェクトIDに変更

# Rulesとインデックスをデプロイ
firebase deploy --only firestore:rules,firestore:indexes
```

### 6. 開発サーバーの起動

```bash
npm run dev
# http://localhost:3000 を開く
```

### 7. 初回ownerの作成（必須・手動）

セキュリティ上、新規登録者が自分をownerにできる仕組みは存在しません。
最初のownerは以下の手順で**Firestoreコンソールから手動で設定**してください。

1. アプリの `/register` から通常どおり利用申請する
   （この時点では `role: viewer` / `status: pending`）
2. Firebaseコンソール > Firestore Database > `users` コレクションを開く
3. 登録したユーザーのドキュメント（IDはAuthenticationのUIDと同じ）を開く
4. 以下のフィールドを編集する:
   - `role`: `viewer` → **`owner`**
   - `status`: `pending` → **`approved`**
   - `approvedAt`: 現在時刻（timestamp型）
   - `approvedBy`: 自分のUID（string型）
5. アプリを再読み込みするとダッシュボードへ入れる

2人目以降のオーナー・管理者は、アプリ内の「ユーザー管理」画面から
承認・権限変更できます。

---

## Firebase Emulatorでの開発

本番Firebaseに接続せずローカルで開発できます。

```bash
# エミュレータの起動（Auth + Firestore + 管理UI）
npm run emulators
# 管理UI: http://localhost:4000

# 別ターミナルで、エミュレータ接続を有効にして開発サーバー起動
# .env.local に以下を設定:
#   NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true
npm run dev
```

エミュレータ利用時も「初回ownerの作成」はエミュレータUI
（http://localhost:4000/firestore）から同様に行ってください。

## Firestore Rulesテスト

```bash
cd rules-test
npm install
npm test   # firebase emulators:exec --only firestore "vitest run"
```

テスト内容は `rules-test/firestore.rules.test.mjs` を参照。
未ログイン / pending / disabled / usersドキュメント不在 / viewer / admin /
owner / 権限昇格防止 / auditLogs改竄防止 をカバーしています。

### Rulesで保証できない操作（把握しておくこと）

| 操作 | Rulesでの扱い | 補完策 |
|---|---|---|
| 最後のownerの降格・無効化禁止 | 集計不可のため表現できない | 自己role/status変更はRulesで拒否。他owner同士の同時降格はサービス層のトランザクションでチェック（厳密な保証はCloud Functions移行時） |
| owner同士の相互降格の競合 | 表現できない | 同上 |
| approvedBy の実在性検証 | 他ドキュメント参照はコストが高いため未実装 | Cloud Functions移行時にサーバー側で設定 |

---

## Vercelへのデプロイ

1. [Vercel](https://vercel.com/) にログインし「Add New > Project」
2. GitHubリポジトリをインポート
3. Environment Variables に `.env.local` と同じ値を設定:
   - `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `NEXT_PUBLIC_FIREBASE_APP_ID`
   - （`NEXT_PUBLIC_USE_FIREBASE_EMULATOR` は設定しない、または `false`）
4. Deploy
5. デプロイ後、Firebaseコンソール > Authentication > Settings >
   承認済みドメイン に Vercelのドメイン（`*.vercel.app`）を追加

## GitHubへのpush手順

```bash
cd cast-manager-web
git init
git add .
git commit -m "PR1: 認証基盤・ユーザー管理・Firestore Rules"

# GitHubで新規リポジトリ cast-manager-web を作成した後:
git remote add origin https://github.com/<your-account>/cast-manager-web.git
git branch -M main
git push -u origin main
```

### PR運用する場合

```bash
git checkout -b feature/pr1-auth-foundation
git push -u origin feature/pr1-auth-foundation
# GitHub上で main への Pull Request を作成
```

---

## npm install後に実行するコマンド

```bash
npm run typecheck   # TypeScript型チェック（tsc --noEmit）
npm run lint        # ESLint
npm run dev         # 開発サーバー
npm run build       # 本番ビルド確認
npm run emulators   # Firebaseエミュレータ
npm run test:rules  # Rulesテスト（rules-test/でnpm install済みであること）
```

## ディレクトリ構成

```
cast-manager-web/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── layout.tsx          # AuthProvider + AuthGate
│   │   ├── page.tsx            # ルート（AuthGateが振り分け）
│   │   ├── login/              # ログイン
│   │   ├── register/           # 利用申請
│   │   ├── pending/            # 承認待ち
│   │   ├── disabled/           # 無効ユーザー
│   │   ├── account-error/      # ユーザードキュメント不在/取得エラー
│   │   ├── dashboard/          # ダッシュボード（PR1はプレースホルダー）
│   │   └── admin/users/        # ユーザー管理（owner専用）
│   ├── components/AuthGate.tsx # ルートガード
│   ├── contexts/AuthContext.tsx# 認証状態（8状態を明確に分離）
│   ├── lib/firebase.ts         # Firebase初期化（エミュレータ対応）
│   ├── services/
│   │   ├── userService.ts      # 登録・ログイン
│   │   └── userAdminService.ts # ユーザー管理（暫定実装・CF移行前提）
│   └── types/
│       ├── user.ts             # Role / UserStatus / UserDoc
│       └── domain.ts           # CastStatus / Rank / 業務データ型（PR2向け）
├── rules-test/                 # Firestore Rulesテスト
├── firestore.rules
├── firestore.indexes.json
├── firebase.json
├── .firebaserc.example
└── .env.example
```

## 認証状態の遷移

`AuthContext` は以下の8状態を明確に分離しており、確定するまで
画面を一切表示しません（一瞬のチラつきも出さない設計）。

```
initializing ──(未ログイン)──────────→ signedOut → /login
     │
     └─(ログイン済み)→ loadingUserDoc ─┬→ pending   → /pending
                                        ├→ approved  → アプリ本体
                                        ├→ disabled  → /disabled
                                        ├→ noUserDoc → /account-error
                                        └→ error     → /account-error
```

usersドキュメントが存在しない・取得エラーの場合は**承認扱いにしません**。

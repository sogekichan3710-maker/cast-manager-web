# CAST MANAGER WEB

ナイトクラブ・キャバレー向けキャスト管理システムのWeb版（Next.js + Firebase）。

既存のローカルHTML版（cast-manager-v2/index.html）を段階的に移行するプロジェクトです。

**実装状況:**
- PR1: 認証・承認・権限基盤・ユーザー管理・Firestore Rules
- PR2: 店舗マスター・キャスト一覧・キャスト登録/編集/アーカイブ・キャスト詳細
- PR3: 月別成績・推移グラフ8種・面談・目標・モチベーション・時給履歴
- PR3.5: ダッシュボード集計・ランキング7カテゴリ・検索対象修正・自動計算表示・面談編集
- PR4: 旧ローカルデータ移行・Excelインポート/エクスポート・JSONバックアップ・
  nameMatchingRules・インポート履歴・関連Security Rules
- PR5: auditLogs本格運用・キャスト完全削除・ユーザー管理のCloud Functions化・
  毎日/飛び飛びExcel運用対応・店舗別給与運用ルール（このPR）

**PR4で追加された機能:**
- `/admin/migration` 旧ローカルデータ移行ウィザード（owner専用）
  - 旧HTML版 exportFullJSON（localStorage `cm2_v4`）のJSONを読み込み、
    件数・重複候補・不正データ・孤立データ・storeId不明・月形式エラーを
    プレビュー表示。元JSONのバックアップDL後に明示実行した場合のみ移行
  - 変換は `src/lib/migration/`（parse / validate / convert）に分離・単体テスト済み
  - 冪等性: 全ドキュメントを決定的ID（旧ID保持・monthlyResultsは
    `{storeId}_{castId}_{YYYY-MM}`）で書き込み、既存はskip。
    同じJSONを何度実行しても二重登録されない。実行記録は `migrationRuns` へ
- `/import` Excelインポート（owner / 許可されたadmin）
  - 実給与明細（.xls）対応: 全シートを走査して給料明細シートを自動判定
    （「設定」等のマスター/集計シートは除外・手動シート選択も可）。
    ヘッダー行は「名前列+既知列2つ以上」で自動判定し、データ範囲を検出。
    集計行（合計/平均）・設定項目（本指名/場内指名/同伴/ボトル/ドリンク等）・
    数値のみ・空欄・記号行はキャスト名として扱わず理由付きで除外表示。
    選択中シート/ヘッダー行/データ範囲/警告（0件・件数過多・シート名が
    設定等）を画面表示
  - 安全対策: 要確認行の初期状態は「未選択」（自動で新規登録しない）。
    全行解決するまで実行不可。実行前に最終確認画面（対象/シート/検出数/
    自動確定/新規/紐付け/上書き/時給変更/在籍状態変更/除外/未選択の件数）を必ず表示
  - 照合は源氏名の**完全一致のみ**で判定（部分一致・類似候補・類似スコアは
    内部判定含め廃止。「れい」「れいな」「みれい」は別人として扱う）。
    完全一致1名は自動紐付け・完全一致なしは自動で新規登録とし、
    どちらも照合画面に表示しない。完全一致が複数存在する場合だけ
    紐付け先の選択画面を表示する（唯一の手動選択ケース）
  - 操作性: 上記の自動確定行は「自動確定済み」表示で操作不要（手動変更は可能）。
    一括操作（完全一致のみ紐付け / 候補なしのみ新規登録［確認画面+件数警告付き］/
    表示中・全件の除外 / 選択解除）と9種の絞り込み（既定「要対応のみ」）、
    未選択行への移動導線つき
  - キャンセル: 解析（読込/シート解析/ヘッダー判定/データ抽出/照合）は
    AbortControllerで段階ごとに中断可能。キャンセル後は初期画面へ戻り
    途中結果を反映しない。保存中キャンセルは別系統で、未処理行は保存せず
    保存済み変更は必ずchangesへ記録、statusは cancelled（保存0件）/
    partial-cancelled（一部保存・ロールバック可）とし completed にしない
  - 店舗・月・ファイルの3点選択必須 → 照合確認画面（確認が必要な3ケース:
    時給変更候補 / 完全一致が複数 / 退店・在籍状態確認）
  - 行ごとに「既存へ紐付け / 新規登録 / 時給変更 / 除外」を選択。
    同名キャストの自動統合はしない（完全一致が複数の場合のみ人が選択）
  - 確定した照合は `nameMatchingRules`（ID: `storeId__正規化名`）へ保存し
    次回の自動判定に利用。ただしリンク先不在・店舗違い・大幅時給差・
    アーカイブ済み・同名複数の場合は自動確定せず再確認
  - 時給変更は casts.hourlyWage 更新 + wageHistory 追記（source: excel-import）
  - 履歴は `importBatches` へ（`/import/history` で閲覧）
  - **Batch単位ロールバック**: インポートが加えた変更を `importBatches.changes`
    に記録し、履歴画面から取り消し可能。新規キャスト（importBatchId付き）・
    新規/上書き月別成績・追加時給履歴・追加/更新ルール・在籍状態変更を対象に、
    インポート後に手動変更されたデータは上書きせず理由付きで「戻せない」と報告。
    結果は rollbackStatus / rollbackAt / rollbackBy として保存。
    再インポート時の重複防止として「新規登録」確定は作成キャストへのlinkルール
    として保存（同じファイルを2回インポートしてもキャストが重複しない）
- `/export` データエクスポート
  - Excel: キャスト一覧 / 月別成績 / 面談履歴 / 目標 / モチベーション / 時給履歴
    の6シート。店舗・期間選択可。「全店舗」は閲覧可能店舗のみ
  - JSONバックアップ（owner専用・cmweb-backup_v1形式）。バックアップJSONは
    移行ウィザードで再読込可能。users・認証情報は含まない
- Security Rules: migrationRuns（owner専用）/ nameMatchingRules / importBatches
  を追加し、Rulesテスト43件を追加（許可店舗外・viewer拒否・改竄防止等）

**PR4の実装メモ:**
- 旧 `index.html` 自体はリポジトリに存在しないため、旧データ形式は
  `src/types/domain.ts` の旧版準拠コメント・README・移植済み仕様から復元した。
  パーサーは配列/オブジェクト両形式・フィールド別名を広く受け付け、
  解釈できないデータは黙って捨てずプレビューで件数・詳細を報告する
- 旧 `castRecords`（面談+目標+モチベーションの統合記録）は
  interviews / `{旧ID}_goal` / `{旧ID}_moti` の3ドキュメントへ分離
- ルール適用後の再確認となる「大幅な時給差」の閾値は500円
  （`WAGE_GAP_RECONFIRM`。旧版の具体値が確認でき次第調整）
- インポート履歴はviewerもRules上は閲覧可（既存の店舗別読み取り設計と整合）
  だが、画面・メニューは非表示

**PR5で追加された機能:**
- **auditLogs本格運用** — `src/services/auditLogService.ts` に一元化。
  キャスト登録/編集/アーカイブ/復元/完全削除、月別成績登録/編集/削除、
  面談登録/編集、目標登録/更新、モチベーション登録、時給変更、
  Excelインポート実行/ロールバック、旧データ移行実行、JSONバックアップ、
  ユーザー承認/権限変更/無効化/再有効化/accessibleStoreIds変更まで、
  すべて「誰が・いつ・何を・どの店舗で・変更前・変更後」を記録する。
  業務データの変更は同一トランザクション/バッチでログを書き込み、
  変更とログの原子性を保つ（ログだけ欠落することがない）
- **owner専用キャスト完全削除** — プレビュー（`src/services/castDeleteService.ts`
  の `previewCastDeletion`）は月別成績/面談/目標/モチベーション/
  時給履歴/nameMatchingRules（リンク解除件数）/importBatch参照の件数を
  読み取り専用で集計してクライアントに表示し、源氏名の入力確認後にのみ
  削除を実行する。実際の削除は `functions/src/index.ts` の
  `deleteCastPermanently`（owner専用Callable Function・レビュー対応で
  Cloud Functions化）が担当し、関連コレクションを先に全削除してから
  キャスト本体を削除して孤立データを残さない（大量データは400件単位で
  バッチ分割）。Firestore Rulesは逆に**owner含め全クライアントSDKから
  `casts` / `wageHistory` の任意削除を禁止**し、削除はCloud Functions
  経由のみに限定した（admin以下は従来どおりimportBatchId付き/
  source:excel-importのExcelロールバック削除のみ）
- **ユーザー管理のCloud Functions化** — 上記「権限変更処理は
  Cloud Functionsへ移行済み」の節を参照
- **毎日/飛び飛びExcel運用対応** — 会社Excelは「その時点までの月累計」を
  保持しているため、インポートは常に**上書き更新**（加算しない）。
  月別成績のドキュメントIDが`{storeId}_{castId}_{YYYY-MM}`で決定的なため、
  7/10→7/13（欠落）→7/18のように飛び飛びで再インポートしても、
  常に最新の累計値へ正しく更新される（欠損として扱わない）。
  月末締め後に売上・支給額等が修正された場合も、最終Excelを再インポート
  するだけでFirestoreが最終状態になる
- **月別成績の更新元判別** — `monthlyResults` へ `lastImportAt` /
  `lastImportBatchId`（Excel由来）と `lastManualEditAt` / `lastManualEditBy`
  （手動フォーム由来）を追加し、どちらが最新の更新かを判別できるようにした
- **差分表示（変更項目のみ）** — `src/lib/monthlyResultDiff.ts`。
  同一月への再インポート時、既存データとExcelを比較し**値が変わった
  項目だけ**を「更新前→更新後」形式で表示する（旧仕様の全項目表示から変更）
- **店舗別運用ルール（設定のみ）** — `stores.wagePolicy`
  （`'fixed'` 固定時給制 / `'slide'` スライド制）を追加。
  初期値はVIRGO=fixed・REGINA=slide。**現在の計算・動作は一切変更しない**
  設定項目のみで、将来のExcelインポート/AI連携/会社入力機能で参照する想定
- **将来構想を考慮した設計の確認** — ダッシュボード/ランキング/月別成績/
  キャスト詳細は `monthlyResultService` の型（`MonthlyResultWithId`）と
  購読関数のみに依存し、Excel関連コード（`src/lib/excel/`）への参照が
  一切ないことを確認済み。入力元がExcel→Web入力へ変わっても、集計・
  ランキング・ダッシュボード・将来のAI分析・エクスポート側の変更は不要な構造
- Excel出力処理は `src/lib/excel/exportExcel.ts`（ワークブック生成）と
  `src/services/exportService.ts`（Firestore取得）に分離済み（PR4から継続）。
  会社提出用フォーマットへの変更が必要になった場合もこの2ファイルの変更で完結する

**PR3.5で追加された機能（既存ローカル版の仕様を移植）:**
- `/dashboard` 全面実装 — 在籍人数/今月売上(前月比)/平均時給(月・年)/平均実質時給/総支給額/年間累計、平均時給の直近12ヶ月推移グラフ、面談アラート(30日以上or未面談・優先度ソート)、フォロー必要度「高」、次回面談予定(7日以内)、目標達成状況、今月・来月の誕生日
  （本指名/顧客数/場内/同伴/出勤/給与差額・時給差額の合計カードはPR4で表示整理 —
    月別成績・ランキングと重複するため非表示。集計関数は維持）
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
- キャストの完全削除はowner専用（PR5で実装。関連データも含めて削除・取り消し不可）。日常運用での非表示は引き続き「アーカイブ」を使用

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

## ✅ 権限変更・キャスト完全削除処理はCloud Functionsへ移行済み（PR5）

`src/services/userAdminService.ts` にあるユーザー承認・権限変更・無効化・
`accessibleStoreIds` 設定、および `src/services/castDeleteService.ts` の
キャスト完全削除は、`functions/src/index.ts` の Callable Cloud Functions
（`approveUser` / `changeUserRole` / `disableUser` / `enableUser` /
`setAccessibleStores` / `deleteCastPermanently`）へ移行済みです。

- Firestore Rules 側も `users.role / status / accessibleStoreIds / approvedAt /
  approvedBy / disabledAt` と `casts` の削除（Excelロールバック用の限定削除を
  除く）をクライアントSDKから直接変更・実行できないよう制限しており、
  これらの操作は必ずCloud Functions経由になります（Admin SDKはRulesを
  バイパスするため矛盾しません）
- 「最後の承認済みownerの降格・無効化禁止」は、Cloud Functions内の
  Firestoreトランザクションで承認済みowner数を**その場でクエリして判定**する
  ため、同時操作があっても正しく機能します（クライアント側の事前チェックのみに
  依存しない厳密な保証）
- 自分自身を無効化する場合は `confirmSelf: true` が必須（`disableUser`
  Function）。未指定で自己無効化しようとすると `failed-precondition` で拒否
- `setAccessibleStores` は各storeIdの実在・active判定・重複除去・
  `'__all__'`拒否をサーバー側で行う。空配列（全店舗アクセスの剥奪）を
  保存する場合は `confirmEmpty: true` が必須
- `deleteCastPermanently` はキャストと関連データ（月別成績・面談・目標・
  モチベーション・時給履歴）の削除、nameMatchingRulesのリンク解除、
  キャスト本体削除、監査ログ記録を1つのFunction呼び出しで行う。
  途中で失敗しても、同じcastIdで再実行すれば残っているデータだけを
  処理して安全に完了できる（詳細は関数内コメント参照）
- 監査ログの`actorName`は、すべてのFunctionでクライアントの入力を使わず
  呼び出し元自身の`users/{uid}`ドキュメントからサーバー側で取得する
  （クライアントが任意の名前を偽装できない）
- 判定ロジックは `functions/src/lastOwnerGuard.ts` /
  `functions/src/castDeleteGuard.ts` / `functions/src/storeAccessGuard.ts` に
  純粋関数として分離し、`functions/` 単体のvitestで検証
  （`npm --prefix functions test`）

### ⚠️ デプロイ順序（重要・必ずこの順序で行うこと）

新しいFirestore Rulesは、ユーザー管理系フィールド（role/status/
accessibleStoreIds等）とcastsの任意削除をクライアントSDKから**全面的に
拒否**し、Cloud Functions（Admin SDK）経由でのみ変更できる設計です。
そのため、**Cloud FunctionsをデプロイするよりRulesを先にデプロイすると、
Functionsが存在しない間はユーザー承認・権限変更・無効化・店舗設定・
キャスト完全削除が一切できなくなります**（Rulesが直接書き込みを拒否し、
かつ代替のFunctionsも呼び出せないため）。必ず以下の順序でデプロイして
ください。

1. **Cloud Functionsをデプロイする**
   ```bash
   cd functions
   npm install
   npm run build
   npm test              # functions/ 単体テストが全て通ることを確認
   firebase deploy --only functions
   ```
2. **Callable Functionsの疎通確認をする**
   本番（またはステージング）環境で、実際にownerアカウントから
   `approveUser` 等を1回呼び出し、`unauthenticated` や `functions/not-found`
   のようなエラーにならず正常応答することを確認する（Firebaseコンソール
   の Functions ログ、またはアプリの「ユーザー管理」画面から）。
3. **Firestore Rules と Indexes をデプロイする**
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```
4. **ownerによる承認・権限変更・店舗設定の動作確認をする**
   `/admin/users` 画面から、承認・権限変更・無効化・再有効化・
   閲覧可能店舗の設定、`/casts/[castId]` からキャスト完全削除
   （テスト用データで）が正しく動作し、`/admin/audit` に監査ログが
   記録されることを確認する。
5. **本番利用を開始する**

エミュレータで動作確認する場合は `npm run emulators`（`functions` も
`firebase.json` で起動対象に含まれています）。

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

import type { Timestamp } from "firebase/firestore";

/**
 * 業務データの型定義。
 * PR1 では画面実装しないが、後続PR（キャスト一覧・月別成績・面談等）が
 * 同じ定数・型を参照できるようここで一元管理する。
 * 既存ローカル版（index.html）のデータ構造・計算式に合わせている。
 */

/** 在籍状態（既存ローカル版の日本語3値をそのまま維持） */
export const CAST_STATUSES = ["在籍", "休職", "退店"] as const;
export type CastStatus = (typeof CAST_STATUSES)[number];

/** ランク9段階（既存ローカル版と同一） */
export const RANKS = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"] as const;
export type Rank = (typeof RANKS)[number];

/**
 * 店舗別の給与運用ルール（PR5で追加。設定のみで現在の計算・動作は変更しない）。
 * - fixed: 固定時給制
 * - slide: スライド（歩合）制
 * 将来のExcelインポート／AI連携／会社入力機能で参照する想定。
 */
export const WAGE_POLICIES = ["fixed", "slide"] as const;
export type WagePolicy = (typeof WAGE_POLICIES)[number];

/** stores/{storeId} */
export interface StoreDoc {
  name: string;
  code: string;
  color: string;
  active: boolean;
  order: number;
  /** 給与運用ルール（PR5で追加。未設定の既存店舗は 'fixed' 扱い） */
  wagePolicy?: WagePolicy;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

/** 画面で扱うときの id 付き店舗 */
export interface StoreWithId extends StoreDoc {
  id: string;
}

/**
 * 初期店舗の定義（一元管理）。
 * 店舗IDはFirestoreドキュメントIDとして使用する。
 * 「全店舗」は表示用フィルターのみであり、Firestoreへ
 * storeId: '__all__' を保存することは禁止（Rulesでも拒否）。
 */
export const INITIAL_STORES: ReadonlyArray<{
  id: string;
  name: string;
  code: string;
  color: string;
  order: number;
  wagePolicy: WagePolicy;
}> = [
  { id: "virgo", name: "VIRGO", code: "virgo", color: "#9c27b0", order: 0, wagePolicy: "fixed" },
  { id: "regina", name: "REGINA", code: "regina", color: "#e91e63", order: 1, wagePolicy: "slide" },
] as const;

/** 「全店舗」表示用の特別値（Firestoreへは絶対に保存しない） */
export const ALL_STORES_FILTER = "__all__" as const;

/** casts/{castId} */
export interface CastDoc {
  storeId: string;
  stageName: string;
  realName: string;
  kana: string;
  hourlyWage: number;
  rank: Rank | "";
  status: CastStatus;
  joinDate: string; // YYYY-MM-DD（既存ローカル版と同じフィールド名・文字列日付）
  leftDate: string;
  birthday: string;
  phone: string;
  line: string;
  manager: string;
  /** スカウト者（PR6で追加。担当者とは別項目。旧データには存在しない場合がある） */
  scoutedBy: string;
  targetSales: number;
  targetHonmei: number;
  targetDouhan: number;
  guarantee: string;
  personality: string;
  memo: string;
  customerNotes: string;
  archived: boolean;
  /** Excelインポートで新規作成されたキャストのみ持つ（Batch単位ロールバック用） */
  importBatchId?: string | null;
  /**
   * ランキング対象開始日（PR8で追加）。この日付より前の期間のランキングには
   * 表示しない（在籍キャスト全員表示化に伴う「まだ存在しなかった月」の誤表示を防ぐ）。
   * - null: 未設定。自動判定前、または判定に使えるデータが無い場合はランキングで常に対象扱い
   * - 自動設定: そのキャストの最初のデータ登録時（Excelインポート）に1回だけ設定
   * - 手動設定: キャスト編集画面から年月日で設定可能。手動値は自動処理で上書きされない
   * 将来の日次・週次・任意期間ランキングでもそのまま比較に使える日付型（Timestamp）で保持する
   * （月文字列では判定しない）。
   */
  rankingEligibleFrom?: Timestamp | null;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

/** 画面で扱うときの id 付きキャスト */
export interface CastWithId extends CastDoc {
  id: string;
}

/**
 * monthlyResults/{resultId}
 * ドキュメントID = `${storeId}_${castId}_${month}`（month は YYYY-MM）
 * これにより同一店舗・同一キャスト・同一月の重複を構造的に防ぐ。
 */
export interface MonthlyResultDoc {
  castId: string;
  storeId: string;
  month: string; // YYYY-MM に正規化して保存
  totalSales: number;
  payment: number;
  honshimeiCount: number;
  honshimeiGroupCount: number;
  customerCount: number;
  jounaiCount: number;
  douhan: number;
  workDays: number;
  workHours: number;
  absent: number;
  notes: string;
  batchId: string | null;
  /**
   * 毎日・飛び飛び運用対応（PR5）。
   * Excelは「その時点までの月累計」を保持しているため、インポートは常に
   * 値を上書きする（加算しない）。途中の日付が存在しなくても欠損として
   * 扱わない。Excel更新と手動編集のどちらが最新かを判別するための記録。
   */
  lastImportAt?: Timestamp | null;
  lastImportBatchId?: string | null;
  lastManualEditAt?: Timestamp | null;
  lastManualEditBy?: string | null;
  /**
   * 対象日（PR8で追加）。インポート実行日時ではなく、このデータが表す
   * 業務上の日付（例: 7/20に6/30分のデータを取り込む場合は 2026-06-30）。
   * インポート画面で任意選択。未選択のまま保存した場合は既存値を保持し、
   * 一度も選択されていない場合は null（月単位のみで管理）。
   * 将来の日次インポート・日別/週間/任意期間ランキングでそのまま利用できるよう
   * 日付型（Timestamp）で保持する。
   */
  targetDate?: Timestamp | null;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

/** 月別成績のドキュメントIDを生成する一意キー */
export function monthlyResultId(storeId: string, castId: string, month: string): string {
  return `${storeId}_${castId}_${month}`;
}

/**
 * 「2026年9月」「2026-9」「2026/09」等を YYYY-MM に正規化する。
 * 既存ローカル版の monthToNum と互換の解釈。不明な形式は null。
 */
export function normalizeMonth(raw: string): string | null {
  const text = String(raw || "").trim();
  const jp = text.match(/(\d{4})年\s*(\d{1,2})月/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, "0")}`;
  const sep = text.match(/(\d{4})[/-](\d{1,2})/);
  if (sep) return `${sep[1]}-${sep[2].padStart(2, "0")}`;
  return null;
}

/**
 * 給与差額 = 売上 − 給料（既存ローカル版 payDiff と同一式・変更禁止）
 */
export function payDiff(sales: number | null, payment: number | null): number | null {
  if (sales == null || payment == null) return null;
  return Math.round(sales - payment);
}

/**
 * 時給差額 = 売上 − 時給×労働時間（既存ローカル版 wageDiff と同一式・変更禁止）
 * 労働時間が未入力の場合は 出勤日数 × 4.5h で代替する。
 */
export function wageDiff(
  sales: number | null,
  wage: number | null,
  workHours: number | null,
  workDays: number | null
): number | null {
  if (!wage || wage === 0) return null;
  if (sales == null) return null;
  const hours =
    workHours != null && workHours > 0
      ? workHours
      : workDays != null && workDays > 0
        ? workDays * 4.5
        : 0;
  return Math.round(sales - wage * hours);
}

/**
 * 実質時給 = 支給額 ÷ 労働時間（既存ローカル版 realHourlyWage と同一式・変更禁止）
 * 労働時間が未入力の場合は 出勤日数 × 4.5h で代替する。
 */
export function realHourlyWage(
  payment: number | null,
  workHours: number | null,
  workDays: number | null
): number | null {
  const h =
    workHours != null && workHours > 0
      ? workHours
      : workDays != null && workDays > 0
        ? workDays * 4.5
        : null;
  if (!h || payment == null) return null;
  return Math.round(payment / h);
}

/** 売上目標ライン = 時給 × 225（既存ローカル版と同一・変更禁止） */
export function targetSalesByWage(wage: number | null): number | null {
  return wage ? wage * 225 : null;
}

/** 売上下限ライン = 時給 × 90（既存ローカル版と同一・変更禁止） */
export function lowerSalesByWage(wage: number | null): number | null {
  return wage ? wage * 90 : null;
}

/** 面談フォロー必要度（既存ローカル版と同一） */
export const FOLLOW_NEEDS = ["高", "中", "低"] as const;
export type FollowNeed = (typeof FOLLOW_NEEDS)[number];

/** interviews/{interviewId}（既存ローカル版 saveRecord の保存項目を維持） */
export interface InterviewDoc {
  castId: string;
  storeId: string;
  date: string;
  type: string; // 既存ローカル版は 'face-to-face' 固定
  importance: string; // 既存ローカル版は '通常' 固定
  follow: FollowNeed | ""; // フォロー必要度
  interviewer: string;
  content: string;
  worries: string;
  decisions: string;
  nextDate: string;
  nextTask: string;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

/** 画面用 id 付き面談 */
export interface InterviewWithId extends InterviewDoc {
  id: string;
}

/** 目標の達成状況（既存ローカル版と同一） */
export const GOAL_STATUSES = ["達成", "未達成", "進行中", "未着手"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** goals/{goalId}（既存ローカル版 saveRecord の目標項目を維持） */
export interface GoalDoc {
  castId: string;
  storeId: string;
  month: string; // YYYY-MM に正規化して保存
  salesTarget: number;
  honshimeiTarget: number;
  honGroupTarget: number;
  douhanTarget: number;
  jounaiTarget: number;
  workDaysTarget: number;
  workHoursTarget: number;
  status: GoalStatus | "";
  memo: string;
  task: string;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

/** 画面用 id 付き目標 */
export interface GoalWithId extends GoalDoc {
  id: string;
}

/** モチベーションレベル5段階（既存ローカル版と同一表記） */
export const MOTI_LEVELS = [
  "5:非常に高い",
  "4:高い",
  "3:普通",
  "2:低い",
  "1:非常に低い",
] as const;
export type MotiLevel = (typeof MOTI_LEVELS)[number];

/** motivations/{motivationId}（既存ローカル版 motivationLogs の項目を維持） */
export interface MotivationDoc {
  castId: string;
  storeId: string;
  date: string;
  level: MotiLevel;
  followNeed: FollowNeed | "";
  followDate: string;
  state: string; // 現在の状態
  danger: string; // 退店リスク・危険信号
  follow: string; // フォロー内容
  growth: string; // 成長ポイント
  createdAt: Timestamp;
  createdBy: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

/** 画面用 id 付きモチベーション */
export interface MotivationWithId extends MotivationDoc {
  id: string;
}

/** wageHistory/{historyId} */
export interface WageHistoryDoc {
  castId: string;
  storeId: string;
  oldHourlyWage: number;
  newHourlyWage: number;
  effectiveMonth: string;
  reason: string;
  /** 記録元。'manual' | 'excel-import' | 'migration'（PR3以前のデータには存在しない） */
  source?: string;
  createdAt: Timestamp;
  createdBy: string;
}

/** 画面用 id 付き時給履歴 */
export interface WageHistoryWithId extends WageHistoryDoc {
  id: string;
}

/** 画面用 id 付き月別成績 */
export interface MonthlyResultWithId extends MonthlyResultDoc {
  id: string;
}

/** 「YYYY-MM」→「YYYY年M月」表示（既存ローカル版の表示形式を維持） */
export function monthToJa(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return month;
  return `${m[1]}年${Number(m[2])}月`;
}

/** グラフX軸用の短い月ラベル（既存ローカル版 ml と同じ「9月」形式） */
export function monthShortLabel(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return month.replace(/\d{4}年/, "");
  return `${Number(m[2])}月`;
}

/** 現在の月を YYYY-MM で返す */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 「YYYY-MM」の月末最終時刻（23:59:59.999・ローカルタイム）を返す。
 * ランキング等の期間判定で「この期間の終わり」を表す汎用ヘルパー。
 * 不正な形式は null。
 */
export function monthPeriodEnd(month: string): Date | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]); // 1-12
  // 翌月の0日目 = 当月末日。時刻は23:59:59.999にして「月末まで」を包含する
  return new Date(year, mon, 0, 23, 59, 59, 999);
}

/** 「YYYY-MM」の月初 00:00:00（ローカルタイム）を返す。不正な形式は null */
export function monthPeriodStart(month: string): Date | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0, 0);
}

/** 差額の表示（既存ローカル版 fmtDiff と同一挙動: 負は -¥1,234） */
export function fmtDiff(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "-";
  const s = v < 0 ? "-¥" : "¥";
  return s + Math.abs(Math.round(v)).toLocaleString("ja-JP");
}

/**
 * インポート/移行の実行状態。
 * - cancelled: 1件も保存せずにキャンセル
 * - partial-cancelled: 一部保存済みでキャンセル（変更記録あり・ロールバック可）
 * いずれの場合も completed にはしない。
 */
export const RUN_STATUSES = [
  "processing",
  "completed",
  "failed",
  "cancelled",
  "partial-cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** ロールバック状態 */
export const ROLLBACK_STATUSES = ["none", "completed", "partial", "failed"] as const;
export type RollbackStatus = (typeof ROLLBACK_STATUSES)[number];

/**
 * インポートがFirestoreへ加えた変更1件の記録（Batch単位ロールバック用）。
 * before / after には変更した業務フィールドのみを保持する
 * （Timestamp系メタは持たない。復元時のupdatedAt等は実行時に再設定）。
 */
export interface BatchChange {
  type:
    | "cast-created"
    | "cast-updated"
    | "mr-created"
    | "mr-updated"
    | "wage-added"
    | "rule-created"
    | "rule-updated";
  collection: string;
  docId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** importBatches/{batchId} — Excelインポート1回分の履歴 */
export interface ImportBatchDoc {
  storeId: string;
  fileName: string;
  targetMonth: string; // YYYY-MM
  status: RunStatus;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  summary: string;
  /** このインポートが加えた変更の記録（ロールバック用）。旧データには存在しない */
  changes?: BatchChange[];
  rollbackStatus?: RollbackStatus;
  rollbackAt?: Timestamp | null;
  rollbackBy?: string | null;
  rollbackSummary?: string;
  createdAt: Timestamp;
  createdBy: string;
  completedAt: Timestamp | null;
}

/** 画面用 id 付きインポート履歴 */
export interface ImportBatchWithId extends ImportBatchDoc {
  id: string;
}

/**
 * migrationRuns/{migrationId} — 旧ローカルデータ移行1回分の記録（owner専用）。
 * 冪等性は「決定的ドキュメントID + 既存はskip」で担保し、本コレクションは
 * 実行履歴・監査のために保持する。
 */
export interface MigrationRunDoc {
  fileName: string;
  sourceFormat: string; // 'cm2_v4' | 'cmweb-backup_v1' 等
  status: RunStatus;
  summary: string;
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  createdBy: string;
  errorSummary: string;
}

export interface MigrationRunWithId extends MigrationRunDoc {
  id: string;
}

/** nameMatchingRules の確定内容 */
export const RULE_DECISIONS = ["link", "new", "exclude"] as const;
export type RuleDecision = (typeof RULE_DECISIONS)[number];

/**
 * nameMatchingRules/{ruleId} — Excelインポートの照合確定ルール。
 * ドキュメントID = `${storeId}__${normalizedName}`（storeIdと正規化名で一意）。
 * 一度確定したルールは次回インポートの候補判定に利用するが、
 * リンク先キャスト不在・店舗違い・大幅な時給差・アーカイブ済み・
 * 同名候補複数の場合は自動確定せず再確認する（importMatching参照）。
 */
export interface NameMatchingRuleDoc {
  storeId: string;
  sourceName: string;
  normalizedName: string;
  decision: RuleDecision;
  linkedCastId: string | null;
  hourlyWage: number | null; // 確定時点の時給（時給乖離の再確認判定に使用）
  active: boolean;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

export interface NameMatchingRuleWithId extends NameMatchingRuleDoc {
  id: string;
}

/** nameMatchingRules のドキュメントID（storeId × 正規化名で決定的に一意） */
export function nameMatchingRuleId(storeId: string, normalizedName: string): string {
  // Firestore ドキュメントIDに '/' は使えないため置換する
  return `${storeId}__${normalizedName.replace(/\//g, "_")}`;
}

/** auditLogs/{logId} */
export interface AuditLogDoc {
  userId: string;
  userName: string;
  action: string;
  collection: string;
  documentId: string;
  storeId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Timestamp;
}

export interface AuditLogWithId extends AuditLogDoc {
  id: string;
}

/**
 * 監査対象アクション（PR5で網羅・一元管理）。
 * 追加・変更時はこの一覧と auditLogService の呼び出し箇所を合わせて更新する。
 */
export const AUDIT_ACTIONS = [
  "cast.create",
  "cast.update",
  "cast.archive",
  "cast.restore",
  "cast.deletePermanent",
  "monthlyResult.create",
  "monthlyResult.update",
  "monthlyResult.delete",
  "interview.create",
  "interview.update",
  "interview.delete",
  "goal.upsert",
  "motivation.create",
  "wageHistory.add",
  "import.execute",
  "import.rollback",
  "migration.execute",
  "backup.export",
  "user.approve",
  "user.roleChange",
  "user.disable",
  "user.enable",
  "user.accessibleStoresChange",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

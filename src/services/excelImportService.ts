import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type Firestore,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import {
  monthPeriodStart,
  monthlyResultId,
  type BatchChange,
  type CastDoc,
  type CastStatus,
  type MonthlyResultDoc,
  type RunStatus,
} from "@/types";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";
import type { RowAction } from "@/lib/excel/importMatching";
import { buildRuleFromDecision } from "@/lib/excel/importMatching";
import { createImportBatch, completeImportBatch } from "./importBatchService";
import { upsertNameMatchingRule } from "./nameMatchingRuleService";
import { writeAuditLog } from "./auditLogService";

/**
 * Excelインポートの実行サービス。
 *
 * - 月別成績はドキュメントID {storeId}_{castId}_{YYYY-MM} で保存し、
 *   同一店舗・同一キャスト・同一月の重複を構造的に防止する
 * - 既存データがある行は UI で「スキップ / 上書き」を選択済み。
 *   上書きはトランザクションで最新データを取得したうえで更新する
 *   （画面表示時点の古いスナップショットでは上書きしない）
 * - 時給変更は casts.hourlyWage 更新 + wageHistory 追記（source: excel-import）を
 *   同一トランザクションで行う
 * - 実行結果は importBatches/{batchId} に記録する
 */

export interface RowDecision {
  row: ExcelMonthlyRow;
  action: RowAction;
  /** link / wage-change の対象キャスト */
  castId: string | null;
  /** wage-change 時の時給（oldWageは実行時に最新を取得し直す） */
  newWage: number | null;
  /** 既存monthlyResultsがある場合の扱い（UIの差分確認で選択） */
  existing: "none" | "skip" | "overwrite";
  /** この行の確定内容を nameMatchingRules へ保存するか */
  saveRule: boolean;
}

/** 確認フロー3（在籍状態）の適用内容 */
export interface StatusDecision {
  castId: string;
  /** null はステータス変更なし（確認のみ） */
  newStatus: CastStatus | null;
}

export interface ImportProgress {
  done: number;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  /** 保存済みの変更件数（importBatches.changesへ記録される数） */
  savedChanges: number;
}

export interface ImportResult {
  batchId: string;
  status: RunStatus;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  /** 処理済み件数（行 + 在籍状態変更） */
  processed: number;
  /** キャンセル時に未処理のまま残った件数（保存されていない） */
  unprocessed: number;
  /** 保存済みの変更件数 */
  savedChanges: number;
  errorMessages: string[];
}

/**
 * キャンセル時の最終ステータス（純関数・テスト可能）。
 * 1件でも保存済みの変更があれば partial-cancelled、無ければ cancelled。
 * いずれも completed にはしない。
 */
export function finalizeCancelledStatus(savedChanges: number): RunStatus {
  return savedChanges > 0 ? "partial-cancelled" : "cancelled";
}

/**
 * 月別成績の業務フィールドのみ（changes記録・復元用。メタは含めない）。
 * Excel行→Firestore保存値のマッピングの単一の定義であり、
 * 実ファイル一致テストからも参照する。
 */
export function mrRowBusinessFields(row: ExcelMonthlyRow): Record<string, unknown> {
  return {
    totalSales: Math.round(row.totalSales),
    payment: Math.round(row.payment),
    honshimeiCount: row.honshimeiCount,
    honshimeiGroupCount: row.honshimeiGroupCount,
    customerCount: row.customerCount,
    jounaiCount: row.jounaiCount,
    douhan: row.douhan,
    workDays: row.workDays,
    workHours: row.workHours,
    absent: row.absent,
    notes: row.notes,
  };
}

/** 既存月別成績ドキュメントから業務フィールドのみ抽出（復元用） */
function mrBusinessFields(cur: MonthlyResultDoc): Record<string, unknown> {
  return {
    totalSales: cur.totalSales,
    payment: cur.payment,
    honshimeiCount: cur.honshimeiCount,
    honshimeiGroupCount: cur.honshimeiGroupCount,
    customerCount: cur.customerCount,
    jounaiCount: cur.jounaiCount,
    douhan: cur.douhan,
    workDays: cur.workDays,
    workHours: cur.workHours,
    absent: cur.absent,
    notes: cur.notes,
    batchId: cur.batchId ?? null,
  };
}

/**
 * Excel行から月別成績の保存データを作る。
 * 毎日・飛び飛び運用対応: Excelは「その時点までの月累計」を保持しているため、
 * 常に値を「更新」する（加算しない・欠損扱いしない）。lastImportAt /
 * lastImportBatchId を必ず更新し、Excel更新か手動編集かを判別できるようにする。
 * targetDate（対象日）はインポート実行日時ではなく、ユーザーが選択した
 * 「このデータが表す業務上の日付」（PR8で追加）。
 */
function mrDataFromRow(
  storeId: string,
  castId: string,
  month: string,
  row: ExcelMonthlyRow,
  batchId: string,
  actorUid: string,
  targetDateTs: Timestamp | null
) {
  return {
    castId,
    storeId,
    month,
    totalSales: Math.round(row.totalSales),
    payment: Math.round(row.payment),
    honshimeiCount: row.honshimeiCount,
    honshimeiGroupCount: row.honshimeiGroupCount,
    customerCount: row.customerCount,
    jounaiCount: row.jounaiCount,
    douhan: row.douhan,
    workDays: row.workDays,
    workHours: row.workHours,
    absent: row.absent,
    notes: row.notes,
    batchId,
    targetDate: targetDateTs,
    lastImportAt: serverTimestamp(),
    lastImportBatchId: batchId,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  };
}

/** YYYY-MM-DD 文字列 → Timestamp（ローカルタイムの0時）。空文字/不正形式/未指定は null */
function targetDateStrToTimestamp(s: string | null | undefined): Timestamp | null {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Timestamp.fromDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * ランキング対象開始日（rankingEligibleFrom）の自動判定（PR8で追加）。
 * このキャストにとってこのインポートが「初めてのデータ登録」だった場合のみ、
 * かつ rankingEligibleFrom が未設定（null）の場合のみ1回だけ自動設定する。
 * 手動設定済み・既に自動設定済みの値は一切上書きしない。
 * 対象日（targetDate）が選択されていればその日付を、無ければ対象月の月初を使う。
 */
async function maybeAutoSetRankingEligibleFrom(
  db: Firestore,
  castId: string,
  targetMonth: string,
  targetDateTs: Timestamp | null,
  actorUid: string
): Promise<void> {
  const otherMonths = await getDocs(
    query(collection(db, "monthlyResults"), where("castId", "==", castId))
  );
  const hasOtherMonth = otherMonths.docs.some(
    (d) => (d.data() as MonthlyResultDoc).month !== targetMonth
  );
  if (hasOtherMonth) return; // このキャストの初回データではない

  const fallback = monthPeriodStart(targetMonth);
  const eligibleFrom = targetDateTs ?? (fallback ? Timestamp.fromDate(fallback) : null);
  if (!eligibleFrom) return;

  const castRef = doc(db, "casts", castId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(castRef);
    if (!snap.exists()) return;
    if ((snap.data() as CastDoc).rankingEligibleFrom != null) return; // 既に設定済みは上書きしない
    tx.update(castRef, {
      rankingEligibleFrom: eligibleFrom,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    });
  });
}

export async function executeExcelImport(
  actorUid: string,
  actorName: string,
  params: {
    storeId: string;
    targetMonth: string; // YYYY-MM
    /**
     * 対象日（任意・YYYY-MM-DD）。インポート実行日時ではなく、このデータが表す
     * 業務上の日付（例: 7/20に6/30分のデータを取り込む場合は "2026-06-30"）。
     * 未指定（null）の場合は従来通り月単位のみで管理する（後方互換）。
     */
    targetDate: string | null;
    fileName: string;
    decisions: RowDecision[];
    statusDecisions: StatusDecision[];
  },
  onProgress: (p: ImportProgress) => void,
  shouldCancel: () => boolean
): Promise<ImportResult> {
  const db = getDb();
  const { storeId, targetMonth, decisions, statusDecisions } = params;
  if (!storeId || !/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new Error("対象店舗と対象月を選択してください");
  }
  const targetDateTs = targetDateStrToTimestamp(params.targetDate);

  const batchId = await createImportBatch(actorUid, {
    storeId,
    fileName: params.fileName,
    targetMonth,
    totalRows: decisions.length,
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errorMessages: string[] = [];
  /** このインポートが加えた変更の記録（Batch単位ロールバック用） */
  const changes: BatchChange[] = [];
  let status: RunStatus = "completed";
  const total = decisions.length + statusDecisions.length;
  let done = 0;

  let cancelled = false;
  const report = () =>
    onProgress({
      done,
      total,
      created,
      updated,
      skipped,
      errors: errorMessages.length,
      savedChanges: changes.length,
    });

  for (const d of decisions) {
    if (shouldCancel()) {
      cancelled = true;
      break;
    }
    try {
      if (d.action === "exclude") {
        skipped++;
      } else {
        // 対象キャストの決定（新規はここで作成）
        let castId = d.castId;
        if (d.action === "new") {
          const castRef = doc(collection(db, "casts"));
          await runTransaction(db, async (tx) => {
            tx.set(castRef, {
              storeId,
              importBatchId: batchId,
              stageName: d.row.name.trim(),
              realName: "",
              kana: "",
              hourlyWage: d.row.hourlyWage != null ? Math.round(d.row.hourlyWage) : 0,
              rank: "",
              status: "在籍",
              joinDate: "",
              leftDate: "",
              birthday: "",
              phone: "",
              line: "",
              manager: "",
              scoutedBy: d.row.scoutedBy.trim(),
              targetSales: 0,
              targetHonmei: 0,
              targetDouhan: 0,
              guarantee: "",
              personality: "",
              memo: "",
              customerNotes: "",
              archived: false,
              createdAt: serverTimestamp(),
              createdBy: actorUid,
              updatedAt: serverTimestamp(),
              updatedBy: actorUid,
            });
          });
          castId = castRef.id;
          changes.push({
            type: "cast-created",
            collection: "casts",
            docId: castRef.id,
            before: null,
            after: { stageName: d.row.name.trim(), storeId },
          });
        }
        if (!castId) throw new Error(`行${d.row.rowNumber}「${d.row.name}」: 紐付け先キャストが未選択です`);

        // スカウト者の更新（既存キャストのみ。新規作成時は上のtx.setで設定済み）。
        // Excel側が空欄の行では既存の手入力値を消さないよう、値がある場合のみ更新する
        const scoutedByFromExcel = d.row.scoutedBy.trim();
        if (d.action !== "new" && scoutedByFromExcel) {
          const castRef = doc(db, "casts", castId);
          const scoutResult = await runTransaction(db, async (tx) => {
            const snap = await tx.get(castRef);
            if (!snap.exists()) throw new Error("キャストが見つかりません");
            const current = (snap.data() as { scoutedBy?: string }).scoutedBy ?? "";
            if (current === scoutedByFromExcel) return null;
            tx.update(castRef, {
              scoutedBy: scoutedByFromExcel,
              updatedAt: serverTimestamp(),
              updatedBy: actorUid,
            });
            return { before: current, after: scoutedByFromExcel };
          });
          if (scoutResult) {
            changes.push({
              type: "cast-updated",
              collection: "casts",
              docId: castId,
              before: { scoutedBy: scoutResult.before },
              after: { scoutedBy: scoutResult.after },
            });
          }
        }

        // 時給変更（casts更新 + wageHistory追記を同一トランザクションで）
        if (d.action === "wage-change") {
          if (d.newWage == null || d.newWage <= 0) {
            throw new Error(`行${d.row.rowNumber}「${d.row.name}」: 変更後の時給が不正です`);
          }
          const castRef = doc(db, "casts", castId);
          const whRef = doc(collection(db, "wageHistory"));
          const wageResult = await runTransaction(db, async (tx) => {
            const snap = await tx.get(castRef);
            if (!snap.exists()) throw new Error("キャストが見つかりません");
            const currentWage = (snap.data() as { hourlyWage?: number }).hourlyWage ?? 0;
            if (currentWage === d.newWage) return null;
            tx.set(whRef, {
              castId,
              storeId,
              oldHourlyWage: Math.round(currentWage),
              newHourlyWage: Math.round(d.newWage!),
              effectiveMonth: targetMonth,
              reason: "Excelインポートによる時給変更",
              source: "excel-import",
              createdAt: serverTimestamp(),
              createdBy: actorUid,
            });
            tx.update(castRef, {
              hourlyWage: Math.round(d.newWage!),
              updatedAt: serverTimestamp(),
              updatedBy: actorUid,
            });
            return { oldWage: Math.round(currentWage), newWage: Math.round(d.newWage!) };
          });
          if (wageResult) {
            changes.push({
              type: "wage-added",
              collection: "wageHistory",
              docId: whRef.id,
              before: null,
              after: { castId, oldHourlyWage: wageResult.oldWage, newHourlyWage: wageResult.newWage },
            });
            changes.push({
              type: "cast-updated",
              collection: "casts",
              docId: castId,
              before: { hourlyWage: wageResult.oldWage },
              after: { hourlyWage: wageResult.newWage },
            });
          }
        }

        // 月別成績の保存（既存はskip/overwrite。overwriteは最新を取得して更新）
        const mrRef = doc(db, "monthlyResults", monthlyResultId(storeId, castId, targetMonth));
        const mrOutcome = await runTransaction(db, async (tx) => {
          const snap = await tx.get(mrRef);
          const data = mrDataFromRow(storeId, castId!, targetMonth, d.row, batchId, actorUid, targetDateTs);
          if (!snap.exists()) {
            tx.set(mrRef, { ...data, createdAt: serverTimestamp(), createdBy: actorUid });
            return { outcome: "created" as const, before: null };
          }
          if (d.existing === "overwrite") {
            // storeId / castId / month はID構造上同一。createdAt / createdBy は保持される
            const cur = snap.data() as MonthlyResultDoc;
            // 対象日が今回未指定の場合は既存値を保持する（後方互換・意図しない消去防止）
            const patch = targetDateTs == null ? { ...data, targetDate: cur.targetDate ?? null } : data;
            tx.update(mrRef, patch);
            return { outcome: "updated" as const, before: mrBusinessFields(cur) };
          }
          return { outcome: "skipped" as const, before: null };
        });
        if (mrOutcome.outcome === "created") {
          created++;
          changes.push({
            type: "mr-created",
            collection: "monthlyResults",
            docId: mrRef.id,
            before: null,
            after: null,
          });
          // ランキング対象開始日の自動判定（初回データ登録時のみ・未設定の場合のみ。判定ロジックは変更しない）
          await maybeAutoSetRankingEligibleFrom(db, castId, targetMonth, targetDateTs, actorUid);
        } else if (mrOutcome.outcome === "updated") {
          updated++;
          changes.push({
            type: "mr-updated",
            collection: "monthlyResults",
            docId: mrRef.id,
            before: mrOutcome.before,
            after: mrRowBusinessFields(d.row),
          });
        } else {
          skipped++;
        }

        // 照合ルールの保存（確定内容を次回インポートの候補判定に利用）。
        // 「新規登録」は作成したキャストへの link として保存する
        // （同じファイルを再インポートしたときに重複登録せず紐付けさせるため）
        if (d.saveRule) {
          const effectiveAction = d.action === "new" ? "link" : d.action;
          const rule = buildRuleFromDecision(storeId, d.row, effectiveAction, castId);
          const res = await upsertNameMatchingRule(actorUid, rule);
          changes.push({
            type: res.created ? "rule-created" : "rule-updated",
            collection: "nameMatchingRules",
            docId: res.ruleId,
            before: res.before,
            after: {
              sourceName: rule.sourceName,
              decision: rule.decision,
              linkedCastId: rule.linkedCastId,
              hourlyWage: rule.hourlyWage,
              active: true,
            },
          });
        }
      }
    } catch (err) {
      errorMessages.push(`行${d.row.rowNumber}「${d.row.name}」: ${(err as Error).message}`);
    }
    done++;
    report();
  }

  // 確認フロー3: 在籍状態の変更適用
  if (!cancelled) {
    for (const s of statusDecisions) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      try {
        if (s.newStatus) {
          const ref = doc(db, "casts", s.castId);
          const prevStatus = await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) throw new Error("キャストが見つかりません");
            const cur = (snap.data() as { status?: string }).status ?? "";
            if (cur === s.newStatus) return null;
            tx.update(ref, {
              status: s.newStatus,
              updatedAt: serverTimestamp(),
              updatedBy: actorUid,
            });
            return cur;
          });
          if (prevStatus !== null) {
            changes.push({
              type: "cast-updated",
              collection: "casts",
              docId: s.castId,
              before: { status: prevStatus },
              after: { status: s.newStatus },
            });
          }
        }
      } catch (err) {
        errorMessages.push(`在籍状態の更新（${s.castId}）: ${(err as Error).message}`);
      }
      done++;
      report();
    }
  }

  // 最終ステータスの決定:
  // キャンセル時は保存済み変更の有無で cancelled / partial-cancelled
  // （completed には決してしない）。エラー全滅時は failed。
  if (cancelled) {
    status = finalizeCancelledStatus(changes.length);
  } else if (errorMessages.length > 0) {
    const attempted = decisions.length;
    if (created + updated + skipped === 0 && attempted > 0) status = "failed";
  }

  const unprocessed = total - done;
  const summary =
    `作成 ${created} / 上書き ${updated} / スキップ ${skipped} / エラー ${errorMessages.length}` +
    (cancelled ? ` / 未処理 ${unprocessed}（キャンセル）` : "");
  try {
    // changes は中断・失敗時も必ず保存する（部分実行分のロールバックのため）
    await completeImportBatch(
      batchId,
      {
        status,
        createdCount: created,
        updatedCount: updated,
        skippedCount: skipped,
        errorCount: errorMessages.length,
        summary,
      },
      changes
    );
  } catch (err) {
    errorMessages.push(`インポート履歴の更新に失敗: ${(err as Error).message}`);
  }

  try {
    await writeAuditLog({
      actorUid,
      actorName,
      action: "import.execute",
      collection: "importBatches",
      documentId: batchId,
      storeId,
      before: null,
      after: {
        fileName: params.fileName,
        targetMonth,
        status,
        createdCount: created,
        updatedCount: updated,
        skippedCount: skipped,
        errorCount: errorMessages.length,
      },
    });
  } catch {
    // 監査ログの書き込み失敗はインポート結果自体には影響させない
  }

  report();
  return {
    batchId,
    status,
    created,
    updated,
    skipped,
    errors: errorMessages.length,
    processed: done,
    unprocessed,
    savedChanges: changes.length,
    errorMessages,
  };
}

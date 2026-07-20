import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import {
  monthlyResultId,
  type BatchChange,
  type CastStatus,
  type MonthlyResultDoc,
  type RunStatus,
} from "@/types";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";
import type { RowAction } from "@/lib/excel/importMatching";
import { buildRuleFromDecision } from "@/lib/excel/importMatching";
import { createImportBatch, completeImportBatch } from "./importBatchService";
import { upsertNameMatchingRule } from "./nameMatchingRuleService";

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
}

export interface ImportResult {
  batchId: string;
  status: RunStatus;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
}

/** 月別成績の業務フィールドのみ（changes記録・復元用。メタは含めない） */
function mrRowBusinessFields(row: ExcelMonthlyRow): Record<string, unknown> {
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

function mrDataFromRow(
  storeId: string,
  castId: string,
  month: string,
  row: ExcelMonthlyRow,
  batchId: string,
  actorUid: string
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
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  };
}

export async function executeExcelImport(
  actorUid: string,
  params: {
    storeId: string;
    targetMonth: string; // YYYY-MM
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

  const report = () =>
    onProgress({ done, total, created, updated, skipped, errors: errorMessages.length });

  for (const d of decisions) {
    if (shouldCancel()) {
      status = "cancelled";
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
          const data = mrDataFromRow(storeId, castId!, targetMonth, d.row, batchId, actorUid);
          if (!snap.exists()) {
            tx.set(mrRef, { ...data, createdAt: serverTimestamp(), createdBy: actorUid });
            return { outcome: "created" as const, before: null };
          }
          if (d.existing === "overwrite") {
            // storeId / castId / month はID構造上同一。createdAt / createdBy は保持される
            const cur = snap.data() as MonthlyResultDoc;
            tx.update(mrRef, data);
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
  if (status !== "cancelled") {
    for (const s of statusDecisions) {
      if (shouldCancel()) {
        status = "cancelled";
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

  if (errorMessages.length > 0 && status === "completed") {
    // 一部エラーでも成功分は保存済み。全滅の場合はfailedにする
    const attempted = decisions.length;
    if (created + updated + skipped === 0 && attempted > 0) status = "failed";
  }

  const summary = `作成 ${created} / 上書き ${updated} / スキップ ${skipped} / エラー ${errorMessages.length}`;
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

  report();
  return {
    batchId,
    status,
    created,
    updated,
    skipped,
    errors: errorMessages.length,
    errorMessages,
  };
}

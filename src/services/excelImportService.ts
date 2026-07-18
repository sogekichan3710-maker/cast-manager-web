import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { monthlyResultId, type CastStatus, type RunStatus } from "@/types";
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
        }
        if (!castId) throw new Error(`行${d.row.rowNumber}「${d.row.name}」: 紐付け先キャストが未選択です`);

        // 時給変更（casts更新 + wageHistory追記を同一トランザクションで）
        if (d.action === "wage-change") {
          if (d.newWage == null || d.newWage <= 0) {
            throw new Error(`行${d.row.rowNumber}「${d.row.name}」: 変更後の時給が不正です`);
          }
          const castRef = doc(db, "casts", castId);
          const whRef = doc(collection(db, "wageHistory"));
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(castRef);
            if (!snap.exists()) throw new Error("キャストが見つかりません");
            const currentWage = (snap.data() as { hourlyWage?: number }).hourlyWage ?? 0;
            if (currentWage !== d.newWage) {
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
            }
          });
        }

        // 月別成績の保存（既存はskip/overwrite。overwriteは最新を取得して更新）
        const mrRef = doc(db, "monthlyResults", monthlyResultId(storeId, castId, targetMonth));
        const outcome = await runTransaction(db, async (tx) => {
          const snap = await tx.get(mrRef);
          const data = mrDataFromRow(storeId, castId!, targetMonth, d.row, batchId, actorUid);
          if (!snap.exists()) {
            tx.set(mrRef, { ...data, createdAt: serverTimestamp(), createdBy: actorUid });
            return "created" as const;
          }
          if (d.existing === "overwrite") {
            // storeId / castId / month はID構造上同一。createdAt / createdBy は保持される
            tx.update(mrRef, data);
            return "updated" as const;
          }
          return "skipped" as const;
        });
        if (outcome === "created") created++;
        else if (outcome === "updated") updated++;
        else skipped++;

        // 照合ルールの保存（確定内容を次回インポートの候補判定に利用）
        if (d.saveRule) {
          const rule = buildRuleFromDecision(storeId, d.row, d.action, castId);
          await upsertNameMatchingRule(actorUid, rule);
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
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) throw new Error("キャストが見つかりません");
            tx.update(ref, {
              status: s.newStatus,
              updatedAt: serverTimestamp(),
              updatedBy: actorUid,
            });
          });
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
    await completeImportBatch(batchId, {
      status,
      createdCount: created,
      updatedCount: updated,
      skippedCount: skipped,
      errorCount: errorMessages.length,
      summary,
    });
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

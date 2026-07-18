import * as XLSX from "xlsx";
import {
  payDiff,
  realHourlyWage,
  wageDiff,
  type CastWithId,
  type GoalWithId,
  type InterviewWithId,
  type MonthlyResultWithId,
  type MotivationWithId,
  type StoreWithId,
  type WageHistoryWithId,
} from "@/types";

/**
 * Excelエクスポート（旧HTML版のエクスポートを移植）。
 *
 * シート構成: キャスト一覧 / 月別成績 / 面談履歴 / 目標 / モチベーション / 時給履歴。
 * 列名は日本語、金額・件数は数値セル、日付・月は文字列（YYYY-MM-DD / YYYY-MM）で
 * 出力し、会社提出用データとして使用可能な形を維持する。
 * 計算列（給与差額・時給差額・実質時給）は保存データと同一の計算関数
 * （payDiff / wageDiff / realHourlyWage — 変更禁止）を使用する。
 */

export interface ExportData {
  stores: StoreWithId[];
  casts: CastWithId[];
  monthlyResults: MonthlyResultWithId[];
  interviews: InterviewWithId[];
  goals: GoalWithId[];
  motivations: MotivationWithId[];
  wageHistory: WageHistoryWithId[];
}

export function buildExportWorkbook(data: ExportData): XLSX.WorkBook {
  const storeName = (id: string) => data.stores.find((s) => s.id === id)?.name ?? id;
  const castById = new Map(data.casts.map((c) => [c.id, c]));
  const castName = (id: string) => castById.get(id)?.stageName ?? id;

  const wb = XLSX.utils.book_new();

  // ---- キャスト一覧 ----
  const castRows = data.casts.map((c) => ({
    店舗: storeName(c.storeId),
    源氏名: c.stageName,
    本名: c.realName,
    ふりがな: c.kana,
    時給: c.hourlyWage,
    ランク: c.rank,
    在籍状態: c.status,
    入店日: c.joinDate,
    退店日: c.leftDate,
    誕生日: c.birthday,
    電話: c.phone,
    LINE: c.line,
    担当者: c.manager,
    目標売上: c.targetSales,
    目標本指名: c.targetHonmei,
    目標同伴: c.targetDouhan,
    保証: c.guarantee,
    性格: c.personality,
    メモ: c.memo,
    アーカイブ: c.archived ? "済" : "",
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(castRows), "キャスト一覧");

  // ---- 月別成績（月別成績ページと同じ列順 + 入力項目） ----
  const mrRows = data.monthlyResults.map((m) => {
    const cast = castById.get(m.castId);
    const wage = cast?.hourlyWage ?? 0;
    return {
      月: m.month,
      店舗: storeName(m.storeId),
      キャスト: castName(m.castId),
      総売上: m.totalSales,
      支給額: m.payment,
      実質時給: realHourlyWage(m.payment, m.workHours, m.workDays) ?? "",
      給与差額: payDiff(m.totalSales, m.payment) ?? "",
      時給差額: wageDiff(m.totalSales, wage, m.workHours, m.workDays) ?? "",
      本指名: m.honshimeiCount,
      本指名組数: m.honshimeiGroupCount,
      顧客数: m.customerCount,
      場内: m.jounaiCount,
      同伴: m.douhan,
      出勤日数: m.workDays,
      出勤時間: m.workHours,
      欠勤: m.absent,
      備考: m.notes,
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mrRows), "月別成績");

  // ---- 面談履歴 ----
  const ivRows = data.interviews.map((iv) => ({
    面談日: iv.date,
    店舗: storeName(iv.storeId),
    キャスト: castName(iv.castId),
    担当者: iv.interviewer,
    フォロー必要度: iv.follow,
    面談内容: iv.content,
    悩み: iv.worries,
    決定事項: iv.decisions,
    次回予定日: iv.nextDate,
    次回課題: iv.nextTask,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ivRows), "面談履歴");

  // ---- 目標 ----
  const goalRows = data.goals.map((g) => ({
    月: g.month,
    店舗: storeName(g.storeId),
    キャスト: castName(g.castId),
    売上目標: g.salesTarget,
    本指名目標: g.honshimeiTarget,
    本指名組数目標: g.honGroupTarget,
    同伴目標: g.douhanTarget,
    場内目標: g.jounaiTarget,
    出勤日数目標: g.workDaysTarget,
    出勤時間目標: g.workHoursTarget,
    達成状況: g.status,
    メモ: g.memo,
    課題: g.task,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(goalRows), "目標");

  // ---- モチベーション ----
  const motiRows = data.motivations.map((m) => ({
    日付: m.date,
    店舗: storeName(m.storeId),
    キャスト: castName(m.castId),
    レベル: m.level,
    フォロー必要度: m.followNeed,
    フォロー予定日: m.followDate,
    現在の状態: m.state,
    危険信号: m.danger,
    フォロー内容: m.follow,
    成長ポイント: m.growth,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(motiRows), "モチベーション");

  // ---- 時給履歴 ----
  const whRows = data.wageHistory.map((w) => ({
    適用月: w.effectiveMonth,
    店舗: storeName(w.storeId),
    キャスト: castName(w.castId),
    変更前時給: w.oldHourlyWage,
    変更後時給: w.newHourlyWage,
    理由: w.reason,
    記録元: w.source ?? "",
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(whRows), "時給履歴");

  return wb;
}

/** ワークブックをxlsxバイナリ（ArrayBuffer）へ変換する */
export function workbookToArrayBuffer(wb: XLSX.WorkBook): ArrayBuffer {
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

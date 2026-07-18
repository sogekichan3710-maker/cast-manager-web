import { normalizeName } from "@/lib/nameNormalize";
import type { CastStatus, NameMatchingRuleWithId, RuleDecision } from "@/types";
import type { ExcelMonthlyRow } from "./parseMonthlyExcel";

/**
 * Excelインポートの照合ロジック（純関数・Firestore非依存）。
 *
 * 旧HTML版の3種確認フローを維持する:
 *  1. 時給変更候補   — 一致キャストの現在時給とExcel側時給が異なる
 *  2. 同名キャスト候補 — 完全一致が複数 / 類似候補のみ / 他店舗に同名
 *  3. 退店・在籍状態の確認候補
 *     - Excelに存在するが在籍状態が「退店」「休職」のキャスト
 *     - 対象店舗に「在籍」だがExcelに存在しないキャスト（退店の可能性）
 *
 * 同名キャストを自動で統合することはなく、確認が必要な行は必ず
 * needsConfirm となり、ユーザーが行ごとに紐付け/新規/時給変更/除外を選ぶ。
 */

/** 照合に必要なキャスト情報（CastWithIdのサブセット） */
export interface MatchableCast {
  id: string;
  storeId: string;
  stageName: string;
  realName: string;
  kana: string;
  hourlyWage: number;
  status: CastStatus;
  archived: boolean;
}

export type RowAction = "link" | "new" | "wage-change" | "exclude";

export interface MatchCandidate {
  cast: MatchableCast;
  /** exact: 対象店舗内で正規化名が完全一致 / similar: 類似（他店舗同名・部分一致・ふりがな一致） */
  matchType: "exact" | "similar";
  /** 候補理由（表示用） */
  reason: string;
}

export interface RowMatch {
  row: ExcelMonthlyRow;
  candidates: MatchCandidate[];
  /** 提案するアクション（ユーザーが変更可能） */
  suggestedAction: RowAction;
  /** link / wage-change 時の提案先キャスト */
  suggestedCastId: string | null;
  /** nameMatchingRules が適用されたか */
  ruleApplied: boolean;
  /** ルールはあるが自動確定できない理由（空なら自動確定可） */
  ruleReconfirmReasons: string[];
  /** 確認フロー1: 時給変更候補（一致キャストと時給が異なる） */
  wageChange: { castId: string; oldWage: number; newWage: number } | null;
  /** 確認フロー2: 同名キャスト候補（複数一致・類似のみ等） */
  sameNameConfirm: boolean;
  /** 確認フロー3: 在籍状態の確認（一致キャストが退店・休職・アーカイブ） */
  statusConfirm: string | null;
  /** ユーザー確認なしで確定してよい行か */
  needsConfirm: boolean;
}

export interface MatchResult {
  matches: RowMatch[];
  /** 確認フロー3: 対象店舗に在籍だがExcelに存在しないキャスト（退店確認候補） */
  missingCasts: MatchableCast[];
}

/**
 * ルール適用後も再確認が必要になる時給差の閾値（円）。
 * 旧版の具体値は旧index.html消失により再確認できないため、
 * 「大幅な時給差」の判定として500円以上を採用（要調整の場合は定数変更）。
 */
export const WAGE_GAP_RECONFIRM = 500;

export function matchExcelRows(
  rows: ExcelMonthlyRow[],
  targetStoreId: string,
  casts: MatchableCast[],
  rules: NameMatchingRuleWithId[]
): MatchResult {
  const storeCasts = casts.filter((c) => c.storeId === targetStoreId);
  const ruleByName = new Map<string, NameMatchingRuleWithId>();
  for (const r of rules) {
    if (r.active && r.storeId === targetStoreId) ruleByName.set(r.normalizedName, r);
  }
  const castById = new Map(casts.map((c) => [c.id, c]));

  const matchedCastIds = new Set<string>();
  const matches: RowMatch[] = rows.map((row) => {
    const norm = normalizeName(row.name);

    // ---- 候補収集 ----
    const candidates: MatchCandidate[] = [];
    const exactInStore = storeCasts.filter((c) => normalizeName(c.stageName) === norm);
    for (const c of exactInStore) {
      candidates.push({
        cast: c,
        matchType: "exact",
        reason: c.archived ? "源氏名が完全一致（アーカイブ済み）" : "源氏名が完全一致",
      });
    }
    // 類似: 対象店舗内の本名一致・ふりがな一致・部分一致
    for (const c of storeCasts) {
      if (exactInStore.includes(c)) continue;
      const nStage = normalizeName(c.stageName);
      const nReal = normalizeName(c.realName);
      const nKana = normalizeName(c.kana);
      if (nReal && nReal === norm) {
        candidates.push({ cast: c, matchType: "similar", reason: "本名が一致" });
      } else if (nKana && nKana === norm) {
        candidates.push({ cast: c, matchType: "similar", reason: "ふりがなが一致" });
      } else if (
        norm.length >= 2 &&
        nStage.length >= 2 &&
        (nStage.includes(norm) || norm.includes(nStage))
      ) {
        candidates.push({ cast: c, matchType: "similar", reason: "源氏名が部分一致" });
      }
    }
    // 類似: 他店舗の同名（自動紐付けはしない・確認用に表示のみ）
    for (const c of casts) {
      if (c.storeId === targetStoreId) continue;
      if (normalizeName(c.stageName) === norm) {
        candidates.push({ cast: c, matchType: "similar", reason: "他店舗に同名キャスト" });
      }
    }

    // ---- 判定 ----
    const activeExact = exactInStore.filter((c) => !c.archived);
    const single = activeExact.length === 1 ? activeExact[0] : null;
    const multipleSameName = exactInStore.length > 1;

    let suggestedAction: RowAction;
    let suggestedCastId: string | null = null;
    let wageChange: RowMatch["wageChange"] = null;
    let statusConfirm: string | null = null;
    let sameNameConfirm = false;
    let needsConfirm = true;

    if (single) {
      suggestedCastId = single.id;
      // 確認フロー1: 時給変更候補
      if (row.hourlyWage != null && row.hourlyWage > 0 && row.hourlyWage !== single.hourlyWage) {
        suggestedAction = "wage-change";
        wageChange = { castId: single.id, oldWage: single.hourlyWage, newWage: row.hourlyWage };
      } else {
        suggestedAction = "link";
      }
      // 確認フロー3: 退店・休職キャストがExcelに出現
      if (single.status !== "在籍") {
        statusConfirm = `在籍状態が「${single.status}」のキャストがExcelに含まれています`;
      }
      // 完全一致1件・時給同一・在籍のみ自動確定候補
      needsConfirm = !(suggestedAction === "link" && statusConfirm === null);
    } else if (multipleSameName) {
      // 確認フロー2: 同名キャスト候補（自動で統合しない）
      suggestedAction = "link";
      sameNameConfirm = true;
    } else if (exactInStore.length === 1 && exactInStore[0].archived) {
      suggestedAction = "link";
      suggestedCastId = exactInStore[0].id;
      statusConfirm = "一致したキャストはアーカイブ済みです";
      sameNameConfirm = false;
    } else if (candidates.length > 0) {
      // 類似候補のみ → 同名・類似確認
      suggestedAction = "new";
      sameNameConfirm = true;
    } else {
      suggestedAction = "new";
    }

    // ---- nameMatchingRules の適用 ----
    const rule = ruleByName.get(norm);
    let ruleApplied = false;
    const ruleReconfirmReasons: string[] = [];
    if (rule) {
      ruleApplied = true;
      const linked = rule.linkedCastId ? castById.get(rule.linkedCastId) : undefined;
      if (rule.decision === "link") {
        if (!rule.linkedCastId || !linked) {
          ruleReconfirmReasons.push("ルールのリンク先キャストが存在しません");
        } else {
          if (linked.storeId !== targetStoreId) {
            ruleReconfirmReasons.push("ルールのリンク先キャストが対象店舗と異なります");
          }
          if (linked.archived) {
            ruleReconfirmReasons.push("ルールのリンク先キャストはアーカイブ済みです");
          }
          if (
            row.hourlyWage != null &&
            row.hourlyWage > 0 &&
            Math.abs(row.hourlyWage - linked.hourlyWage) >= WAGE_GAP_RECONFIRM
          ) {
            ruleReconfirmReasons.push(
              `時給差が大きいため再確認が必要です（現在 ¥${linked.hourlyWage.toLocaleString()} / Excel ¥${row.hourlyWage.toLocaleString()}）`
            );
          }
        }
      }
      if (multipleSameName) {
        ruleReconfirmReasons.push("同名キャストが複数存在します");
      }
      if (ruleReconfirmReasons.length === 0) {
        // ルールで自動確定（時給変更の要否は上の判定を維持）
        if (rule.decision === "link" && rule.linkedCastId) {
          suggestedCastId = rule.linkedCastId;
          const linkedCast = castById.get(rule.linkedCastId)!;
          if (
            row.hourlyWage != null &&
            row.hourlyWage > 0 &&
            row.hourlyWage !== linkedCast.hourlyWage
          ) {
            suggestedAction = "wage-change";
            wageChange = {
              castId: linkedCast.id,
              oldWage: linkedCast.hourlyWage,
              newWage: row.hourlyWage,
            };
            needsConfirm = true; // 時給変更は常に確認
          } else {
            suggestedAction = "link";
            sameNameConfirm = false;
            needsConfirm = statusConfirm !== null;
          }
        } else if (rule.decision === "new") {
          suggestedAction = "new";
          sameNameConfirm = false;
          needsConfirm = false;
        } else if (rule.decision === "exclude") {
          suggestedAction = "exclude";
          sameNameConfirm = false;
          needsConfirm = false;
        }
      } else {
        needsConfirm = true;
      }
    }

    if (suggestedCastId) matchedCastIds.add(suggestedCastId);
    for (const c of exactInStore) matchedCastIds.add(c.id);

    return {
      row,
      candidates,
      suggestedAction,
      suggestedCastId,
      ruleApplied,
      ruleReconfirmReasons,
      wageChange,
      sameNameConfirm,
      statusConfirm,
      needsConfirm,
    };
  });

  // 確認フロー3: 在籍だがExcelに無いキャスト（退店・状態確認候補）
  const missingCasts = storeCasts.filter(
    (c) => !c.archived && c.status === "在籍" && !matchedCastIds.has(c.id)
  );

  return { matches, missingCasts };
}

/** 確定時にnameMatchingRulesへ保存する内容を作る */
export function buildRuleFromDecision(
  storeId: string,
  row: ExcelMonthlyRow,
  action: RowAction,
  linkedCastId: string | null
): {
  storeId: string;
  sourceName: string;
  normalizedName: string;
  decision: RuleDecision;
  linkedCastId: string | null;
  hourlyWage: number | null;
} {
  return {
    storeId,
    sourceName: row.name,
    normalizedName: normalizeName(row.name),
    decision: action === "exclude" ? "exclude" : action === "new" ? "new" : "link",
    linkedCastId: action === "link" || action === "wage-change" ? linkedCastId : null,
    hourlyWage: row.hourlyWage,
  };
}

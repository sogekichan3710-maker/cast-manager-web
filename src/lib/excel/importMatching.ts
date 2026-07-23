import { normalizeName } from "@/lib/nameNormalize";
import type { CastStatus, NameMatchingRuleWithId, RuleDecision } from "@/types";
import type { ExcelMonthlyRow } from "./parseMonthlyExcel";

/**
 * Excelインポートの照合ロジック（純関数・Firestore非依存）。
 *
 * 照合は「対象店舗内での源氏名の正規化後**完全一致**」のみで判定する。
 * 部分一致・類似一致・本名/ふりがな一致・他店舗同名などの類似候補は
 * 実運用で誤操作・混乱の原因になるため、内部判定を含め一切行わない
 * （「れい」「れいな」「みれい」は互いに別人として扱う）。
 *
 * 判定仕様:
 *  - 完全一致が1人だけ → 自動で既存キャストへ紐付け（照合画面に出さない）
 *    ただし 時給差あり（時給変更候補）/ 退店・休職 / アーカイブ済み /
 *    照合ルールとの矛盾 がある場合のみ要確認
 *  - 完全一致が存在しない → 新規キャストとして扱う（自動確定）
 *  - 完全一致が複数 → 紐付け先の選択画面を表示（唯一の手動選択ケース）
 *
 * 照合ルール（nameMatchingRules）は次回インポート時の最優先ルールとして扱う。
 * 一度「既存キャストへ紐付け」を保存すると、以降は
 *  - 完全一致が複数（同名キャストが複数存在する）
 *  - 時給差がある（ただし時給自体は自動更新しない。上書きしたい場合は
 *    キャスト編集画面から変更するか、大きな差（WAGE_GAP_RECONFIRM以上）の
 *    場合はルールが無効化され通常照合に戻る）
 * のいずれであっても再確認せず、保存済みのキャストへ自動で紐付ける。
 * ルールが無効化され通常照合に戻るのは、リンク先キャストが削除済み
 * （存在しない）／店舗が異なる／アーカイブ済み／時給差が極端に大きい
 * 場合のみ。
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
  /**
   * スカウト者（PR10で追加・表示専用）。照合の判定には一切使わず、
   * 照合確認画面で「同一人物か別人か」の判断材料として表示するために保持する。
   */
  scoutedBy: string;
}

export type RowAction = "link" | "new" | "wage-change" | "exclude";

/** 紐付け候補（対象店舗内の完全一致のみ） */
export interface MatchCandidate {
  cast: MatchableCast;
  /** 候補理由（表示用） */
  reason: string;
}

export interface RowMatch {
  row: ExcelMonthlyRow;
  /** 対象店舗内で源氏名が完全一致したキャスト（類似候補は含まない） */
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
  /** 確認フロー2: 完全一致が複数（唯一の紐付け先選択ケース） */
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

    // ---- 候補収集: 対象店舗内の完全一致のみ（類似判定はしない） ----
    const exactInStore = storeCasts.filter((c) => normalizeName(c.stageName) === norm);
    const candidates: MatchCandidate[] = exactInStore.map((c) => ({
      cast: c,
      reason: c.archived ? "源氏名が完全一致（アーカイブ済み）" : "源氏名が完全一致",
    }));

    // ---- 判定 ----
    const activeExact = exactInStore.filter((c) => !c.archived);
    const single = activeExact.length === 1 && exactInStore.length === 1 ? activeExact[0] : null;
    const multipleSameName = exactInStore.length > 1;

    let suggestedAction: RowAction;
    let suggestedCastId: string | null = null;
    let wageChange: RowMatch["wageChange"] = null;
    let statusConfirm: string | null = null;
    let sameNameConfirm = false;
    let needsConfirm = false;

    if (single) {
      // 完全一致が1人だけ → 自動紐付け（例外時のみ要確認）
      suggestedCastId = single.id;
      if (row.hourlyWage != null && row.hourlyWage > 0 && row.hourlyWage !== single.hourlyWage) {
        // 確認フロー1: 時給変更候補
        suggestedAction = "wage-change";
        wageChange = { castId: single.id, oldWage: single.hourlyWage, newWage: row.hourlyWage };
        needsConfirm = true;
      } else {
        suggestedAction = "link";
      }
      if (single.status !== "在籍") {
        // 確認フロー3: 退店・休職キャストがExcelに出現
        statusConfirm = `在籍状態が「${single.status}」のキャストがExcelに含まれています`;
        needsConfirm = true;
      }
    } else if (multipleSameName) {
      // 確認フロー2: 完全一致が複数 → 唯一の紐付け先選択ケース
      suggestedAction = "link";
      sameNameConfirm = true;
      needsConfirm = true;
    } else if (exactInStore.length === 1) {
      // 完全一致1件だがアーカイブ済み
      suggestedAction = "link";
      suggestedCastId = exactInStore[0].id;
      statusConfirm = "一致したキャストはアーカイブ済みです";
      needsConfirm = true;
    } else {
      // 完全一致なし → 新規キャストとして扱う（自動確定）
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
      if (rule.decision === "new" && exactInStore.length > 0) {
        // 以前「新規登録」で確定した名前でも、同名キャストが既に存在する場合は
        // 自動で再び新規登録しない（再インポートでのキャスト重複を防ぐ）
        ruleReconfirmReasons.push(
          "以前は新規登録しましたが、同名キャストが既に存在するため再確認が必要です"
        );
      }
      // 保存済み照合ルールは次回インポートの最優先ルールとして扱う。
      // 「完全一致が複数（同名キャストが複数存在する）」はルールが既に
      // どのキャストかを一意に特定しているため再確認しない。時給差についても、
      // ルールで特定したキャストへの紐付けを妨げない（時給は上書きしない。
      // 変更したい場合はキャスト編集画面から行う）。
      // 唯一の例外はリンク先キャストが削除済み／店舗不一致／アーカイブ済み、
      // または時給差が極端に大きい場合（上のブロックでruleReconfirmReasonsに
      // 積まれ、下のelseで通常照合へフォールバックする）。
      if (ruleReconfirmReasons.length === 0) {
        if (rule.decision === "link" && rule.linkedCastId) {
          suggestedCastId = rule.linkedCastId;
          const linkedCast = castById.get(rule.linkedCastId)!;
          suggestedAction = "link";
          wageChange = null;
          sameNameConfirm = false;
          if (linkedCast.status !== "在籍") {
            statusConfirm = `在籍状態が「${linkedCast.status}」のキャストがExcelに含まれています`;
            needsConfirm = true;
          } else {
            statusConfirm = null;
            needsConfirm = false;
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

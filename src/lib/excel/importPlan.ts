import type { RowAction, RowMatch } from "./importMatching";

/**
 * インポート実行計画（純関数・テスト可能）。
 * 照合結果から行ごとの初期状態を作り、実行前サマリーを集計する。
 *
 * 安全対策:
 * - 要確認行（needsConfirm）の初期状態は action: null（未選択）とし、
 *   自動で「新規キャストとして登録」にしない
 * - 未選択の行が残っている間はインポートを実行できない（summary.unresolved で判定）
 * - 既に同月の成績が存在する行の初期状態は「スキップ」（上書きは明示選択のみ）
 */

export interface PlanRowState {
  match: RowMatch;
  /** null = 未選択。ユーザーが明示的に選ぶまでインポート実行不可 */
  action: RowAction | null;
  castId: string | null;
  existing: "none" | "skip" | "overwrite";
  saveRule: boolean;
  /**
   * 自動確定された行（照合時点で確認不要と判定され、初期アクションが
   * 設定された行）。追加のチェック操作なしで実行対象に含まれる。
   * ユーザーが手動で変更しても実行可能なことに変わりはない。
   */
  autoConfirmed: boolean;
}

/** 照合結果から初期状態を作る */
export function buildInitialRowStates(
  matches: RowMatch[],
  existingCastIds: Set<string>
): PlanRowState[] {
  return matches.map((m) => {
    // 要確認行は未選択で開始（自動確定行のみ提案アクションを初期選択）
    const action: RowAction | null = m.needsConfirm ? null : m.suggestedAction;
    const state: PlanRowState = {
      match: m,
      action,
      castId: m.suggestedCastId,
      existing: "none",
      saveRule: true,
      autoConfirmed: !m.needsConfirm,
    };
    return recomputeExisting(state, existingCastIds);
  });
}

/** 紐付け先・アクション変更後に既存成績の有無を再判定する */
export function recomputeExisting(
  state: PlanRowState,
  existingCastIds: Set<string>
): PlanRowState {
  const cid = state.action === "new" ? null : state.castId;
  const hasExisting = !!cid && existingCastIds.has(cid);
  return {
    ...state,
    existing: hasExisting ? (state.existing === "none" ? "skip" : state.existing) : "none",
  };
}

export interface PlanSummary {
  total: number;
  /** 自動確定済み */
  autoConfirmed: number;
  /** 要確認（照合時点で確認が必要と判定された行） */
  needsConfirm: number;
  /** 新規キャスト登録 */
  newCasts: number;
  /** 既存キャストへの紐付け（時給変更含まず） */
  links: number;
  /** 時給変更として処理 */
  wageChanges: number;
  /** 既存成績の上書き */
  overwrite: number;
  /** 既存成績ありでスキップ */
  skipExisting: number;
  /** インポート対象から除外 */
  excluded: number;
  /** 未選択（要確認が未解決） */
  unresolved: number;
}

export function summarizePlan(states: PlanRowState[]): PlanSummary {
  const s: PlanSummary = {
    total: states.length,
    autoConfirmed: 0,
    needsConfirm: 0,
    newCasts: 0,
    links: 0,
    wageChanges: 0,
    overwrite: 0,
    skipExisting: 0,
    excluded: 0,
    unresolved: 0,
  };
  for (const st of states) {
    if (st.autoConfirmed) s.autoConfirmed++;
    if (st.match.needsConfirm) s.needsConfirm++;
    if (st.action === null) {
      s.unresolved++;
      continue;
    }
    if (st.action === "exclude") {
      s.excluded++;
      continue;
    }
    if (st.action === "new") s.newCasts++;
    else if (st.action === "wage-change") s.wageChanges++;
    else s.links++;
    if (st.action !== "new") {
      if (st.existing === "overwrite") s.overwrite++;
      else if (st.existing === "skip") s.skipExisting++;
    }
  }
  return s;
}

/**
 * インポート実行可否。
 * 未選択（action: null）が1件でも残っていれば実行不可。
 * 自動確定済み行は action が設定済みのため未選択扱いにならない
 * （自動確定のみでも実行可能）。
 */
export function canExecutePlan(states: PlanRowState[]): boolean {
  return states.length > 0 && states.every((st) => st.action !== null);
}

// ---------------- 絞り込み ----------------

export type RowFilterId =
  | "all"
  | "unresolved"
  | "needsConfirm"
  | "autoConfirmed"
  | "exactMatch"
  | "newCandidate"
  | "wageChange"
  | "archivedCandidate"
  | "multiCandidate";

export const ROW_FILTERS: ReadonlyArray<{ id: RowFilterId; label: string }> = [
  { id: "all", label: "すべて" },
  { id: "unresolved", label: "未選択のみ" },
  { id: "needsConfirm", label: "要確認のみ" },
  { id: "autoConfirmed", label: "自動確定済みのみ" },
  { id: "exactMatch", label: "完全一致のみ" },
  { id: "newCandidate", label: "新規候補のみ" },
  { id: "wageChange", label: "時給変更候補のみ" },
  { id: "archivedCandidate", label: "アーカイブ済み候補のみ" },
  { id: "multiCandidate", label: "複数候補のみ" },
];

export function rowMatchesFilter(st: PlanRowState, filter: RowFilterId): boolean {
  const m = st.match;
  switch (filter) {
    case "all":
      return true;
    case "unresolved":
      return st.action === null;
    case "needsConfirm":
      return m.needsConfirm;
    case "autoConfirmed":
      return st.autoConfirmed;
    case "exactMatch":
      return m.candidates.some((c) => c.matchType === "exact");
    case "newCandidate":
      return m.candidates.length === 0;
    case "wageChange":
      return m.wageChange !== null;
    case "archivedCandidate":
      return m.candidates.some((c) => c.cast.archived);
    case "multiCandidate":
      return m.sameNameConfirm || m.candidates.filter((c) => c.matchType === "exact").length > 1;
  }
}

// ---------------- 一括操作 ----------------

/**
 * 完全一致のみ一括で既存キャストへ紐付け。
 * 自動確定条件と同じ厳しさ: 対象店舗の完全一致候補が1件のみ・
 * 非アーカイブ・在籍・時給差なし・ルール矛盾なし の行だけに適用する。
 * （時給変更候補・同名複数・アーカイブ済みは対象外 = 手動確認のまま）
 */
export function bulkLinkExactRows(states: PlanRowState[]): {
  states: PlanRowState[];
  applied: number;
} {
  let applied = 0;
  const next = states.map((st) => {
    const m = st.match;
    const exacts = m.candidates.filter((c) => c.matchType === "exact");
    const eligible =
      exacts.length === 1 &&
      !exacts[0].cast.archived &&
      exacts[0].cast.status === "在籍" &&
      m.wageChange === null &&
      m.ruleReconfirmReasons.length === 0 &&
      m.statusConfirm === null;
    if (!eligible) return st;
    applied++;
    return { ...st, action: "link" as RowAction, castId: exacts[0].cast.id };
  });
  return { states: next, applied };
}

/**
 * 候補なしのみ一括新規登録の対象行。
 * 空欄・数値のみ・集計項目・無効な名前・解析信頼度が低い行は
 * パーサー段階で除外済みのため到達しない。ここではさらに
 * 「候補（重複の可能性）が1件でもある行」「ルールと矛盾する行」
 * 「ルールで除外確定済みの行」を対象外にする。
 */
export function listBulkNewEligible(states: PlanRowState[]): PlanRowState[] {
  return states.filter((st) => {
    const m = st.match;
    return (
      m.candidates.length === 0 &&
      m.ruleReconfirmReasons.length === 0 &&
      !(m.ruleApplied && m.suggestedAction === "exclude")
    );
  });
}

/** 一括新規登録を適用する（listBulkNewEligible と同じ条件の行のみ変更） */
export function bulkNewNoCandidateRows(states: PlanRowState[]): {
  states: PlanRowState[];
  applied: number;
} {
  const eligibleSet = new Set(listBulkNewEligible(states));
  let applied = 0;
  const next = states.map((st) => {
    if (!eligibleSet.has(st)) return st;
    applied++;
    return { ...st, action: "new" as RowAction, castId: null };
  });
  return { states: next, applied };
}

/** 一括新規登録の警告件数閾値 */
export const BULK_NEW_WARN_COUNT = 30;

/** 指定行（未指定なら全行）をインポート対象外にする */
export function bulkExcludeRows(
  states: PlanRowState[],
  targetIndices?: ReadonlySet<number>
): { states: PlanRowState[]; applied: number } {
  let applied = 0;
  const next = states.map((st, i) => {
    if (targetIndices && !targetIndices.has(i)) return st;
    if (st.action === "exclude") return st;
    applied++;
    return { ...st, action: "exclude" as RowAction };
  });
  return { states: next, applied };
}

/** 指定行（未指定なら全行）の選択を解除して未選択へ戻す */
export function bulkClearSelection(
  states: PlanRowState[],
  targetIndices?: ReadonlySet<number>
): { states: PlanRowState[]; applied: number } {
  let applied = 0;
  const next = states.map((st, i) => {
    if (targetIndices && !targetIndices.has(i)) return st;
    if (st.action === null) return st;
    applied++;
    return { ...st, action: null };
  });
  return { states: next, applied };
}

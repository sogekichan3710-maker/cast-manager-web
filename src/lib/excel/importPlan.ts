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
    newCasts: 0,
    links: 0,
    wageChanges: 0,
    overwrite: 0,
    skipExisting: 0,
    excluded: 0,
    unresolved: 0,
  };
  for (const st of states) {
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

/** インポート実行可否（未選択が残っていれば false） */
export function canExecutePlan(states: PlanRowState[]): boolean {
  return states.length > 0 && states.every((st) => st.action !== null);
}

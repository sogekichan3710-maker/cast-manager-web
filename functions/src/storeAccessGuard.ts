/**
 * accessibleStoreIds設定の入力検証ロジック（PR5レビュー対応）。
 *
 * Firestore（storeの実在・active判定）に依存しない部分だけを純粋関数として
 * 分離し、functions/ 単体のvitestで検証できるようにする。店舗の実在・active
 * チェックはFirestoreの実データが必要なため index.ts 側（トランザクション内）
 * で行う。
 */
export class StoreAccessGuardError extends Error {
  constructor(
    message: string,
    public code: "invalid-input" | "confirm-empty-required" = "invalid-input"
  ) {
    super(message);
    this.name = "StoreAccessGuardError";
  }
}

/**
 * storeIds入力を正規化する。
 * - 文字列配列以外は拒否
 * - '__all__' は拒否（storeIdは個別店舗のみ・全店舗表現はowner側の
 *   role判定で行うため設定として保存させない）
 * - 重複は除去
 * - 空配列（全店舗アクセスの剥奪）は confirmEmpty が true の場合のみ許可
 */
export function normalizeStoreIds(rawStoreIds: unknown, confirmEmpty: boolean): string[] {
  if (!Array.isArray(rawStoreIds) || !rawStoreIds.every((s) => typeof s === "string")) {
    throw new StoreAccessGuardError("storeIds は文字列配列で指定してください");
  }
  if (rawStoreIds.includes("__all__")) {
    throw new StoreAccessGuardError("'__all__' はstoreIdとして指定できません");
  }
  const deduped = Array.from(new Set(rawStoreIds));
  if (deduped.length === 0 && !confirmEmpty) {
    throw new StoreAccessGuardError(
      "閲覧可能店舗を空にする場合は confirmEmpty を true にして再実行してください",
      "confirm-empty-required"
    );
  }
  return deduped;
}

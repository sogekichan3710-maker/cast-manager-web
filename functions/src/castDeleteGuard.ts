/**
 * キャスト完全削除Functionの再実行（冪等性）判定ロジック（PR5レビュー対応）。
 *
 * Firestoreの実際の状態（キャストが存在するか・完全削除の監査ログが
 * 既に存在するか）から、今回の呼び出しで何をすべきかを純粋関数として
 * 判定する。Admin SDKに依存しないため、functions/ 単体のvitestで
 * 検証できる。
 *
 * - proceed: キャストが存在する（初回実行、または関連データ削除の途中で
 *   失敗した後の再実行）。関連データ削除→キャスト本体削除→監査ログ記録を
 *   最初から（＝残っているものだけ）やり直す。各コレクションはcastIdで
 *   再クエリするため、既に削除済みの分は自然にスキップされる。
 * - already-deleted: キャストが存在せず、かつ完全削除の監査ログが
 *   既に存在する＝前回の呼び出しで完了済み。再実行しても何もしない
 *   （クライアントの二重送信・タイムアウト後の再試行に対して安全）。
 * - not-found: キャストが存在せず、完全削除の監査ログも存在しない
 *   ＝そもそも存在しないcastId（誤入力等）。エラーとして扱う。
 */
export type CastDeleteOutcome = "proceed" | "already-deleted" | "not-found";

export function resolveCastDeleteOutcome(
  castExists: boolean,
  priorDeleteLogExists: boolean
): CastDeleteOutcome {
  if (castExists) return "proceed";
  if (priorDeleteLogExists) return "already-deleted";
  return "not-found";
}

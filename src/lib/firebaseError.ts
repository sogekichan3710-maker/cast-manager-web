import { FirebaseError } from "firebase/app";

/**
 * Firestore/Firebaseのエラーコードを利用者向けの日本語メッセージへ変換する。
 * 開発時の原因調査は呼び出し側で logFirebaseError を使ってコンソールに
 * 実際のエラーコード・メッセージを出す（画面には出さない）。
 */
export function describeFirebaseError(error: unknown): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case "permission-denied":
        return "権限がありません。対象店舗を操作する権限がない可能性があります。";
      case "unauthenticated":
        return "ログインが必要です。再度ログインしてください。";
      case "invalid-argument":
      case "failed-precondition":
        return "必須項目が不足しています。入力内容を確認してください。";
      default:
        return "保存に失敗しました。時間をおいて再度お試しください。";
    }
  }
  return error instanceof Error ? error.message : "保存に失敗しました";
}

/** 開発時の原因調査用に、実際のFirebaseエラーコード・内容をコンソールへ出す */
export function logFirebaseError(
  label: string,
  error: unknown,
  context: Record<string, unknown>
): void {
  console.error(label, {
    error,
    code: error instanceof FirebaseError ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
    ...context,
  });
}

/**
 * キャスト名の正規化。
 * 既存のキャスト検索（/casts の norm）と同じ方針:
 * NFKC（全角半角統一）+ 小文字化 + 前後空白除去。
 * 照合用にはさらに名前内部の空白も除去する（「あい り」と「あいり」を同一視）。
 */
export function normalizeName(raw: string): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "");
}

/**
 * グラフ用の金額表示フォーマッタ（PR6）。
 *
 * 「1200k」「2025k」のような英語圏の桁区切り（k=千）は直感的に読めないため、
 * 日本語の万単位表示（例: 500,000円 → 50万円 / 2,025,000円 → 202万5,000円）に
 * 統一する。1万未満はそのまま円表示にする。負の値は先頭に「-」を付ける。
 * グラフの軸ラベル・ツールチップ・点ラベルすべてでこの関数を使うことで
 * 表示形式を統一する。
 */
export function fmtYenJa(v: number): string {
  const rounded = Math.round(v);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  if (abs < 10000) return `${sign}${abs.toLocaleString("ja-JP")}円`;
  const man = Math.floor(abs / 10000);
  const rem = abs % 10000;
  return rem === 0
    ? `${sign}${man}万円`
    : `${sign}${man}万${rem.toLocaleString("ja-JP")}円`;
}

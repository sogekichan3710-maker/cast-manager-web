import { fmtDiff } from "@/types";

/**
 * 差額（給与差額・時給差額など）をマイナス値は赤字で表示する共通コンポーネント
 * （PR6）。表示形式そのものは既存の fmtDiff（-¥1,234 形式）を維持する。
 */
export function DiffAmount({ value }: { value: number | null }) {
  const negative = value != null && value < 0;
  return (
    <span style={negative ? { color: "var(--red)" } : undefined}>{fmtDiff(value)}</span>
  );
}

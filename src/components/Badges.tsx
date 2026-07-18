"use client";

/** 在籍状態バッジ（在籍=緑 / 休職=黄 / 退店=赤） */
export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "在籍" ? "badge-green" : status === "休職" ? "badge-yellow" : "badge-red";
  return <span className={`badge ${cls}`}>{status}</span>;
}

/** ランクバッジ（既存ローカル版の配色を踏襲: A+=赤 / A系=橙 / B系=黄 / C系=灰） */
export function RankBadge({ rank }: { rank: string }) {
  const cls =
    rank === "A+"
      ? "badge-red"
      : rank.startsWith("A")
        ? "badge-orange"
        : rank.startsWith("B")
          ? "badge-yellow"
          : "badge-gray";
  return <span className={`badge ${cls}`}>{rank}</span>;
}

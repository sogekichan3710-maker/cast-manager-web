import { realHourlyWage, type CastWithId, type MonthlyResultWithId } from "@/types";

/**
 * ランキング7カテゴリ（既存ローカル版 _RANK_CATS の移植）。
 * key / fmt / sub の数値定義は旧版と同一。
 */

export interface RankCat {
  id: string;
  label: string;
  key: (r: MonthlyResultWithId) => number;
  fmt: (v: number) => string;
  sub: ((r: MonthlyResultWithId) => string | null) | null;
}

const fmtNum = (v: number) => Math.round(v).toLocaleString();

export const RANK_CATS: RankCat[] = [
  {
    id: "sales",
    label: "🏆 売上",
    key: (r) => r.totalSales || 0,
    fmt: (v) => "¥" + fmtNum(v),
    // 旧版: 売上カテゴリのsubは本指名本数
    sub: (r) => `${r.honshimeiCount || 0}本`,
  },
  {
    id: "honmei",
    label: "💎 指名",
    key: (r) => r.honshimeiCount || 0,
    fmt: (v) => v + "本",
    sub: null,
  },
  {
    id: "douhan",
    label: "🌙 同伴",
    key: (r) => r.douhan || 0,
    fmt: (v) => v + "件",
    sub: null,
  },
  {
    id: "jounai",
    label: "🏠 場内",
    key: (r) => r.jounaiCount || 0,
    fmt: (v) => v + "本",
    sub: null,
  },
  {
    id: "workdays",
    label: "📅 出勤日数",
    key: (r) => r.workDays || 0,
    fmt: (v) => v + "日",
    sub: (r) =>
      r.workHours > 0
        ? r.workHours.toFixed(1) + "h"
        : r.workDays
          ? (r.workDays * 4.5).toFixed(1) + "h"
          : null,
  },
  {
    id: "workhours",
    label: "⏱ 出勤時間",
    key: (r) => (r.workHours > 0 ? r.workHours : r.workDays ? r.workDays * 4.5 : 0),
    fmt: (v) => v.toFixed(1) + "h",
    sub: (r) => `${r.workDays || 0}日`,
  },
  {
    id: "realwage",
    label: "💹 実質時給",
    key: (r) => {
      const rw = realHourlyWage(r.payment, r.workHours, r.workDays);
      return rw ?? -1;
    },
    fmt: (v) => (v < 0 ? "-" : "¥" + v.toLocaleString()),
    sub: (r) => {
      const h = r.workHours > 0 ? r.workHours : r.workDays ? r.workDays * 4.5 : 0;
      return h ? h.toFixed(1) + "h" : null;
    },
  },
];

/**
 * 実績（対象月のmonthlyResults）が1件も無いキャスト用のプレースホルダ。
 * 表示専用のダミーレコードであり、Firestoreには一切書き込まない。
 * 数値項目はすべて0（実績なし・未入力であることが一目で分かるようにするため）。
 */
function emptyResultFor(cast: Pick<CastWithId, "id" | "storeId">): MonthlyResultWithId {
  return {
    id: `__no_record__${cast.id}`,
    castId: cast.id,
    storeId: cast.storeId,
    month: "",
    totalSales: 0,
    payment: 0,
    honshimeiCount: 0,
    honshimeiGroupCount: 0,
    customerCount: 0,
    jounaiCount: 0,
    douhan: 0,
    workDays: 0,
    workHours: 0,
    absent: 0,
    notes: "",
    batchId: null,
    createdAt: null as unknown as MonthlyResultWithId["createdAt"],
    createdBy: "",
    updatedAt: null as unknown as MonthlyResultWithId["updatedAt"],
    updatedBy: "",
  };
}

/**
 * ランキング集計（旧版 renderRanking の移植）。
 * PR7で対象を「在籍キャスト全員」へ拡張: 呼び出し側が渡す activeCasts
 * （休職・退店・アーカイブ済みは呼び出し側で除外すること）全員を対象とし、
 * 対象月の実績が無いキャストも0埋めのプレースホルダで表示する
 * （誰が未入力・未実績なのか一目で分かるようにするため）。
 * - 同一castIdの重複排除（idが大きいものを優先 = 旧版と同一）
 * - key降順、同値時は castId で安定ソート（要件: 並び順の安定化）。
 *   0（実績なし）は降順ソートの結果として自然に末尾へ並ぶ
 * - 全件返す（PR6: 従来のTOP15打ち切りを廃止。UI側でスクロール表示する）
 */
export function buildRanking(
  results: MonthlyResultWithId[],
  cat: RankCat,
  activeCasts: Array<Pick<CastWithId, "id" | "storeId">>
): MonthlyResultWithId[] {
  const validCastIds = new Set(activeCasts.map((c) => c.id));
  const dedup = new Map<string, MonthlyResultWithId>();
  results.forEach((r) => {
    if (!r.castId) return;
    if (!validCastIds.has(r.castId)) return; // 対象外（他店舗・休職・退店・アーカイブ等）の孤立レコード除去
    const e = dedup.get(r.castId);
    if (!e || (r.id || "") > (e.id || "")) dedup.set(r.castId, r);
  });
  return activeCasts
    .map((c) => dedup.get(c.id) ?? emptyResultFor(c))
    .sort((a, b) => {
      const d = cat.key(b) - cat.key(a);
      if (d !== 0) return d;
      return a.castId.localeCompare(b.castId); // 同値時の安定順
    });
}

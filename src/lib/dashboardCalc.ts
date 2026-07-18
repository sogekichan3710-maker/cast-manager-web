import {
  realHourlyWage,
  type CastWithId,
  type GoalWithId,
  type InterviewWithId,
  type MonthlyResultWithId,
  type MotivationWithId,
} from "@/types";

/**
 * ダッシュボード・ランキングの集計関数群。
 * 既存ローカル版 renderDashboard / renderRanking / calcGoalStatus /
 * realHourlyWageAgg / paymentRate / parseBirthday 等の式を
 * 変更せずに移植した純関数。画面コンポーネントからは分離している。
 */

/** 前月の YYYY-MM を返す（旧版 prevMonth 計算の移植） */
export function prevMonthOf(month: string): string | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  let y = parseInt(m[1]);
  let mo = parseInt(m[2]) - 1;
  if (mo === 0) {
    y--;
    mo = 12;
  }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** 直近nヶ月の YYYY-MM 配列（古い月→新しい月）。旧版 genMonthRange().slice(-12) 相当 */
export function lastNMonths(n: number, base?: Date): string[] {
  const now = base ?? new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** 実質時給の全体集計（旧版 realHourlyWageAgg と同一式・変更禁止） */
export function realHourlyWageAgg(records: MonthlyResultWithId[]): number | null {
  if (!records || !records.length) return null;
  const totalPay = records.reduce((s, r) => s + (r.payment || 0), 0);
  const totalH = records.reduce((s, r) => {
    const h =
      r.workHours != null && r.workHours > 0
        ? r.workHours
        : r.workDays != null && r.workDays > 0
          ? r.workDays * 4.5
          : 0;
    return s + h;
  }, 0);
  if (!totalH) return null;
  return Math.round(totalPay / totalH);
}

export interface DashboardSummary {
  activeCount: number;
  allStoreCount: number;
  tSales: number;
  tPay: number;
  tHonshimei: number;
  tHonGroup: number;
  tCustomer: number;
  tJounai: number;
  tDouhan: number;
  tWork: number;
  tWorkHours: number;
  tPayDiff: number;
  avgPay: number | null;
  tWageDiff: number;
  avgHr: number | null;
  dashRealWage: number | null;
  salesDiffPct: number | null; // 前月比%
  prevSales: number;
  avgWageMonth: number | null;
  monthWageCount: number;
  avgWageYear: number | null;
  yearWageCount: number;
  workingCnt: number;
  attendanceRate: number | null;
  avgSalesMonth: number | null;
  yearSalesTotal: number;
}

/**
 * 当月KPIの集計（旧版 renderDashboard 冒頭の計算を移植）。
 * casts / results は「閲覧可能店舗のみ」に絞ってから渡すこと。
 */
export function calcDashboardSummary(params: {
  month: string;
  casts: CastWithId[];
  monthResults: MonthlyResultWithId[]; // 当月分
  prevMonthResults: MonthlyResultWithId[]; // 前月分
  yearResults: MonthlyResultWithId[]; // 当年分
}): DashboardSummary {
  const { casts, monthResults: cmR, prevMonthResults, yearResults } = params;

  const active = casts.filter((c) => c.status === "在籍" && !c.archived);
  const allStore = casts.filter((c) => !c.archived);
  const castOf = new Map(casts.map((c) => [c.id, c]));

  const tSales = cmR.reduce((s, r) => s + (r.totalSales || 0), 0);
  const tPay = cmR.reduce((s, r) => s + (r.payment || 0), 0);
  const tHonshimei = cmR.reduce((s, r) => s + (r.honshimeiCount || 0), 0);
  const tHonGroup = cmR.reduce((s, r) => s + (r.honshimeiGroupCount || 0), 0);
  const tCustomer = cmR.reduce((s, r) => s + (r.customerCount || 0), 0);
  const tJounai = cmR.reduce((s, r) => s + (r.jounaiCount || 0), 0);
  const tDouhan = cmR.reduce((s, r) => s + (r.douhan || 0), 0);
  const tWork = cmR.reduce((s, r) => s + (r.workDays || 0), 0);
  const tWorkHours = cmR.reduce((s, r) => {
    const h =
      r.workHours != null && r.workHours > 0
        ? r.workHours
        : r.workDays != null && r.workDays > 0
          ? r.workDays * 4.5
          : 0;
    return s + h;
  }, 0);

  // 給与差額合計・平均（旧版と同一: null項目は合計0扱い、平均は有効行のみ）
  const tPayDiff = cmR.reduce(
    (s, r) => s + (r.totalSales != null && r.payment != null ? r.totalSales - r.payment : 0),
    0
  );
  const payDiffs = cmR
    .filter((r) => r.totalSales != null && r.payment != null)
    .map((r) => r.totalSales - r.payment);
  const avgPay = payDiffs.length ? payDiffs.reduce((a, b) => a + b) / payDiffs.length : null;

  // 時給差額合計・平均（旧版と同一: 時給>0のキャストのみ）
  const wageDiffs = cmR
    .filter((r) => {
      const c = castOf.get(r.castId);
      return !!c && c.hourlyWage > 0;
    })
    .map((r) => {
      const c = castOf.get(r.castId)!;
      const hours = r.workHours && r.workHours > 0 ? r.workHours : r.workDays ? r.workDays * 4.5 : 0;
      return (r.totalSales || 0) - (c.hourlyWage || 0) * hours;
    });
  const tWageDiff = wageDiffs.reduce((a, b) => a + b, 0);
  const avgHr = wageDiffs.length ? wageDiffs.reduce((a, b) => a + b) / wageDiffs.length : null;

  const dashRealWage = realHourlyWageAgg(cmR);

  const prevSales = prevMonthResults.reduce((s, r) => s + (r.totalSales || 0), 0);
  const salesDiffPct = prevSales > 0 ? Math.round(((tSales - prevSales) / prevSales) * 100) : null;

  // 月別平均時給: その月に実績のあるキャストの時給平均（旧版と同一）
  const cmCastIds = [...new Set(cmR.map((r) => r.castId))];
  const cmWages = cmCastIds.map((id) => castOf.get(id)?.hourlyWage || 0).filter((w) => w > 0);
  const avgWageMonth = cmWages.length
    ? Math.round(cmWages.reduce((a, b) => a + b) / cmWages.length)
    : null;

  // 年間平均時給: 当年に実績のある全キャストの時給平均（重複除外・旧版と同一）
  const yearCastIds = [...new Set(yearResults.map((r) => r.castId))];
  const yearWages = yearCastIds.map((id) => castOf.get(id)?.hourlyWage || 0).filter((w) => w > 0);
  const avgWageYear = yearWages.length
    ? Math.round(yearWages.reduce((a, b) => a + b) / yearWages.length)
    : null;

  const workingCnt = cmCastIds.length;
  const attendanceRate = active.length > 0 ? Math.round((workingCnt / active.length) * 100) : null;
  const avgSalesMonth = cmR.length ? Math.round(tSales / cmR.length) : null;
  const yearSalesTotal = yearResults.reduce((s, r) => s + (r.totalSales || 0), 0);

  return {
    activeCount: active.length,
    allStoreCount: allStore.length,
    tSales,
    tPay,
    tHonshimei,
    tHonGroup,
    tCustomer,
    tJounai,
    tDouhan,
    tWork,
    tWorkHours,
    tPayDiff,
    avgPay,
    tWageDiff,
    avgHr,
    dashRealWage,
    salesDiffPct,
    prevSales,
    avgWageMonth,
    monthWageCount: cmWages.length,
    avgWageYear,
    yearWageCount: yearWages.length,
    workingCnt,
    attendanceRate,
    avgSalesMonth,
    yearSalesTotal,
  };
}

/** 平均時給の12ヶ月推移（旧版 wageHistory12 と同一式） */
export function calcWageHistory12(
  casts: CastWithId[],
  allResults: MonthlyResultWithId[],
  base?: Date
): Array<{ l: string; v: number | null; cnt: number }> {
  const castOf = new Map(casts.map((c) => [c.id, c]));
  return lastNMonths(12, base).map((m) => {
    const mCids = [...new Set(allResults.filter((r) => r.month === m).map((r) => r.castId))];
    const ws = mCids.map((id) => castOf.get(id)?.hourlyWage || 0).filter((w) => w > 0);
    const mm = m.match(/^(\d{4})-(\d{2})$/);
    return {
      l: mm ? `${Number(mm[2])}月` : m,
      v: ws.length ? Math.round(ws.reduce((a, b) => a + b) / ws.length) : null,
      cnt: mCids.length,
    };
  });
}

// ── 面談アラート（旧版 overdueList の移植） ──────────────────

export interface OverdueEntry {
  cast: CastWithId;
  lastDate: string | null; // 最新面談日
  elapsed: number | null; // 経過日数
  noRecord: boolean;
  followNeed: string;
  motiLevel: string; // "5:非常に高い" 等（レベル数字で優先度判定）
}

/**
 * 面談期限超過（最新面談から30日以上 or 未面談）の一覧。
 * 優先度ソート: フォロー高 > モチベ低 > 面談日が古い（旧版と同じ考え方）。
 * 旧版のモチベ表記（注意/低い等）はWeb版では「1:非常に低い」等の5段階のため、
 * レベル数字の昇順（低いほど優先）で判定する。
 */
export function calcOverdueInterviews(
  casts: CastWithId[],
  interviews: InterviewWithId[],
  motivations: MotivationWithId[],
  today?: Date
): OverdueEntry[] {
  const now = today ?? new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const latestIv = new Map<string, InterviewWithId>();
  for (const iv of interviews) {
    const e = latestIv.get(iv.castId);
    if (!e || (iv.date || "") > (e.date || "")) latestIv.set(iv.castId, iv);
  }
  const latestMoti = new Map<string, MotivationWithId>();
  for (const m of motivations) {
    const e = latestMoti.get(m.castId);
    if (!e || (m.date || "") > (e.date || "")) latestMoti.set(m.castId, m);
  }

  const FOLLOW_PRIORITY: Record<string, number> = { 高: 3, 中: 2, 低: 1, "": 0 };

  const list: OverdueEntry[] = casts
    .filter((c) => c.status === "在籍" && !c.archived)
    .map((c) => {
      const iv = latestIv.get(c.id) ?? null;
      const lastDate = iv?.date ?? null;
      const elapsed = lastDate
        ? Math.floor((todayStart - new Date(lastDate).getTime()) / 864e5)
        : null;
      const noRecord = !iv;
      const moti = latestMoti.get(c.id);
      return {
        cast: c,
        lastDate,
        elapsed,
        noRecord,
        followNeed: iv?.follow || moti?.followNeed || "",
        motiLevel: moti?.level || "",
      };
    })
    .filter((x) => x.noRecord || (x.elapsed !== null && x.elapsed >= 30));

  list.sort((a, b) => {
    const fa = FOLLOW_PRIORITY[a.followNeed] ?? 0;
    const fb = FOLLOW_PRIORITY[b.followNeed] ?? 0;
    if (fa !== fb) return fb - fa;
    // モチベは数字が小さいほど優先（1:非常に低い が最優先）
    const ma = a.motiLevel ? parseInt(a.motiLevel) : 99;
    const mb = b.motiLevel ? parseInt(b.motiLevel) : 99;
    if (ma !== mb) return ma - mb;
    if (a.noRecord && !b.noRecord) return -1;
    if (!a.noRecord && b.noRecord) return 1;
    return (b.elapsed ?? 9999) - (a.elapsed ?? 9999); // 古い（経過大）順
  });

  return list;
}

/** フォロー必要度「高」のキャスト（キャストごと最新面談で判定・旧版 followHigh 相当） */
export function calcFollowHigh(
  casts: CastWithId[],
  interviews: InterviewWithId[]
): Array<{ cast: CastWithId; interview: InterviewWithId }> {
  const castOf = new Map(casts.map((c) => [c.id, c]));
  const latest = new Map<string, InterviewWithId>();
  for (const iv of interviews) {
    const e = latest.get(iv.castId);
    if (!e || (iv.date || "") > (e.date || "")) latest.set(iv.castId, iv);
  }
  const out: Array<{ cast: CastWithId; interview: InterviewWithId }> = [];
  latest.forEach((iv, castId) => {
    const c = castOf.get(castId);
    if (c && !c.archived && iv.follow === "高") out.push({ cast: c, interview: iv });
  });
  return out;
}

/** 次回面談が7日以内（旧版 upcoming と同一条件・最大5件） */
export function calcUpcomingInterviews(
  casts: CastWithId[],
  interviews: InterviewWithId[],
  today?: Date
): Array<{ cast: CastWithId; interview: InterviewWithId }> {
  const now = (today ?? new Date()).getTime();
  const castOf = new Map(casts.map((c) => [c.id, c]));
  return interviews
    .filter((iv) => {
      if (!iv.nextDate) return false;
      const d = new Date(iv.nextDate).getTime();
      return d >= now && d <= now + 7 * 864e5;
    })
    .map((iv) => ({ cast: castOf.get(iv.castId), interview: iv }))
    .filter((x): x is { cast: CastWithId; interview: InterviewWithId } => !!x.cast)
    .slice(0, 5);
}

// ── 目標達成状況（旧版 calcGoalStatus の移植・goalsコレクション版） ──

export interface GoalStatusItem {
  label: string;
  goal: number;
  actual: number | null;
  pct: number | null;
  achieved: boolean;
}

export interface GoalStatusEntry {
  cast: CastWithId;
  goal: GoalWithId;
  mr: MonthlyResultWithId | null;
  items: GoalStatusItem[];
  allAchieved: boolean;
  someUnachieved: boolean;
}

/**
 * 指定月の目標達成状況（旧版 calcGoalStatus と同一の判定・優先度ソート）。
 * 旧版は castRecords の goalSales 等を参照していたが、Web版は goals
 * コレクション（salesTarget等）が正規の保存先のためフィールドをマッピング。
 * 達成判定: 実績/目標 >= 100%（旧版と同一）。
 */
export function calcGoalStatus(
  month: string,
  casts: CastWithId[],
  goals: GoalWithId[],
  results: MonthlyResultWithId[]
): GoalStatusEntry[] {
  const castOf = new Map(casts.map((c) => [c.id, c]));
  const mrOf = new Map(
    results.filter((r) => r.month === month).map((r) => [r.castId, r])
  );
  const out: GoalStatusEntry[] = [];

  for (const g of goals) {
    if (g.month !== month) continue; // 指定月のみ（未来月目標を混ぜない・旧版と同一）
    const c = castOf.get(g.castId);
    if (!c || c.archived || c.status === "退店") continue;
    const mr = mrOf.get(g.castId) ?? null;

    const items: GoalStatusItem[] = [];
    const check = (label: string, goalVal: number, actualVal: number | null) => {
      if (!goalVal) return; // 未設定はスキップ（旧版と同一）
      const pct = actualVal != null ? Math.round((actualVal / goalVal) * 100) : null;
      items.push({ label, goal: goalVal, actual: actualVal, pct, achieved: pct != null && pct >= 100 });
    };

    if (mr) {
      const wh = mr.workHours > 0 ? mr.workHours : mr.workDays ? mr.workDays * 4.5 : null;
      check("売上", g.salesTarget, mr.totalSales || 0);
      check("指名", g.honshimeiTarget, mr.honshimeiCount || 0);
      check("同伴", g.douhanTarget, mr.douhan || 0);
      check("場内", g.jounaiTarget, mr.jounaiCount || 0);
      check("出勤日数", g.workDaysTarget, mr.workDays || 0);
      check("出勤時間", g.workHoursTarget, wh);
    } else {
      (
        [
          ["売上", g.salesTarget],
          ["指名", g.honshimeiTarget],
          ["同伴", g.douhanTarget],
          ["場内", g.jounaiTarget],
          ["出勤日数", g.workDaysTarget],
          ["出勤時間", g.workHoursTarget],
        ] as const
      ).forEach(([label, goal]) => {
        if (!goal) return;
        items.push({ label, goal, actual: null, pct: null, achieved: false });
      });
    }

    if (!items.length) continue;
    const allAchieved = items.every((it) => it.achieved);
    const someUnachieved = items.some((it) => !it.achieved);
    out.push({ cast: c, goal: g, mr, items, allAchieved, someUnachieved });
  }

  // 優先順位: 売上未達 > 出勤日数未達 > 出勤時間未達 > 指名未達 > 同伴未達 > 場内未達（旧版と同一）
  const PRIORITY = ["売上", "出勤日数", "出勤時間", "指名", "同伴", "場内"];
  out.sort((a, b) => {
    if (a.allAchieved !== b.allAchieved) return a.allAchieved ? 1 : -1;
    for (const lbl of PRIORITY) {
      const ua = a.items.find((it) => it.label === lbl && !it.achieved);
      const ub = b.items.find((it) => it.label === lbl && !it.achieved);
      if (ua && !ub) return -1;
      if (!ua && ub) return 1;
    }
    return 0;
  });
  return out;
}

// ── 誕生日（旧版 parseBirthday / daysUntilBirthday / calcAge の移植） ──

export function parseBirthday(
  str: string | null | undefined
): { year: number | null; month: number; day: number } | null {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  let m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) };
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return { year: null, month: parseInt(m[1]), day: parseInt(m[2]) };
  m = s.match(/^(\d{1,2})月(\d{1,2})日?$/);
  if (m) return { year: null, month: parseInt(m[1]), day: parseInt(m[2]) };
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (m) return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) };
  return null;
}

export function daysUntilBirthday(str: string, base?: Date): number | null {
  const b = parseBirthday(str);
  if (!b) return null;
  const now = base ?? new Date();
  const thisYear = now.getFullYear();
  let next = new Date(thisYear, b.month - 1, b.day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (next < today) next = new Date(thisYear + 1, b.month - 1, b.day);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

export function calcAge(str: string, base?: Date): number | null {
  const b = parseBirthday(str);
  if (!b || !b.year) return null;
  const now = base ?? new Date();
  let age = now.getFullYear() - b.year;
  if (now.getMonth() + 1 < b.month || (now.getMonth() + 1 === b.month && now.getDate() < b.day)) {
    age--;
  }
  return age;
}

/** 指定月（1-12）が誕生日のキャスト（旧版 getBirthdayCasts と同一条件・日付順） */
export function getBirthdayCasts(casts: CastWithId[], targetMonth: number): CastWithId[] {
  return casts
    .filter((c) => {
      if (c.archived || c.status === "退店") return false;
      const b = parseBirthday(c.birthday);
      return !!b && b.month === targetMonth;
    })
    .sort((a, b) => {
      const ba = parseBirthday(a.birthday);
      const bb = parseBirthday(b.birthday);
      return (ba?.day || 0) - (bb?.day || 0);
    });
}

// ── ランキング（旧版 _RANK_CATS の移植） ──────────────────────

export interface RankCat {
  id: string;
  label: string;
  key: (r: MonthlyResultWithId) => number;
  fmt: (v: number) => string;
  sub: (r: MonthlyResultWithId) => string | null;
}

/** 旧版 _RANK_CATS と同一の7カテゴリ・同一の値定義（変更禁止） */
export const RANK_CATS: RankCat[] = [
  {
    id: "sales",
    label: "🏆 売上",
    key: (r) => r.totalSales || 0,
    fmt: (v) => "¥" + Math.round(v).toLocaleString(),
    sub: (r) => `${r.honshimeiCount || 0}本`,
  },
  {
    id: "honmei",
    label: "💎 指名",
    key: (r) => r.honshimeiCount || 0,
    fmt: (v) => v + "本",
    sub: () => null,
  },
  {
    id: "douhan",
    label: "🌙 同伴",
    key: (r) => r.douhan || 0,
    fmt: (v) => v + "件",
    sub: () => null,
  },
  {
    id: "jounai",
    label: "🏠 場内",
    key: (r) => r.jounaiCount || 0,
    fmt: (v) => v + "本",
    sub: () => null,
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
 * ランキング集計（旧版 renderRanking と同一処理）:
 * ① キャストが存在しないレコードを除外
 * ② 同一castIdの重複排除（idが大きい方を優先）
 * ③ 値が0以下を除外 → 降順 → TOP15
 * 値が同じ場合は源氏名の昇順で安定ソート（追加要件）。
 */
export function calcRanking(
  cat: RankCat,
  results: MonthlyResultWithId[],
  casts: CastWithId[],
  top: number = 15
): MonthlyResultWithId[] {
  const castIds = new Set(casts.map((c) => c.id));
  const nameOf = new Map(casts.map((c) => [c.id, c.stageName]));

  const dedupMap = new Map<string, MonthlyResultWithId>();
  for (const r of results) {
    if (!r.castId || !castIds.has(r.castId)) continue;
    const existing = dedupMap.get(r.castId);
    if (!existing || (r.id || "") > (existing.id || "")) dedupMap.set(r.castId, r);
  }

  return [...dedupMap.values()]
    .filter((r) => cat.key(r) !== -Infinity && cat.key(r) > 0)
    .sort((a, b) => {
      const diff = cat.key(b) - cat.key(a);
      if (diff !== 0) return diff;
      return (nameOf.get(a.castId) || "").localeCompare(nameOf.get(b.castId) || "", "ja");
    })
    .slice(0, top);
}

/** 検索用正規化: trim・小文字化・全角英数→半角・全角スペース→半角（要件） */
export function normalizeSearch(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .trim()
    .toLowerCase();
}

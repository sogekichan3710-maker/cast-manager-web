import {
  monthShortLabel,
  realHourlyWage,
  type CastWithId,
  type GoalWithId,
  type InterviewWithId,
  type MonthlyResultWithId,
  type MotivationWithId,
} from "@/types";

/**
 * ダッシュボード集計（既存ローカル版 renderDashboard の計算式を移植）。
 * 判定条件・式は旧版と同一。画面コンポーネントから分離した純関数群。
 */

/** 前月の YYYY-MM を返す（旧版 prevMonth 計算と同一ロジック） */
export function prevMonthOf(month: string): string | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  let mo = Number(m[2]) - 1;
  if (mo === 0) {
    y--;
    mo = 12;
  }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** 対象月から過去n個の YYYY-MM 配列（古い月→新しい月） */
export function monthRangeEndingAt(month: string, n: number): string[] {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return [];
  const out: string[] = [];
  let y = Number(m[1]);
  let mo = Number(m[2]);
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(mo).padStart(2, "0")}`);
    mo--;
    if (mo === 0) {
      y--;
      mo = 12;
    }
  }
  return out;
}

export interface DashboardKpi {
  activeCount: number;
  allCount: number;
  tSales: number;
  tPay: number;
  tHonshimei: number;
  tHonGroup: number;
  tCustomer: number;
  tJounai: number;
  tDouhan: number;
  tWork: number; // 出勤日数合計
  tWorkHours: number; // 出勤時間合計（h、4.5h代替込み）
  tPayDiff: number;
  avgPayDiff: number | null;
  tWageDiff: number;
  avgWageDiff: number | null;
  aggRealWage: number | null; // 平均実質時給（総支給÷総時間）
  salesDiffPct: number | null; // 前月比%
  prevSales: number;
  avgWageMonth: number | null; // 月別平均時給
  wageMonthCount: number;
  avgWageYear: number | null;
  wageYearCount: number;
  yearSalesTotal: number; // 年間累計売上
  yearHonshimei: number;
  workingCnt: number; // 出勤人数
  attendanceRate: number | null;
  avgSalesMonth: number | null;
}

/** 旧版の「4.5h代替込み」の出勤時間（wageDiff/realHourlyWageAggと同じ定義） */
function effHours(r: MonthlyResultWithId): number {
  return r.workHours != null && r.workHours > 0
    ? r.workHours
    : r.workDays != null && r.workDays > 0
      ? r.workDays * 4.5
      : 0;
}

/** 平均実質時給（旧版 realHourlyWageAgg と同一式: 総支給額 ÷ 総時間） */
export function realHourlyWageAgg(records: MonthlyResultWithId[]): number | null {
  if (!records.length) return null;
  const totalPay = records.reduce((s, r) => s + (r.payment || 0), 0);
  const totalH = records.reduce((s, r) => s + effHours(r), 0);
  if (!totalH) return null;
  return Math.round(totalPay / totalH);
}

export function calcDashboardKpi(params: {
  month: string;
  casts: CastWithId[];
  allResults: MonthlyResultWithId[]; // 閲覧可能店舗の全成績
}): DashboardKpi {
  const { month, casts, allResults } = params;
  const castOf = new Map(casts.map((c) => [c.id, c]));

  // 旧版: 在籍・非アーカイブ
  const active = casts.filter((c) => c.status === "在籍" && !c.archived);
  const all = casts.filter((c) => !c.archived);

  const cmR = allResults.filter((r) => r.month === month);
  const sum = (f: (r: MonthlyResultWithId) => number) =>
    cmR.reduce((s, r) => s + f(r), 0);

  const tSales = sum((r) => r.totalSales || 0);
  const tPay = sum((r) => r.payment || 0);

  // 給与差額合計・平均（旧版と同一: null項目は除外して平均）
  const payDiffs = cmR
    .filter((r) => r.totalSales != null && r.payment != null)
    .map((r) => r.totalSales - r.payment);
  const tPayDiff = payDiffs.reduce((a, b) => a + b, 0);
  const avgPayDiff = payDiffs.length
    ? payDiffs.reduce((a, b) => a + b) / payDiffs.length
    : null;

  // 時給差額合計・平均（旧版と同一: 時給>0のキャストのみ）
  const wageDiffs = cmR
    .filter((r) => {
      const c = castOf.get(r.castId);
      return !!c && c.hourlyWage > 0;
    })
    .map((r) => {
      const c = castOf.get(r.castId)!;
      return (r.totalSales || 0) - (c.hourlyWage || 0) * effHours(r);
    });
  const tWageDiff = wageDiffs.reduce((a, b) => a + b, 0);
  const avgWageDiff = wageDiffs.length
    ? wageDiffs.reduce((a, b) => a + b) / wageDiffs.length
    : null;

  // 前月比（旧版と同一: 前月売上>0 のときのみ%）
  const pm = prevMonthOf(month);
  const prevSales = pm
    ? allResults.filter((r) => r.month === pm).reduce((s, r) => s + (r.totalSales || 0), 0)
    : 0;
  const salesDiffPct =
    prevSales > 0 ? Math.round(((tSales - prevSales) / prevSales) * 100) : null;

  // 月別平均時給（その月に実績があるキャストの時給平均・時給>0のみ）
  const cmCastIds = [...new Set(cmR.map((r) => r.castId))];
  const cmWages = cmCastIds
    .map((id) => castOf.get(id)?.hourlyWage || 0)
    .filter((w) => w > 0);
  const avgWageMonth = cmWages.length
    ? Math.round(cmWages.reduce((a, b) => a + b) / cmWages.length)
    : null;

  // 年間平均時給（選択月の年内に実績がある全キャスト・重複除外）
  const year = month.slice(0, 4);
  const yearMR = allResults.filter((r) => r.month.startsWith(year));
  const yearCastIds = [...new Set(yearMR.map((r) => r.castId))];
  const yearWages = yearCastIds
    .map((id) => castOf.get(id)?.hourlyWage || 0)
    .filter((w) => w > 0);
  const avgWageYear = yearWages.length
    ? Math.round(yearWages.reduce((a, b) => a + b) / yearWages.length)
    : null;

  const workingCnt = cmCastIds.length;

  return {
    activeCount: active.length,
    allCount: all.length,
    tSales,
    tPay,
    tHonshimei: sum((r) => r.honshimeiCount || 0),
    tHonGroup: sum((r) => r.honshimeiGroupCount || 0),
    tCustomer: sum((r) => r.customerCount || 0),
    tJounai: sum((r) => r.jounaiCount || 0),
    tDouhan: sum((r) => r.douhan || 0),
    tWork: sum((r) => r.workDays || 0),
    tWorkHours: Math.round(sum(effHours) * 10) / 10,
    tPayDiff,
    avgPayDiff,
    tWageDiff,
    avgWageDiff,
    aggRealWage: realHourlyWageAgg(cmR),
    salesDiffPct,
    prevSales,
    avgWageMonth,
    wageMonthCount: cmWages.length,
    avgWageYear,
    wageYearCount: yearWages.length,
    yearSalesTotal: yearMR.reduce((s, r) => s + (r.totalSales || 0), 0),
    yearHonshimei: yearMR.reduce((s, r) => s + (r.honshimeiCount || 0), 0),
    workingCnt,
    attendanceRate:
      active.length > 0 ? Math.round((workingCnt / active.length) * 100) : null,
    avgSalesMonth: cmR.length ? Math.round(tSales / cmR.length) : null,
  };
}

/** 平均時給の直近12ヶ月推移（古い月→新しい月）。
 * 旧版の意図（buildChartCacheの「直近12ヶ月・古→新」）に合わせる。
 * ※旧版 wageHistory12 は genMonthRange().slice(-12) により
 *   12〜23ヶ月前を取得する齟齬があったため、意図側を正として移植。 */
export function avgWageTrend12(params: {
  month: string;
  casts: CastWithId[];
  allResults: MonthlyResultWithId[];
}): Array<{ l: string; v: number | null; cnt: number }> {
  const { month, casts, allResults } = params;
  const castOf = new Map(casts.map((c) => [c.id, c]));
  return monthRangeEndingAt(month, 12).map((m) => {
    const ids = [...new Set(allResults.filter((r) => r.month === m).map((r) => r.castId))];
    const ws = ids.map((id) => castOf.get(id)?.hourlyWage || 0).filter((w) => w > 0);
    return {
      l: monthShortLabel(m),
      v: ws.length ? Math.round(ws.reduce((a, b) => a + b) / ws.length) : null,
      cnt: ids.length,
    };
  });
}

// ── アラート ────────────────────────────────────────────────

export interface OverdueEntry {
  cast: CastWithId;
  lastDate: string | null; // 最新面談日
  elapsed: number | null; // 経過日数
  noRecord: boolean;
  followNeed: string;
  motiLevel: string;
}

/**
 * 面談期限超過（旧版と同一: 最新面談から30日以上経過 or 未面談）。
 * 優先度ソート: フォロー高 > モチベ低 > 未面談 > 経過日数。
 * 旧版のモチベ判定値（'注意'/'低い'）は新データ形式（'2:低い'等）にも
 * マッチするよう「低い」を含むかで判定。
 */
export function calcOverdueInterviews(params: {
  casts: CastWithId[];
  interviews: InterviewWithId[];
  motivations: MotivationWithId[];
  now?: Date;
}): OverdueEntry[] {
  const { casts, interviews, motivations } = params;
  const now = params.now ?? new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  // キャストごとの最新面談・最新モチベ
  const latestIv = new Map<string, InterviewWithId>();
  interviews.forEach((iv) => {
    const e = latestIv.get(iv.castId);
    if (!e || (iv.date || "") > (e.date || "")) latestIv.set(iv.castId, iv);
  });
  const latestMoti = new Map<string, MotivationWithId>();
  motivations.forEach((m) => {
    const e = latestMoti.get(m.castId);
    if (!e || (m.date || "") > (e.date || "")) latestMoti.set(m.castId, m);
  });

  const list: OverdueEntry[] = casts
    .filter((c) => c.status === "在籍" && !c.archived)
    .map((c) => {
      const iv = latestIv.get(c.id) ?? null;
      const lastDate = iv?.date ?? null;
      const elapsed = lastDate
        ? Math.floor((today - new Date(lastDate).getTime()) / 864e5)
        : null;
      const noRecord = !iv;
      return {
        cast: c,
        lastDate,
        elapsed,
        noRecord,
        followNeed: iv?.follow ?? "",
        motiLevel: latestMoti.get(c.id)?.level ?? "",
      };
    })
    .filter((x) => x.noRecord || (x.elapsed !== null && x.elapsed >= 30));

  const FOLLOW_PRIORITY: Record<string, number> = { 高: 3, 中: 2, 低: 1, "": 0 };
  const motiPriority = (lv: string) =>
    lv.includes("非常に低い") ? 3 : lv.includes("低い") ? 2 : 0;
  list.sort((a, b) => {
    const fa = FOLLOW_PRIORITY[a.followNeed] ?? 0;
    const fb = FOLLOW_PRIORITY[b.followNeed] ?? 0;
    if (fa !== fb) return fb - fa;
    const ma = motiPriority(a.motiLevel);
    const mb = motiPriority(b.motiLevel);
    if (ma !== mb) return mb - ma;
    if (a.noRecord && !b.noRecord) return -1;
    if (!a.noRecord && b.noRecord) return 1;
    return (a.elapsed ?? 9999) - (b.elapsed ?? 9999);
  });
  return list;
}

/** フォロー必要度「高」（各キャスト最新面談ベース・旧版と同一判定） */
export function calcFollowHigh(params: {
  casts: CastWithId[];
  interviews: InterviewWithId[];
}): Array<{ cast: CastWithId; interview: InterviewWithId }> {
  const activeIds = new Set(
    params.casts.filter((c) => c.status === "在籍" && !c.archived).map((c) => c.id)
  );
  const latest = new Map<string, InterviewWithId>();
  params.interviews
    .filter((iv) => activeIds.has(iv.castId))
    .forEach((iv) => {
      const e = latest.get(iv.castId);
      if (!e || (iv.date || "") > (e.date || "")) latest.set(iv.castId, iv);
    });
  const castOf = new Map(params.casts.map((c) => [c.id, c]));
  return [...latest.values()]
    .filter((iv) => iv.follow === "高")
    .map((iv) => ({ cast: castOf.get(iv.castId)!, interview: iv }))
    .filter((x) => !!x.cast);
}

/** 次回面談が近い（7日以内・旧版と同一: today <= nextDate <= today+7日、上位5件） */
export function calcUpcomingInterviews(params: {
  casts: CastWithId[];
  interviews: InterviewWithId[];
  now?: Date;
}): Array<{ cast: CastWithId; interview: InterviewWithId }> {
  const now = params.now ?? new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const activeIds = new Set(
    params.casts.filter((c) => c.status === "在籍" && !c.archived).map((c) => c.id)
  );
  const castOf = new Map(params.casts.map((c) => [c.id, c]));
  return params.interviews
    .filter((iv) => {
      if (!activeIds.has(iv.castId)) return false;
      if (!iv.nextDate) return false;
      const d = new Date(iv.nextDate).getTime();
      return d >= today && d <= today + 7 * 864e5;
    })
    .sort((a, b) => (a.nextDate || "").localeCompare(b.nextDate || ""))
    .slice(0, 5)
    .map((iv) => ({ cast: castOf.get(iv.castId)!, interview: iv }))
    .filter((x) => !!x.cast);
}

// ── 目標達成状況 ─────────────────────────────────────────────

export interface GoalCheckItem {
  label: string;
  goal: number;
  actual: number | null;
  pct: number | null;
  achieved: boolean;
  fmt: (v: number) => string;
}

export interface GoalStatusEntry {
  cast: CastWithId;
  goal: GoalWithId;
  items: GoalCheckItem[];
  allAchieved: boolean;
  someUnachieved: boolean;
}

const fmtMoney = (v: number) => "¥" + Math.round(v).toLocaleString();

/**
 * 指定月の目標達成状況（旧版 calcGoalStatus の移植）。
 * 旧版は castRecords のゴールを参照していたが、Web版では goals コレクションを
 * 参照する（フィールドはPR3で移植済みの salesTarget 等）。
 * 判定式は旧版と同一: pct = round(actual/goal*100)、pct>=100 で達成。
 */
export function calcGoalStatus(params: {
  month: string;
  casts: CastWithId[];
  goals: GoalWithId[];
  allResults: MonthlyResultWithId[];
}): GoalStatusEntry[] {
  const { month, casts, goals, allResults } = params;
  const castOf = new Map(casts.map((c) => [c.id, c]));
  const mrOf = new Map(
    allResults.filter((r) => r.month === month).map((r) => [r.castId, r])
  );

  const results: GoalStatusEntry[] = [];
  // 旧版と同一: 指定月と一致する目標のみ採用（未来月の目標を混ぜない）
  goals
    .filter((g) => g.month === month)
    .forEach((g) => {
      const c = castOf.get(g.castId);
      if (!c || c.archived || c.status === "退店") return;
      const mr = mrOf.get(g.castId) ?? null;

      const items: GoalCheckItem[] = [];
      const check = (
        label: string,
        goalVal: number,
        actual: number | null,
        fmt: (v: number) => string
      ) => {
        if (!goalVal) return; // 未設定はスキップ（旧版と同一）
        const pct = actual != null ? Math.round((actual / goalVal) * 100) : null;
        items.push({
          label,
          goal: goalVal,
          actual,
          pct,
          achieved: pct != null && pct >= 100,
          fmt,
        });
      };

      if (mr) {
        const wh =
          mr.workHours > 0 ? mr.workHours : mr.workDays ? mr.workDays * 4.5 : null;
        check("売上", g.salesTarget, mr.totalSales || 0, fmtMoney);
        check("指名", g.honshimeiTarget, mr.honshimeiCount || 0, (v) => v + "本");
        check("同伴", g.douhanTarget, mr.douhan || 0, (v) => v + "件");
        check("場内", g.jounaiTarget, mr.jounaiCount || 0, (v) => v + "本");
        check("出勤日数", g.workDaysTarget, mr.workDays || 0, (v) => v + "日");
        check("出勤時間", g.workHoursTarget, wh, (v) => v.toFixed(1) + "h");
      } else {
        // 実績なし（旧版と同一: actual=null で全項目未達成扱い）
        check("売上", g.salesTarget, null, fmtMoney);
        check("指名", g.honshimeiTarget, null, (v) => v + "本");
        check("同伴", g.douhanTarget, null, (v) => v + "件");
        check("場内", g.jounaiTarget, null, (v) => v + "本");
        check("出勤日数", g.workDaysTarget, null, (v) => v + "日");
        check("出勤時間", g.workHoursTarget, null, (v) => v.toFixed(1) + "h");
      }

      if (!items.length) return;
      const allAchieved = items.every((i) => i.achieved);
      results.push({
        cast: c,
        goal: g,
        items,
        allAchieved,
        someUnachieved: !allAchieved,
      });
    });
  return results;
}

// ── 誕生日（旧版 parseBirthday / daysUntilBirthday / calcAge / getBirthdayCasts の移植） ──

export interface ParsedBirthday {
  month: number;
  day: number;
  year: number | null;
}

/** 旧版と同一の受付形式: 07/24, 7-24, 1996/07/24, 1996-07-24, 1996.07.24, 7月24日 */
export function parseBirthday(str: string | null | undefined): ParsedBirthday | null {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  let m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return { year: null, month: Number(m[1]), day: Number(m[2]) };
  m = s.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (m) return { year: null, month: Number(m[1]), day: Number(m[2]) };
  return null;
}

export function daysUntilBirthday(str: string, now?: Date): number | null {
  const b = parseBirthday(str);
  if (!b) return null;
  const n = now ?? new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  let next = new Date(n.getFullYear(), b.month - 1, b.day);
  if (next < today) next = new Date(n.getFullYear() + 1, b.month - 1, b.day);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

export function calcAge(str: string, now?: Date): number | null {
  const b = parseBirthday(str);
  if (!b || !b.year) return null;
  const n = now ?? new Date();
  let age = n.getFullYear() - b.year;
  if (n.getMonth() + 1 < b.month || (n.getMonth() + 1 === b.month && n.getDate() < b.day)) {
    age--;
  }
  return age;
}

/** 指定月(1-12)の誕生日キャスト（旧版と同一: 退店・アーカイブ除外・日付昇順） */
export function getBirthdayCasts(casts: CastWithId[], targetMonth: number): CastWithId[] {
  return casts
    .filter((c) => {
      if (c.archived || c.status === "退店") return false;
      const b = parseBirthday(c.birthday);
      return !!b && b.month === targetMonth;
    })
    .sort(
      (a, b) => (parseBirthday(a.birthday)?.day || 0) - (parseBirthday(b.birthday)?.day || 0)
    );
}

// ── 月別成績の日割平均（旧版 calcMrAuto の追加表示分） ──

/** 日割平均売上（旧版: workDays>0 のとき round(total/workDays)） */
export function avgSalesPerDay(total: number, workDays: number): number | null {
  return workDays > 0 ? Math.round(total / workDays) : null;
}

/** 日割平均本指名（旧版: (hCount/workDays).toFixed(2)） */
export function avgHonmeiPerDay(hCount: number, workDays: number): string | null {
  return workDays > 0 && hCount > 0 ? (hCount / workDays).toFixed(2) : null;
}

export { realHourlyWage };

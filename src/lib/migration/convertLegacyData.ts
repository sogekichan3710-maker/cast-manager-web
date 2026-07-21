import {
  ALL_STORES_FILTER,
  CAST_STATUSES,
  FOLLOW_NEEDS,
  GOAL_STATUSES,
  MOTI_LEVELS,
  RANKS,
  RULE_DECISIONS,
  monthlyResultId,
  nameMatchingRuleId,
  normalizeMonth,
  type CastDoc,
  type CastStatus,
  type FollowNeed,
  type GoalDoc,
  type GoalStatus,
  type InterviewDoc,
  type MonthlyResultDoc,
  type MotiLevel,
  type MotivationDoc,
  type NameMatchingRuleDoc,
  type Rank,
  type RuleDecision,
  type StoreDoc,
  type WageHistoryDoc,
} from "@/types/domain";
import { normalizeName } from "@/lib/nameNormalize";
import type { LegacyData, LegacyRecord } from "./legacyTypes";

/**
 * 旧ローカル版データ → 新Firestore構造への変換。
 *
 * 方針:
 * - 画面から完全分離した純関数（Firestore非依存・単体テスト可能）
 * - 元データのIDは可能な限り保持する。IDを変更・派生した場合は idMap に記録
 * - 数値計算式は一切持たない（保存済みの値をそのまま移す）
 * - 空文字/null/undefined は ""、数値の null/undefined/"" は 0 へ統一
 * - storeId が stores（ファイル内 + 既存Firestore）に無いデータは
 *   別店舗へ統合せず unknownStore として除外・報告
 * - '__all__' / 「全店舗」は storeId として保存しない
 * - 旧month「2026年7月」等は YYYY-MM へ変換。変換不能は badMonth として除外・報告
 * - 旧castRecords（面談+目標+モチベーションの統合記録）は
 *   interviews / goals / motivations の3コレクションへ分離
 */

// ---- 保存メタ（createdAt等）を除いた「変換結果」型。書き込み時にサービス層が付与する ----
type Meta4 = "createdAt" | "createdBy" | "updatedAt" | "updatedBy";
export type StorePlain = Omit<StoreDoc, Meta4>;
export type CastPlain = Omit<CastDoc, Meta4>;
export type MonthlyResultPlain = Omit<MonthlyResultDoc, Meta4>;
export type InterviewPlain = Omit<InterviewDoc, Meta4>;
export type GoalPlain = Omit<GoalDoc, Meta4>;
export type MotivationPlain = Omit<MotivationDoc, Meta4>;
export type WageHistoryPlain = Omit<WageHistoryDoc, "createdAt" | "createdBy">;
export type NameMatchingRulePlain = Omit<NameMatchingRuleDoc, Meta4>;

export interface ConvertedDoc<T> {
  id: string;
  legacyId: string | null;
  data: T;
}

export interface ConversionIssue {
  collection: string;
  legacyId: string | null;
  label: string;
  reason: string;
}

export interface IdMapEntry {
  collection: string;
  legacyId: string;
  newId: string;
  note: string;
}

export interface ConversionResult {
  sourceFormat: string;
  stores: ConvertedDoc<StorePlain>[];
  casts: ConvertedDoc<CastPlain>[];
  monthlyResults: ConvertedDoc<MonthlyResultPlain>[];
  interviews: ConvertedDoc<InterviewPlain>[];
  goals: ConvertedDoc<GoalPlain>[];
  motivations: ConvertedDoc<MotivationPlain>[];
  wageHistory: ConvertedDoc<WageHistoryPlain>[];
  nameMatchingRules: ConvertedDoc<NameMatchingRulePlain>[];
  /** 旧ID→新IDの対応（変更・派生があったもののみ） */
  idMap: IdMapEntry[];
  /** 必須項目欠落など解釈できず除外したデータ */
  invalid: ConversionIssue[];
  /** 参照先キャストが存在しない孤立データ（除外） */
  orphans: ConversionIssue[];
  /** storeId が存在しないデータ（除外） */
  unknownStore: ConversionIssue[];
  /** 月形式を変換できないデータ（除外） */
  badMonth: ConversionIssue[];
  /** ファイル内の重複候補（同一キーの後勝ち・同名キャスト等） */
  duplicates: ConversionIssue[];
  /** 除外はしないが確認を推奨する内容 */
  warnings: ConversionIssue[];
  /** 旧importBatchesの件数（移行対象外・参考表示のみ） */
  legacyImportBatchCount: number;
}

// ---------------- 値の取り出しヘルパー ----------------

/** 別名リストの先頭から最初に存在するフィールド値を返す */
function pick(rec: LegacyRecord, aliases: string[]): unknown {
  for (const key of aliases) {
    if (key in rec && rec[key] !== undefined) return rec[key];
  }
  return undefined;
}

/** 文字列へ統一（null/undefined → ""） */
function asStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** 数値へ統一（null/undefined/""/変換不能 → 0。"1,234"・"¥1,234"も許容） */
function asNum(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/[,¥￥\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  if (typeof v === "number") return v !== 0;
  return false;
}

/** Firestore ドキュメントIDとして使えるか */
function isValidDocId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 400 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id)
  );
}

/** 内容から決定的なIDを生成（FNV-1a。同じ内容なら再実行でも同じID） */
function contentHashId(prefix: string, rec: LegacyRecord): string {
  const text = JSON.stringify(rec, Object.keys(rec).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}-${h.toString(16).padStart(8, "0")}`;
}

/** 旧レベル値（1〜5 / "低い" / "2:低い"等）→ MOTI_LEVELS へマッピング */
export function mapMotiLevel(v: unknown): MotiLevel | null {
  const s = asStr(v);
  if (!s) return null;
  const exact = (MOTI_LEVELS as readonly string[]).find((l) => l === s);
  if (exact) return exact as MotiLevel;
  const byNum = s.match(/^([1-5])/);
  if (byNum) {
    const found = (MOTI_LEVELS as readonly string[]).find((l) => l.startsWith(byNum[1]));
    if (found) return found as MotiLevel;
  }
  // ラベルのみ（"非常に高い"等）。「非常に低い」を「低い」より先に判定する
  const byLabel = (MOTI_LEVELS as readonly string[])
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((l) => l.slice(2) === s || s.includes(l.slice(2)));
  return (byLabel as MotiLevel) ?? null;
}

function mapFollowNeed(v: unknown): FollowNeed | "" {
  const s = asStr(v);
  return (FOLLOW_NEEDS as readonly string[]).includes(s) ? (s as FollowNeed) : "";
}

function mapGoalStatus(v: unknown): GoalStatus | "" {
  const s = asStr(v);
  return (GOAL_STATUSES as readonly string[]).includes(s) ? (s as GoalStatus) : "";
}

function mapRank(v: unknown): Rank | "" {
  const s = asStr(v);
  return (RANKS as readonly string[]).includes(s) ? (s as Rank) : "";
}

function mapDecision(v: unknown): RuleDecision | null {
  const s = asStr(v).toLowerCase();
  if ((RULE_DECISIONS as readonly string[]).includes(s)) return s as RuleDecision;
  if (["existing", "match", "linked", "既存"].includes(s)) return "link";
  if (["create", "added", "新規"].includes(s)) return "new";
  if (["skip", "ignore", "除外"].includes(s)) return "exclude";
  return null;
}

// ---------------- 変換本体 ----------------

/**
 * @param legacy パース済み旧データ
 * @param existingStoreIds 既存Firestore上の店舗ID（ファイル内storesと合わせて
 *   storeId の実在チェックに使う）
 */
export function convertLegacyData(
  legacy: LegacyData,
  existingStoreIds: string[]
): ConversionResult {
  const idMap: IdMapEntry[] = [];
  const invalid: ConversionIssue[] = [];
  const orphans: ConversionIssue[] = [];
  const unknownStore: ConversionIssue[] = [];
  const badMonth: ConversionIssue[] = [];
  const duplicates: ConversionIssue[] = [];
  const warnings: ConversionIssue[] = [];

  // ---- stores ----
  const stores: ConvertedDoc<StorePlain>[] = [];
  legacy.stores.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const name = asStr(pick(rec, ["name", "storeName"]));
    const code = asStr(pick(rec, ["code", "storeCode"])) || (legacyId ?? "");
    if (legacyId === ALL_STORES_FILTER || name === "全店舗") {
      invalid.push({
        collection: "stores",
        legacyId,
        label: name || String(legacyId),
        reason: "「全店舗」はFirestoreへ保存しません（表示用フィルターのため）",
      });
      return;
    }
    if (!name) {
      invalid.push({ collection: "stores", legacyId, label: String(legacyId ?? `#${idx}`), reason: "店舗名がありません" });
      return;
    }
    let id = legacyId ?? "";
    if (!isValidDocId(id)) {
      const candidate = code && isValidDocId(code) ? code : contentHashId("store", rec);
      id = candidate;
      if (legacyId) idMap.push({ collection: "stores", legacyId, newId: id, note: "IDがFirestoreで使用不可のため置換" });
    }
    stores.push({
      id,
      legacyId,
      data: {
        name,
        code,
        color: asStr(pick(rec, ["color", "colour"])) || "#9c6bff",
        active: pick(rec, ["active"]) === undefined ? true : asBool(rec["active"]),
        order: asNum(pick(rec, ["order", "sortOrder"])) || idx,
      },
    });
  });

  // storeId 実在チェック用（ファイル内 + 既存Firestore）
  const knownStoreIds = new Set<string>([...existingStoreIds, ...stores.map((s) => s.id)]);
  // 旧storeId → 新storeId（stores のID置換分）
  const storeIdMap = new Map<string, string>();
  stores.forEach((s) => {
    if (s.legacyId) storeIdMap.set(s.legacyId, s.id);
  });
  const resolveStoreId = (raw: string): string | null => {
    if (!raw || raw === ALL_STORES_FILTER || raw === "全店舗") return null;
    const mapped = storeIdMap.get(raw) ?? raw;
    return knownStoreIds.has(mapped) ? mapped : null;
  };

  // ---- casts ----
  const casts: ConvertedDoc<CastPlain>[] = [];
  const castIdMap = new Map<string, string>(); // 旧castId → 新castId
  const castById = new Map<string, ConvertedDoc<CastPlain>>();
  legacy.casts.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const stageName = asStr(pick(rec, ["stageName", "name", "genjiName"]));
    const label = stageName || String(legacyId ?? `#${idx}`);
    if (!stageName) {
      invalid.push({ collection: "casts", legacyId, label, reason: "源氏名がありません" });
      return;
    }
    const rawStoreId = asStr(pick(rec, ["storeId", "store"]));
    const storeId = resolveStoreId(rawStoreId);
    if (!storeId) {
      unknownStore.push({
        collection: "casts",
        legacyId,
        label,
        reason: rawStoreId
          ? `storeId「${rawStoreId}」が店舗マスターに存在しません（別店舗への統合は行いません）`
          : "storeIdがありません",
      });
      return;
    }
    let statusStr = asStr(pick(rec, ["status"]));
    if (!statusStr) statusStr = "在籍";
    if (!(CAST_STATUSES as readonly string[]).includes(statusStr)) {
      warnings.push({
        collection: "casts",
        legacyId,
        label,
        reason: `在籍状態「${statusStr}」は不明な値のため「在籍」として移行します`,
      });
      statusStr = "在籍";
    }
    let id = legacyId ?? "";
    if (!isValidDocId(id)) {
      id = contentHashId("cast", rec);
      if (legacyId) idMap.push({ collection: "casts", legacyId, newId: id, note: "IDがFirestoreで使用不可のため置換" });
    }
    const docItem: ConvertedDoc<CastPlain> = {
      id,
      legacyId,
      data: {
        storeId,
        stageName,
        realName: asStr(pick(rec, ["realName", "honmyo"])),
        kana: asStr(pick(rec, ["kana", "furigana"])),
        hourlyWage: Math.round(asNum(pick(rec, ["hourlyWage", "wage", "hourly"]))),
        rank: mapRank(pick(rec, ["rank"])),
        status: statusStr as CastStatus,
        joinDate: asStr(pick(rec, ["joinDate", "joinedAt"])),
        leftDate: asStr(pick(rec, ["leftDate", "leaveDate"])),
        birthday: asStr(pick(rec, ["birthday", "birthDate"])),
        phone: asStr(pick(rec, ["phone", "tel"])),
        line: asStr(pick(rec, ["line", "lineId"])),
        manager: asStr(pick(rec, ["manager", "tantou"])),
        scoutedBy: asStr(pick(rec, ["scoutedBy", "scout", "scoutedby"])),
        targetSales: Math.round(asNum(pick(rec, ["targetSales"]))),
        targetHonmei: Math.round(asNum(pick(rec, ["targetHonmei", "targetHonshimei"]))),
        targetDouhan: Math.round(asNum(pick(rec, ["targetDouhan"]))),
        guarantee: asStr(pick(rec, ["guarantee", "hosho"])),
        personality: asStr(pick(rec, ["personality"])),
        memo: asStr(pick(rec, ["memo", "note"])),
        customerNotes: asStr(pick(rec, ["customerNotes", "customerNote"])),
        archived: asBool(pick(rec, ["archived"])),
      },
    };
    casts.push(docItem);
    castById.set(id, docItem);
    if (legacyId) castIdMap.set(legacyId, id);
  });

  // 同名キャスト（同一店舗×正規化名）は重複候補として報告（除外はしない）
  const nameSeen = new Map<string, ConvertedDoc<CastPlain>>();
  for (const c of casts) {
    const key = `${c.data.storeId}::${normalizeName(c.data.stageName)}`;
    const prev = nameSeen.get(key);
    if (prev) {
      duplicates.push({
        collection: "casts",
        legacyId: c.legacyId,
        label: c.data.stageName,
        reason: `同一店舗に同名キャストが複数存在します（${prev.id} と ${c.id}）。自動統合はしません`,
      });
    } else {
      nameSeen.set(key, c);
    }
  }

  const resolveCast = (rawCastId: unknown): ConvertedDoc<CastPlain> | null => {
    const cid = asStr(rawCastId);
    if (!cid) return null;
    const mapped = castIdMap.get(cid) ?? cid;
    return castById.get(mapped) ?? null;
  };

  // ---- monthlyResults ----
  const monthlyResults: ConvertedDoc<MonthlyResultPlain>[] = [];
  const mrByKey = new Map<string, number>(); // docId → index（後勝ち）
  legacy.monthlyResults.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const cast = resolveCast(pick(rec, ["castId", "cast"]));
    const label = `${asStr(pick(rec, ["castName", "name"])) || cast?.data.stageName || asStr(pick(rec, ["castId"])) || `#${idx}`} / ${asStr(pick(rec, ["month"]))}`;
    if (!cast) {
      orphans.push({
        collection: "monthlyResults",
        legacyId,
        label,
        reason: `参照先キャスト（castId: ${asStr(pick(rec, ["castId"])) || "なし"}）が存在しません`,
      });
      return;
    }
    const month = normalizeMonth(asStr(pick(rec, ["month", "targetMonth"])));
    if (!month) {
      badMonth.push({
        collection: "monthlyResults",
        legacyId,
        label,
        reason: `月「${asStr(pick(rec, ["month", "targetMonth"])) || "なし"}」を YYYY-MM へ変換できません`,
      });
      return;
    }
    const rawStoreId = asStr(pick(rec, ["storeId", "store"]));
    const storeId = rawStoreId ? resolveStoreId(rawStoreId) ?? cast.data.storeId : cast.data.storeId;
    if (rawStoreId && resolveStoreId(rawStoreId) === null) {
      warnings.push({
        collection: "monthlyResults",
        legacyId,
        label,
        reason: `storeId「${rawStoreId}」が店舗マスターに無いため、キャストの店舗（${cast.data.storeId}）を使用します`,
      });
    }
    const id = monthlyResultId(storeId, cast.id, month);
    const data: MonthlyResultPlain = {
      castId: cast.id,
      storeId,
      month,
      totalSales: Math.round(asNum(pick(rec, ["totalSales", "sales"]))),
      payment: Math.round(asNum(pick(rec, ["payment", "salary", "pay"]))),
      honshimeiCount: asNum(pick(rec, ["honshimeiCount", "honshimei"])),
      honshimeiGroupCount: asNum(pick(rec, ["honshimeiGroupCount", "honshimeiGroup", "honGroup"])),
      customerCount: asNum(pick(rec, ["customerCount", "customers"])),
      jounaiCount: asNum(pick(rec, ["jounaiCount", "jounai"])),
      douhan: asNum(pick(rec, ["douhan", "douhanCount"])),
      workDays: asNum(pick(rec, ["workDays", "workDay"])),
      workHours: asNum(pick(rec, ["workHours", "workHour"])),
      absent: asNum(pick(rec, ["absent", "absentDays"])),
      notes: asStr(pick(rec, ["notes", "note", "memo"])),
      batchId: null,
    };
    const prevIdx = mrByKey.get(id);
    if (prevIdx !== undefined) {
      duplicates.push({
        collection: "monthlyResults",
        legacyId,
        label,
        reason: `同一店舗・同一キャスト・同一月（${id}）のデータが複数あります。後のデータを採用します`,
      });
      monthlyResults[prevIdx] = { id, legacyId, data };
      return;
    }
    mrByKey.set(id, monthlyResults.length);
    monthlyResults.push({ id, legacyId, data });
    if (legacyId && legacyId !== id) {
      idMap.push({ collection: "monthlyResults", legacyId, newId: id, note: "IDを storeId_castId_YYYY-MM へ統一" });
    }
  });

  // ---- interviews（旧interviews + 旧castRecordsの面談部分） ----
  const interviews: ConvertedDoc<InterviewPlain>[] = [];
  const goals: ConvertedDoc<GoalPlain>[] = [];
  const motivations: ConvertedDoc<MotivationPlain>[] = [];

  const buildInterview = (
    rec: LegacyRecord,
    cast: ConvertedDoc<CastPlain>
  ): InterviewPlain => ({
    castId: cast.id,
    storeId: cast.data.storeId,
    date: asStr(pick(rec, ["date", "interviewDate"])),
    type: asStr(pick(rec, ["type"])) || "face-to-face",
    importance: asStr(pick(rec, ["importance"])) || "通常",
    follow: mapFollowNeed(pick(rec, ["follow", "followNeed"])),
    interviewer: asStr(pick(rec, ["interviewer", "tantou"])),
    content: asStr(pick(rec, ["content", "interviewContent"])),
    worries: asStr(pick(rec, ["worries", "worry"])),
    decisions: asStr(pick(rec, ["decisions", "decision"])),
    nextDate: asStr(pick(rec, ["nextDate", "nextInterviewDate"])),
    nextTask: asStr(pick(rec, ["nextTask"])),
  });

  const pushInterview = (
    source: "interviews" | "castRecords",
    rec: LegacyRecord,
    idx: number
  ): ConvertedDoc<CastPlain> | null => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const cast = resolveCast(pick(rec, ["castId", "cast"]));
    const label = `${asStr(pick(rec, ["castName"])) || cast?.data.stageName || asStr(pick(rec, ["castId"])) || `#${idx}`} / ${asStr(pick(rec, ["date"]))}`;
    if (!cast) {
      orphans.push({
        collection: source,
        legacyId,
        label,
        reason: `参照先キャスト（castId: ${asStr(pick(rec, ["castId"])) || "なし"}）が存在しません`,
      });
      return null;
    }
    const data = buildInterview(rec, cast);
    if (!data.date) {
      invalid.push({ collection: source, legacyId, label, reason: "面談日がありません" });
      return null;
    }
    let id = legacyId ?? "";
    if (!isValidDocId(id)) {
      id = contentHashId("iv", rec);
      if (legacyId) idMap.push({ collection: source, legacyId, newId: id, note: "IDがFirestoreで使用不可のため置換" });
    }
    interviews.push({ id, legacyId, data });
    return cast;
  };

  legacy.interviews.forEach((rec, idx) => {
    pushInterview("interviews", rec, idx);
  });

  // ---- goals（旧goals。フィールド名を新形式へマッピング） ----
  const goalKeySeen = new Map<string, number>(); // castId::month → goals index（後勝ち）
  const pushGoal = (
    source: string,
    legacyId: string | null,
    id: string,
    cast: ConvertedDoc<CastPlain>,
    month: string,
    rec: LegacyRecord,
    aliases: Record<string, string[]>
  ) => {
    const data: GoalPlain = {
      castId: cast.id,
      storeId: cast.data.storeId,
      month,
      salesTarget: Math.round(asNum(pick(rec, aliases.salesTarget))),
      honshimeiTarget: asNum(pick(rec, aliases.honshimeiTarget)),
      honGroupTarget: asNum(pick(rec, aliases.honGroupTarget)),
      douhanTarget: asNum(pick(rec, aliases.douhanTarget)),
      jounaiTarget: asNum(pick(rec, aliases.jounaiTarget)),
      workDaysTarget: asNum(pick(rec, aliases.workDaysTarget)),
      workHoursTarget: asNum(pick(rec, aliases.workHoursTarget)),
      status: mapGoalStatus(pick(rec, aliases.status)),
      memo: asStr(pick(rec, aliases.memo)),
      task: asStr(pick(rec, aliases.task)),
    };
    const key = `${cast.id}::${month}`;
    const prevIdx = goalKeySeen.get(key);
    if (prevIdx !== undefined) {
      duplicates.push({
        collection: source,
        legacyId,
        label: `${cast.data.stageName} / ${month}`,
        reason: "同一キャスト・同一月の目標が複数あります。後のデータを採用します",
      });
      goals[prevIdx] = { id: goals[prevIdx].id, legacyId, data };
      return;
    }
    goalKeySeen.set(key, goals.length);
    goals.push({ id, legacyId, data });
  };

  const GOAL_ALIASES: Record<string, string[]> = {
    salesTarget: ["salesTarget", "sales", "targetSales"],
    honshimeiTarget: ["honshimeiTarget", "honshimei", "targetHonmei"],
    honGroupTarget: ["honGroupTarget", "honshimeiGroupTarget", "honGroup", "honshimeiGroup"],
    douhanTarget: ["douhanTarget", "douhan", "targetDouhan"],
    jounaiTarget: ["jounaiTarget", "jounai"],
    workDaysTarget: ["workDaysTarget", "workDays"],
    workHoursTarget: ["workHoursTarget", "workHours"],
    status: ["status", "goalStatus"],
    memo: ["memo", "goalMemo"],
    task: ["task", "goalTask"],
  };

  legacy.goals.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const cast = resolveCast(pick(rec, ["castId", "cast"]));
    const rawMonth = asStr(pick(rec, ["month", "goalMonth", "targetMonth"]));
    const label = `${cast?.data.stageName ?? asStr(pick(rec, ["castId"])) ?? `#${idx}`} / ${rawMonth}`;
    if (!cast) {
      orphans.push({
        collection: "goals",
        legacyId,
        label,
        reason: `参照先キャスト（castId: ${asStr(pick(rec, ["castId"])) || "なし"}）が存在しません`,
      });
      return;
    }
    const month = normalizeMonth(rawMonth);
    if (!month) {
      badMonth.push({
        collection: "goals",
        legacyId,
        label,
        reason: `月「${rawMonth || "なし"}」を YYYY-MM へ変換できません`,
      });
      return;
    }
    let id = legacyId ?? "";
    if (!isValidDocId(id)) {
      id = contentHashId("goal", rec);
      if (legacyId) idMap.push({ collection: "goals", legacyId, newId: id, note: "IDがFirestoreで使用不可のため置換" });
    }
    pushGoal("goals", legacyId, id, cast, month, rec, GOAL_ALIASES);
  });

  // ---- motivationLogs → motivations（値のマッピング） ----
  const pushMotivation = (
    source: string,
    legacyId: string | null,
    id: string,
    cast: ConvertedDoc<CastPlain>,
    rec: LegacyRecord,
    aliases: Record<string, string[]>
  ): boolean => {
    const rawLevel = pick(rec, aliases.level);
    const level = mapMotiLevel(rawLevel);
    const label = `${cast.data.stageName} / ${asStr(pick(rec, aliases.date))}`;
    if (!level) {
      invalid.push({
        collection: source,
        legacyId,
        label,
        reason: `モチベーションレベル「${asStr(rawLevel) || "なし"}」を5段階（${MOTI_LEVELS.join(" / ")}）へ変換できません`,
      });
      return false;
    }
    motivations.push({
      id,
      legacyId,
      data: {
        castId: cast.id,
        storeId: cast.data.storeId,
        date: asStr(pick(rec, aliases.date)),
        level,
        followNeed: mapFollowNeed(pick(rec, aliases.followNeed)),
        followDate: asStr(pick(rec, aliases.followDate)),
        state: asStr(pick(rec, aliases.state)),
        danger: asStr(pick(rec, aliases.danger)),
        follow: asStr(pick(rec, aliases.follow)),
        growth: asStr(pick(rec, aliases.growth)),
      },
    });
    return true;
  };

  const MOTI_ALIASES: Record<string, string[]> = {
    level: ["level", "motiLevel", "motivationLevel"],
    date: ["date", "logDate"],
    followNeed: ["followNeed", "follow"],
    followDate: ["followDate"],
    state: ["state", "motiState", "currentState"],
    danger: ["danger", "motiDanger", "risk"],
    follow: ["followContent", "motiFollow", "followText"],
    growth: ["growth", "motiGrowth", "growthPoint"],
  };

  legacy.motivationLogs.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const cast = resolveCast(pick(rec, ["castId", "cast"]));
    if (!cast) {
      orphans.push({
        collection: "motivationLogs",
        legacyId,
        label: `${asStr(pick(rec, ["castId"])) || `#${idx}`} / ${asStr(pick(rec, ["date"]))}`,
        reason: `参照先キャスト（castId: ${asStr(pick(rec, ["castId"])) || "なし"}）が存在しません`,
      });
      return;
    }
    let id = legacyId ?? "";
    if (!isValidDocId(id)) {
      id = contentHashId("moti", rec);
      if (legacyId) idMap.push({ collection: "motivationLogs", legacyId, newId: id, note: "IDがFirestoreで使用不可のため置換" });
    }
    pushMotivation("motivationLogs", legacyId, id, cast, rec, MOTI_ALIASES);
  });

  // ---- castRecords（統合記録）→ interviews / goals / motivations へ分離 ----
  // 旧版の saveRecord は面談・目標・モチベーションを1レコードに保存していたため、
  // 面談部分は interviews へ（IDは旧IDを保持）、
  // 目標部分は `${旧ID}_goal`、モチベーション部分は `${旧ID}_moti` として分離する。
  legacy.castRecords.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const cast = pushInterview("castRecords", rec, idx);
    if (!cast) return;
    const baseId = interviews[interviews.length - 1].id;

    // 目標部分（いずれかの目標値 or 目標状況があれば移行 — 旧saveRecordのhasGoal判定と同じ）
    const goalMonthRaw = asStr(pick(rec, ["goalMonth", "month"]));
    const hasGoal =
      asNum(pick(rec, ["salesTarget"])) > 0 ||
      asNum(pick(rec, ["honshimeiTarget"])) > 0 ||
      asNum(pick(rec, ["douhanTarget"])) > 0 ||
      asNum(pick(rec, ["workDaysTarget"])) > 0 ||
      mapGoalStatus(pick(rec, ["goalStatus", "status"])) !== "";
    if (hasGoal) {
      const month = normalizeMonth(goalMonthRaw);
      if (!month) {
        badMonth.push({
          collection: "castRecords(goal)",
          legacyId,
          label: `${cast.data.stageName} / ${goalMonthRaw}`,
          reason: `目標の月「${goalMonthRaw || "なし"}」を YYYY-MM へ変換できません`,
        });
      } else {
        const gid = `${baseId}_goal`;
        if (legacyId) idMap.push({ collection: "castRecords", legacyId, newId: gid, note: "統合記録の目標部分を goals へ分離" });
        pushGoal("castRecords(goal)", legacyId, gid, cast, month, rec, {
          salesTarget: ["salesTarget"],
          honshimeiTarget: ["honshimeiTarget"],
          honGroupTarget: ["honGroupTarget"],
          douhanTarget: ["douhanTarget"],
          jounaiTarget: ["jounaiTarget"],
          workDaysTarget: ["workDaysTarget"],
          workHoursTarget: ["workHoursTarget"],
          status: ["goalStatus", "status"],
          memo: ["goalMemo"],
          task: ["goalTask"],
        });
      }
    }

    // モチベーション部分（レベルが入っていれば移行 — 旧saveRecordと同じ）
    const rawLevel = pick(rec, ["motiLevel", "level"]);
    if (asStr(rawLevel) !== "") {
      const mid = `${baseId}_moti`;
      const ok = pushMotivation("castRecords(moti)", legacyId, mid, cast, rec, {
        level: ["motiLevel", "level"],
        date: ["date"],
        followNeed: ["followNeed", "follow"],
        followDate: ["followDate"],
        state: ["motiState", "state"],
        danger: ["motiDanger", "danger"],
        follow: ["motiFollow"],
        growth: ["motiGrowth", "growth"],
      });
      if (ok && legacyId) {
        idMap.push({ collection: "castRecords", legacyId, newId: mid, note: "統合記録のモチベーション部分を motivations へ分離" });
      }
    }
  });

  // ---- wageHistory ----
  const wageHistory: ConvertedDoc<WageHistoryPlain>[] = [];
  legacy.wageHistory.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const cast = resolveCast(pick(rec, ["castId", "cast"]));
    const label = `${cast?.data.stageName ?? asStr(pick(rec, ["castId"])) ?? `#${idx}`}`;
    if (!cast) {
      orphans.push({
        collection: "wageHistory",
        legacyId,
        label,
        reason: `参照先キャスト（castId: ${asStr(pick(rec, ["castId"])) || "なし"}）が存在しません`,
      });
      return;
    }
    const rawMonth = asStr(pick(rec, ["effectiveMonth", "month"]));
    const month = rawMonth ? normalizeMonth(rawMonth) : "";
    if (rawMonth && !month) {
      badMonth.push({
        collection: "wageHistory",
        legacyId,
        label: `${label} / ${rawMonth}`,
        reason: `適用月「${rawMonth}」を YYYY-MM へ変換できません`,
      });
      return;
    }
    let id = legacyId ?? "";
    if (!isValidDocId(id)) {
      id = contentHashId("wage", rec);
      if (legacyId) idMap.push({ collection: "wageHistory", legacyId, newId: id, note: "IDがFirestoreで使用不可のため置換" });
    }
    wageHistory.push({
      id,
      legacyId,
      data: {
        castId: cast.id,
        storeId: cast.data.storeId,
        oldHourlyWage: Math.round(asNum(pick(rec, ["oldHourlyWage", "oldWage", "old"]))),
        newHourlyWage: Math.round(asNum(pick(rec, ["newHourlyWage", "newWage", "new"]))),
        effectiveMonth: month ?? "",
        reason: asStr(pick(rec, ["reason", "note", "memo"])),
        source: "migration",
      },
    });
  });

  // ---- nameMatchingRules ----
  const nameMatchingRules: ConvertedDoc<NameMatchingRulePlain>[] = [];
  const ruleSeen = new Set<string>();
  legacy.nameMatchingRules.forEach((rec, idx) => {
    const legacyId = rec.id != null ? String(rec.id) : null;
    const sourceName = asStr(pick(rec, ["sourceName", "name", "excelName"]));
    const label = sourceName || String(legacyId ?? `#${idx}`);
    if (!sourceName) {
      invalid.push({ collection: "nameMatchingRules", legacyId, label, reason: "照合元の名前がありません" });
      return;
    }
    const rawStoreId = asStr(pick(rec, ["storeId", "store"]));
    const storeId = resolveStoreId(rawStoreId);
    if (!storeId) {
      unknownStore.push({
        collection: "nameMatchingRules",
        legacyId,
        label,
        reason: rawStoreId
          ? `storeId「${rawStoreId}」が店舗マスターに存在しません`
          : "storeIdがありません",
      });
      return;
    }
    const decision = mapDecision(pick(rec, ["decision", "action", "type"]));
    if (!decision) {
      invalid.push({
        collection: "nameMatchingRules",
        legacyId,
        label,
        reason: `照合結果「${asStr(pick(rec, ["decision", "action", "type"])) || "なし"}」を link / new / exclude へ変換できません`,
      });
      return;
    }
    const rawLinked = asStr(pick(rec, ["linkedCastId", "castId"]));
    const linkedCastId = rawLinked ? castIdMap.get(rawLinked) ?? rawLinked : null;
    if (decision === "link" && linkedCastId && !castById.has(linkedCastId)) {
      warnings.push({
        collection: "nameMatchingRules",
        legacyId,
        label,
        reason: `リンク先キャスト（${rawLinked}）が移行データ内に存在しません。次回インポート時に再確認になります`,
      });
    }
    const normalizedName = asStr(pick(rec, ["normalizedName"])) || normalizeName(sourceName);
    const id = nameMatchingRuleId(storeId, normalizedName);
    if (ruleSeen.has(id)) {
      duplicates.push({
        collection: "nameMatchingRules",
        legacyId,
        label,
        reason: `同一店舗・同一正規化名（${normalizedName}）のルールが複数あります。後のデータを採用します`,
      });
      const pos = nameMatchingRules.findIndex((r) => r.id === id);
      if (pos >= 0) nameMatchingRules.splice(pos, 1);
    }
    ruleSeen.add(id);
    const rawWage = pick(rec, ["hourlyWage", "wage"]);
    nameMatchingRules.push({
      id,
      legacyId,
      data: {
        storeId,
        sourceName,
        normalizedName,
        decision,
        linkedCastId,
        hourlyWage: rawWage == null || rawWage === "" ? null : Math.round(asNum(rawWage)),
        active: pick(rec, ["active"]) === undefined ? true : asBool(rec["active"]),
      },
    });
    if (legacyId && legacyId !== id) {
      idMap.push({ collection: "nameMatchingRules", legacyId, newId: id, note: "IDを storeId__正規化名 へ統一" });
    }
  });

  return {
    sourceFormat: legacy.sourceFormat,
    stores,
    casts,
    monthlyResults,
    interviews,
    goals,
    motivations,
    wageHistory,
    nameMatchingRules,
    idMap,
    invalid,
    orphans,
    unknownStore,
    badMonth,
    duplicates,
    warnings,
    legacyImportBatchCount: legacy.importBatches.length,
  };
}

import {
  LEGACY_COLLECTION_KEYS,
  type LegacyCollectionKey,
  type LegacyData,
  type LegacyRecord,
} from "./legacyTypes";

/**
 * 旧ローカル版JSON（exportFullJSON / localStorage 'cm2_v4' ダンプ）を
 * 統一形式 LegacyData へパースする。
 *
 * 受け付ける形:
 *  1. exportFullJSON 形式: { format/version, exportedAt, casts: [...], ... }
 *     またはコレクションが data / state 配下にネストされた形
 *  2. localStorage ダンプ: { "cm2_v4": "{...JSON文字列...}" } または
 *     { "cm2_v4": {...} }
 *  3. 本Web版のJSONバックアップ: { formatVersion: 'cmweb-backup_v1',
 *     collections: { casts: [...], ... } }
 *
 * コレクション値は「配列」「idをキーにしたオブジェクト」どちらも受け付け、
 * すべて id 付き配列へ正規化する。JSONとして壊れている場合は例外を投げる。
 */
export function parseLegacyData(jsonText: string): LegacyData {
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    throw new Error("JSONとして読み込めませんでした。ファイルが壊れていないか確認してください。");
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("JSONのルートがオブジェクトではありません。exportFullJSONで出力したファイルを指定してください。");
  }

  let obj = root as Record<string, unknown>;
  let sourceFormat = "unknown-object";

  // localStorage ダンプ形式（cm2_v4 キー配下に本体）
  if ("cm2_v4" in obj) {
    const inner = obj["cm2_v4"];
    if (typeof inner === "string") {
      try {
        obj = JSON.parse(inner) as Record<string, unknown>;
      } catch {
        throw new Error("cm2_v4 キーの中身をJSONとして読み込めませんでした。");
      }
    } else if (inner && typeof inner === "object") {
      obj = inner as Record<string, unknown>;
    }
    sourceFormat = "cm2_v4";
  }

  // Web版バックアップ形式
  if (obj["formatVersion"] === "cmweb-backup_v1" && obj["collections"] && typeof obj["collections"] === "object") {
    obj = { ...(obj["collections"] as Record<string, unknown>) };
    sourceFormat = "cmweb-backup_v1";
  }

  // data / state 配下にコレクションがネストされている形式
  for (const nest of ["data", "state"]) {
    const inner = obj[nest];
    if (
      inner &&
      typeof inner === "object" &&
      !Array.isArray(inner) &&
      LEGACY_COLLECTION_KEYS.some((k) => k in (inner as Record<string, unknown>))
    ) {
      obj = { ...obj, ...(inner as Record<string, unknown>) };
      break;
    }
  }

  if (sourceFormat === "unknown-object") {
    const fmt = obj["format"] ?? obj["version"] ?? obj["formatVersion"];
    if (typeof fmt === "string" && fmt) sourceFormat = fmt;
    else if (LEGACY_COLLECTION_KEYS.some((k) => k in obj)) sourceFormat = "cm2_v4";
  }

  if (!LEGACY_COLLECTION_KEYS.some((k) => k in obj)) {
    throw new Error(
      "旧版のデータ（casts / monthlyResults 等）が見つかりませんでした。exportFullJSONで出力したファイルか確認してください。"
    );
  }

  const pick = (key: LegacyCollectionKey): LegacyRecord[] => toRecordArray(obj[key]);

  return {
    sourceFormat,
    casts: pick("casts"),
    monthlyResults: pick("monthlyResults"),
    interviews: pick("interviews"),
    castRecords: pick("castRecords"),
    goals: pick("goals"),
    motivationLogs: pick("motivationLogs"),
    wageHistory: pick("wageHistory"),
    importBatches: pick("importBatches"),
    stores: pick("stores"),
    nameMatchingRules: pick("nameMatchingRules"),
  };
}

/** 配列 or {id: record} オブジェクト → id付き配列へ正規化 */
function toRecordArray(value: unknown): LegacyRecord[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((v): v is Record<string, unknown> => v !== null && typeof v === "object")
      .map((v) => {
        const rec = { ...v } as LegacyRecord;
        if (rec.id != null) rec.id = String(rec.id);
        return rec;
      });
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && typeof v === "object")
      .map(([id, v]) => {
        const rec = { ...(v as Record<string, unknown>) } as LegacyRecord;
        // オブジェクトのキーをidとして採用（レコード側にidがあればそちらを優先）
        if (rec.id == null) rec.id = id;
        else rec.id = String(rec.id);
        return rec;
      });
  }
  return [];
}

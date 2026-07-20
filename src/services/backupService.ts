import { Timestamp, collection, getDocs } from "firebase/firestore";
import { getDb } from "@/lib/firebase";

/**
 * JSONバックアップ（owner専用・Rulesでも実質owner以外は全件取得不可）。
 *
 * 対象は業務データのみ。users（パスワードはそもそもFirestoreに存在しないが、
 * メールアドレス等の認証関連情報を含む）と Firebase Authentication の情報は
 * 一切出力しない。
 */
export const BACKUP_FORMAT_VERSION = "cmweb-backup_v1";

export const BACKUP_COLLECTIONS = [
  "stores",
  "casts",
  "monthlyResults",
  "interviews",
  "goals",
  "motivations",
  "wageHistory",
  "nameMatchingRules",
  "importBatches",
] as const;

export interface BackupJson {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  exportedAt: string; // ISO8601
  exportedBy: string; // uid
  counts: Record<string, number>;
  collections: Record<string, Array<Record<string, unknown>>>;
}

/** Timestamp をISO文字列へ変換しつつ全フィールドを直列化する */
function serializeValue(v: unknown): unknown {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(serializeValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = serializeValue(val);
    }
    return out;
  }
  return v;
}

export async function exportBackupJson(
  actorUid: string,
  onProgress?: (collectionName: string, done: number, total: number) => void
): Promise<BackupJson> {
  const db = getDb();
  const collections: BackupJson["collections"] = {};
  const counts: Record<string, number> = {};
  let done = 0;
  for (const name of BACKUP_COLLECTIONS) {
    onProgress?.(name, done, BACKUP_COLLECTIONS.length);
    const snap = await getDocs(collection(db, name));
    collections[name] = snap.docs.map((d) => ({
      id: d.id,
      ...(serializeValue(d.data()) as Record<string, unknown>),
    }));
    counts[name] = snap.size;
    done++;
  }
  onProgress?.("完了", done, BACKUP_COLLECTIONS.length);
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: actorUid,
    counts,
    collections,
  };
}

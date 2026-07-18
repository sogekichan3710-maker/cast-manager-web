/**
 * 旧ローカルHTML版（cast-manager-v2/index.html）のデータ形式。
 *
 * 旧版はブラウザの localStorage にキー 'cm2_v4' でアプリ全体の状態を
 * JSON文字列として保存し、exportFullJSON / importFullJSON で
 * その内容をファイルへ入出力していた。
 *
 * 注意: 旧index.html自体は本リポジトリに含まれていないため、この定義は
 * 移植済みコード（src/types/domain.ts の旧版準拠コメント・README）と
 * PR4指示に記載された旧形式情報から復元したものである。実ファイルとの
 * 差異に備え、パーサーはフィールド名の別名（エイリアス）を広く受け付け、
 * 解釈できないデータは「不正データ」として件数・内容を報告する設計とする。
 */

/** 旧版JSONに現れうるコレクションキー */
export const LEGACY_COLLECTION_KEYS = [
  "casts",
  "monthlyResults",
  "interviews",
  "castRecords",
  "goals",
  "motivationLogs",
  "wageHistory",
  "importBatches",
  "stores",
  "nameMatchingRules",
] as const;
export type LegacyCollectionKey = (typeof LEGACY_COLLECTION_KEYS)[number];

/** 旧レコードは形式が揺れるため、汎用レコードとして扱う */
export type LegacyRecord = Record<string, unknown> & { id?: string };

/** パース済みの旧データ（すべて id 付き配列へ正規化済み） */
export interface LegacyData {
  /** 検出したフォーマット名（'cm2_v4' / 'cmweb-backup_v1' / 'unknown-object'） */
  sourceFormat: string;
  casts: LegacyRecord[];
  monthlyResults: LegacyRecord[];
  interviews: LegacyRecord[];
  castRecords: LegacyRecord[];
  goals: LegacyRecord[];
  motivationLogs: LegacyRecord[];
  wageHistory: LegacyRecord[];
  importBatches: LegacyRecord[];
  stores: LegacyRecord[];
  nameMatchingRules: LegacyRecord[];
}

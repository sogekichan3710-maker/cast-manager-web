import {
  collection,
  doc,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
  type Transaction,
  type WriteBatch,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import type { AuditAction, AuditLogDoc, AuditLogWithId } from "@/types";

const COL = "auditLogs";

/**
 * 監査ログサービス（PR5）。
 *
 * 重要操作すべてで「誰が・いつ・何を・どの店舗で・変更前・変更後」を
 * 記録する。auditLogs は Firestore Rules で追記のみ（更新・削除不可）に
 * 制限されている。
 *
 * 呼び出し規約:
 * - 業務データの変更（cast/monthlyResult/interview/goal/motivation/
 *   wageHistory）は、変更を行う writeBatch / runTransaction と
 *   同一のバッチへ addAuditLogToBatch で含める（変更とログが同時に
 *   成功/失敗し、ログの欠落を防ぐ）
 * - Excelインポート・ロールバック・移行・バックアップ・ユーザー管理系は
 *   単独操作のため writeAuditLog を直接呼ぶ
 */

export interface AuditLogInput {
  actorUid: string;
  actorName: string;
  action: AuditAction;
  collection: string;
  documentId: string;
  storeId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function toDocData(input: AuditLogInput): Omit<AuditLogDoc, "createdAt"> & {
  createdAt: ReturnType<typeof serverTimestamp>;
} {
  return {
    userId: input.actorUid,
    userName: input.actorName || input.actorUid,
    action: input.action,
    collection: input.collection,
    documentId: input.documentId,
    storeId: input.storeId,
    before: input.before,
    after: input.after,
    createdAt: serverTimestamp(),
  };
}

/** 単独操作の監査ログを書き込む */
export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);
  batch.set(doc(collection(db, COL)), toDocData(input));
  await batch.commit();
}

/**
 * 業務データ変更と同一バッチへ監査ログを追加する。
 * 呼び出し側の writeBatch に対して使う（変更とログの原子性を保つ）。
 */
export function addAuditLogToBatch(batch: WriteBatch, input: AuditLogInput): void {
  batch.set(doc(collection(getDb(), COL)), toDocData(input));
}

/**
 * 業務データ変更と同一トランザクションへ監査ログを追加する。
 * runTransaction 内の tx に対して使う（変更とログの原子性を保つ）。
 */
export function addAuditLogToTransaction(tx: Transaction, input: AuditLogInput): void {
  tx.set(doc(collection(getDb(), COL)), toDocData(input));
}

/**
 * 監査ログ一覧を購読する（owner専用・Rules側でも制限）。
 * Firestoreクエリ自体に limit を付けて取得すること（全件取得後に
 * クライアント側でスライスすると、ログが増えるほど読み取り件数・
 * 転送量・リスナーコストが際限なく増加するため）。
 */
export function subscribeAuditLogs(
  onChange: (logs: AuditLogWithId[]) => void,
  onError: (message: string) => void,
  max = 500
): Unsubscribe {
  return onSnapshot(
    query(collection(getDb(), COL), orderBy("createdAt", "desc"), fsLimit(max)),
    (snap) => {
      onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as AuditLogDoc) })));
    },
    (err) => onError(err.message)
  );
}

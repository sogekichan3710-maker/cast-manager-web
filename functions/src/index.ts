import { initializeApp } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { resolveCastDeleteOutcome } from "./castDeleteGuard";
import {
  GuardError,
  assertCanChangeRole,
  assertCanDisable,
  assertSelfDisableConfirmed,
  type Role,
  type TargetUserSnapshot,
} from "./lastOwnerGuard";
import { StoreAccessGuardError, normalizeStoreIds } from "./storeAccessGuard";

/**
 * ユーザー承認・権限変更・無効化・最後のowner保護・キャスト完全削除（PR5）。
 *
 * これらはPR1〜PR4ではクライアント側のFirestoreトランザクション/複数回の
 * 書き込みで暫定実装していた。Admin SDKはFirestore Security Rulesを
 * バイパスするため、Rules側では users.role / status / accessibleStoreIds /
 * approvedAt / approvedBy / disabledAt をクライアントから直接変更できない
 * よう制限し（firestore.rules参照）、casts の任意削除もownerを含め
 * クライアントSDKから禁止している。これらの変更は必ずこの Cloud Functions
 * を経由させる。
 *
 * 「最後の承認済みownerの保護」は、Firestoreトランザクション内で
 * 承認済みowner数をクエリで数え、その場で判定することで、同時操作による
 * 競合があっても正しく機能する。
 *
 * 監査ログの信頼性（レビュー対応）:
 * - actorUid は必ず request.auth.uid（クライアントからは受け取らない）
 * - actorName は必ず呼び出し元 users/{uid} ドキュメントから取得する
 *   （request.data.actorName は一切参照・信用しない。以前はここを
 *   クライアント入力から取っていたため、任意の名前を偽装できる不具合が
 *   あった）
 * - action は各Functionが固定文字列でハードコードしており、クライアントの
 *   入力では変えられない
 * - createdAt は必ずサーバー時刻（FieldValue.serverTimestamp()）
 */

initializeApp();

/**
 * Callable Functionsのrequest.data型（PR5レビュー対応: TS7006解消のため
 * onCall<T>へ明示的に渡す。実行時の型は保証されないクライアント入力の
 * ため、検証が必要なフィールド（例: storeIds）は unknown で受け取り、
 * ハンドラ内で検証してから使う）。
 */
interface ApproveUserRequestData {
  targetUid: string;
}
interface ChangeUserRoleRequestData {
  targetUid: string;
  /** クライアント入力は信用せず、isRole()で検証してから使う */
  newRole: unknown;
}
interface DisableUserRequestData {
  targetUid: string;
  confirmSelf?: boolean;
}
interface EnableUserRequestData {
  targetUid: string;
}
interface SetAccessibleStoresRequestData {
  targetUid: string;
  storeIds: unknown;
  confirmEmpty?: boolean;
}
interface DeleteCastPermanentlyRequestData {
  castId: string;
}

const ROLE_VALUES: readonly Role[] = ["owner", "admin", "viewer"];
function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLE_VALUES as readonly string[]).includes(value);
}

const USERS = "users";
const STORES = "stores";
const CASTS = "casts";
const NAME_MATCHING_RULES = "nameMatchingRules";
const AUDIT_LOGS = "auditLogs";
const RELATED_CAST_COLLECTIONS = [
  "monthlyResults",
  "interviews",
  "goals",
  "motivations",
  "wageHistory",
] as const;
const DELETE_BATCH_SIZE = 400;

function db(): Firestore {
  return getFirestore();
}

/** 承認済みowner数を「現在のトランザクション内」でクエリする（原子性を保証） */
async function countApprovedOwnersInTx(tx: Transaction): Promise<number> {
  const snap = await tx.get(
    db().collection(USERS).where("role", "==", "owner").where("status", "==", "approved")
  );
  return snap.size;
}

/**
 * 呼び出し元が承認済みownerであることを検証し、監査ログ用のactorNameを
 * サーバー側（呼び出し元自身のusersドキュメント）から取得して返す。
 * クライアントが送ってくるactorNameは一切参照しない。
 */
async function requireCallerIsOwner(uid: string): Promise<string> {
  const snap = await db().collection(USERS).doc(uid).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "ユーザー情報が見つかりません");
  const data = snap.data()!;
  if (data.status !== "approved" || data.role !== "owner") {
    throw new HttpsError("permission-denied", "オーナー権限が必要です");
  }
  return String(data.displayName ?? "");
}

function requireAuth<T>(request: CallableRequest<T>): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインが必要です");
  return uid;
}

function addAuditLog(
  tx: Transaction,
  params: {
    actorUid: string;
    actorName: string;
    action: string;
    collection: string;
    documentId: string;
    storeId?: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }
): void {
  const ref = db().collection(AUDIT_LOGS).doc();
  tx.set(ref, {
    userId: params.actorUid,
    userName: params.actorName || params.actorUid,
    action: params.action,
    collection: params.collection,
    documentId: params.documentId,
    storeId: params.storeId ?? null,
    before: params.before,
    after: params.after,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/** トランザクション外（分割バッチ処理の後）で監査ログを直接書き込む */
async function writeAuditLogDirect(params: {
  actorUid: string;
  actorName: string;
  action: string;
  collection: string;
  documentId: string;
  storeId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}): Promise<void> {
  await db().collection(AUDIT_LOGS).add({
    userId: params.actorUid,
    userName: params.actorName || params.actorUid,
    action: params.action,
    collection: params.collection,
    documentId: params.documentId,
    storeId: params.storeId,
    before: params.before,
    after: params.after,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function guardErrorToHttpsError(err: unknown): never {
  if (err instanceof GuardError) {
    throw new HttpsError("failed-precondition", err.message);
  }
  if (err instanceof StoreAccessGuardError) {
    throw new HttpsError(
      err.code === "confirm-empty-required" ? "failed-precondition" : "invalid-argument",
      err.message
    );
  }
  throw err;
}

/** pendingユーザーを承認する */
export const approveUser = onCall<ApproveUserRequestData>(async (request) => {
  const callerUid = requireAuth(request);
  const actorName = await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");

  await db().runTransaction(async (tx: Transaction) => {
    const ref = db().collection(USERS).doc(targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "対象ユーザーが見つかりません");
    const before = snap.data()!;
    if (before.status === "approved") throw new HttpsError("failed-precondition", "既に承認済みです");
    tx.update(ref, {
      status: "approved",
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: callerUid,
      disabledAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    addAuditLog(tx, {
      actorUid: callerUid,
      actorName,
      action: "user.approve",
      collection: USERS,
      documentId: targetUid,
      before: { status: before.status },
      after: { status: "approved" },
    });
  });
  return { ok: true };
});

/** ユーザーの権限（role）を変更する */
export const changeUserRole = onCall<ChangeUserRoleRequestData>(async (request) => {
  const callerUid = requireAuth(request);
  const actorName = await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  const newRoleInput = request.data?.newRole;
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");
  if (!isRole(newRoleInput)) {
    throw new HttpsError("invalid-argument", "newRole が不正です");
  }
  const newRole = newRoleInput;

  await db().runTransaction(async (tx: Transaction) => {
    const ref = db().collection(USERS).doc(targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "対象ユーザーが見つかりません");
    const before = snap.data()!;
    const target: TargetUserSnapshot = {
      uid: targetUid,
      role: before.role,
      status: before.status,
    };
    const approvedOwnerCount = await countApprovedOwnersInTx(tx);
    try {
      assertCanChangeRole(target, newRole, approvedOwnerCount);
    } catch (err) {
      guardErrorToHttpsError(err);
    }
    tx.update(ref, { role: newRole, updatedAt: FieldValue.serverTimestamp() });
    addAuditLog(tx, {
      actorUid: callerUid,
      actorName,
      action: "user.roleChange",
      collection: USERS,
      documentId: targetUid,
      before: { role: before.role },
      after: { role: newRole },
    });
  });
  return { ok: true };
});

/**
 * ユーザーを無効化する。
 * 最後の承認済みownerの無効化は禁止（assertCanDisable）。
 * 自分自身を無効化する場合は confirmSelf: true が必須
 * （assertSelfDisableConfirmed＝誤操作による自己ロックアウト防止）。
 */
export const disableUser = onCall<DisableUserRequestData>(async (request) => {
  const callerUid = requireAuth(request);
  const actorName = await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  const confirmSelf = Boolean(request.data?.confirmSelf);
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");

  try {
    assertSelfDisableConfirmed(callerUid, targetUid, confirmSelf);
  } catch (err) {
    guardErrorToHttpsError(err);
  }

  await db().runTransaction(async (tx: Transaction) => {
    const ref = db().collection(USERS).doc(targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "対象ユーザーが見つかりません");
    const before = snap.data()!;
    const target: TargetUserSnapshot = {
      uid: targetUid,
      role: before.role,
      status: before.status,
    };
    const approvedOwnerCount = await countApprovedOwnersInTx(tx);
    try {
      assertCanDisable(target, approvedOwnerCount);
    } catch (err) {
      guardErrorToHttpsError(err);
    }
    tx.update(ref, {
      status: "disabled",
      disabledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addAuditLog(tx, {
      actorUid: callerUid,
      actorName,
      action: "user.disable",
      collection: USERS,
      documentId: targetUid,
      before: { status: before.status },
      after: { status: "disabled" },
    });
  });
  return { ok: true };
});

/** 無効化されたユーザーを再有効化する */
export const enableUser = onCall<EnableUserRequestData>(async (request) => {
  const callerUid = requireAuth(request);
  const actorName = await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");

  await db().runTransaction(async (tx: Transaction) => {
    const ref = db().collection(USERS).doc(targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "対象ユーザーが見つかりません");
    const before = snap.data()!;
    if (before.status !== "disabled") {
      throw new HttpsError("failed-precondition", "無効化されたユーザーではありません");
    }
    tx.update(ref, {
      status: "approved",
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: callerUid,
      disabledAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    addAuditLog(tx, {
      actorUid: callerUid,
      actorName,
      action: "user.enable",
      collection: USERS,
      documentId: targetUid,
      before: { status: before.status },
      after: { status: "approved" },
    });
  });
  return { ok: true };
});

/**
 * 閲覧可能店舗を設定する。
 * 入力検証（レビュー対応）:
 * - storeIds は文字列配列・'__all__'禁止・重複除去（normalizeStoreIds）
 * - 空配列（全店舗剥奪）は confirmEmpty: true が必須
 * - 各storeIdは stores コレクションに実在し、かつ active であること
 * - 対象ユーザーが存在すること
 */
export const setAccessibleStores = onCall<SetAccessibleStoresRequestData>(async (request) => {
  const callerUid = requireAuth(request);
  const actorName = await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  const confirmEmpty = Boolean(request.data?.confirmEmpty);
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");

  let storeIds: string[];
  try {
    storeIds = normalizeStoreIds(request.data?.storeIds, confirmEmpty);
  } catch (err) {
    guardErrorToHttpsError(err);
  }

  await db().runTransaction(async (tx: Transaction) => {
    const ref = db().collection(USERS).doc(targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "対象ユーザーが見つかりません");
    const before = snap.data()!;

    // 店舗の実在・active判定（トランザクション内・すべて読み取り→書き込みの順）
    const storeRefs: DocumentReference[] = storeIds.map(
      (id: string): DocumentReference => db().collection(STORES).doc(id)
    );
    const storeSnaps = storeRefs.length > 0 ? await tx.getAll(...storeRefs) : [];
    for (let i = 0; i < storeSnaps.length; i++) {
      const s = storeSnaps[i];
      if (!s.exists) {
        throw new HttpsError("invalid-argument", `店舗が見つかりません: ${storeIds[i]}`);
      }
      if (s.data()?.active !== true) {
        throw new HttpsError("invalid-argument", `無効化された店舗は指定できません: ${storeIds[i]}`);
      }
    }

    tx.update(ref, { accessibleStoreIds: storeIds, updatedAt: FieldValue.serverTimestamp() });
    addAuditLog(tx, {
      actorUid: callerUid,
      actorName,
      action: "user.accessibleStoresChange",
      collection: USERS,
      documentId: targetUid,
      before: { accessibleStoreIds: before.accessibleStoreIds ?? [] },
      after: { accessibleStoreIds: storeIds },
    });
  });
  return { ok: true, storeIds };
});

async function deleteAllByCastId(col: string, castId: string): Promise<number> {
  const snap = await db().collection(col).where("castId", "==", castId).get();
  const refs = snap.docs.map((d: QueryDocumentSnapshot): DocumentReference => d.ref);
  for (let i = 0; i < refs.length; i += DELETE_BATCH_SIZE) {
    const batch = db().batch();
    for (const ref of refs.slice(i, i + DELETE_BATCH_SIZE)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length;
}

/**
 * キャストを完全削除する（owner専用・Callable Cloud Function）。
 *
 * 手順:
 * 1. 呼び出し元が承認済みownerであることを検証
 * 2. 対象キャストを再取得
 * 3. 関連データ（monthlyResults/interviews/goals/motivations/wageHistory）を
 *    castIdクエリで再確認・全削除（400件単位バッチ）
 * 4. nameMatchingRulesのうちこのキャストへリンクしているものを無効化
 *    （削除ではなくactive:false・linkedCastId:null。監査のため履歴は残す）
 * 5. キャスト本体を削除
 * 6. 監査ログを記録
 *
 * 冪等性・再実行について（resolveCastDeleteOutcome参照）:
 * - キャストが存在すればいつでも「初回実行 or 削除途中からの再実行」として
 *   扱う。各コレクションの削除はcastIdクエリで対象を再取得するため、
 *   既に削除済みの分は自然に0件となりスキップされる（二重削除にならない）。
 * - キャストが既に存在せず、かつこのcastIdに対する
 *   cast.deletePermanent監査ログが既に存在する場合は「前回で完了済み」と
 *   判定し、何もせず成功を返す（クライアントのタイムアウト後の再送等に
 *   安全に対応）。
 * - キャストが存在せず監査ログも存在しない場合は、実在しないcastId
 *   （誤入力等）とみなしエラーを返す。
 *
 * 注意: キャスト本体の削除（手順5）と監査ログの記録（手順6）は
 * Firestoreトランザクションではなく2つの独立した書き込みである
 * （関連データが数百〜数千件に及ぶ可能性があり、単一トランザクションの
 * 書き込み上限・読み取り→書き込み順序制約に収まらないため）。
 * 手順5の直後に手順6を実行するため実運用上の欠落リスクは小さいが、
 * その間にFunctionの実行が中断された場合はキャスト本体は削除済みで
 * 監査ログが未記録という状態になり得る。その場合、同じcastIdで
 * 再実行すると（監査ログが見つからないため）「not-found」エラーとなり、
 * 自動では復旧しない。このケースはオーナーへエラー表示のうえ、
 * 監査ログ画面で該当キャストの完全削除ログが存在するかを確認し、
 * 存在しなければ手動で監査ログを補完する運用とする（極めて稀なケースの
 * ため、誤ったcastIdに対する偽の完了ログを自動生成する設計は採用しない）。
 */
export const deleteCastPermanently = onCall<DeleteCastPermanentlyRequestData>(async (request) => {
  const callerUid = requireAuth(request);
  const actorName = await requireCallerIsOwner(callerUid);
  const castId = String(request.data?.castId ?? "");
  if (!castId) throw new HttpsError("invalid-argument", "castId が必要です");

  const castRef = db().collection(CASTS).doc(castId);
  const castSnap = await castRef.get();

  let priorDeleteLogExists = false;
  if (!castSnap.exists) {
    const priorLog = await db()
      .collection(AUDIT_LOGS)
      .where("action", "==", "cast.deletePermanent")
      .where("documentId", "==", castId)
      .limit(1)
      .get();
    priorDeleteLogExists = !priorLog.empty;
  }

  const outcome = resolveCastDeleteOutcome(castSnap.exists, priorDeleteLogExists);
  if (outcome === "not-found") {
    throw new HttpsError("not-found", "キャストが見つかりません");
  }
  if (outcome === "already-deleted") {
    return { ok: true, alreadyDeleted: true, deletedCounts: null };
  }

  const castData = castSnap.data()!;

  const deletedCounts: Record<string, number> = {};
  for (const col of RELATED_CAST_COLLECTIONS) {
    deletedCounts[col] = await deleteAllByCastId(col, castId);
  }

  const ruleSnap = await db()
    .collection(NAME_MATCHING_RULES)
    .where("linkedCastId", "==", castId)
    .get();
  for (let i = 0; i < ruleSnap.docs.length; i += DELETE_BATCH_SIZE) {
    const batch = db().batch();
    const slice: QueryDocumentSnapshot[] = ruleSnap.docs.slice(i, i + DELETE_BATCH_SIZE);
    for (const d of slice) {
      batch.update(d.ref, {
        active: false,
        linkedCastId: null,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: callerUid,
      });
    }
    await batch.commit();
  }
  deletedCounts.nameMatchingRules = ruleSnap.size;

  await castRef.delete();

  await writeAuditLogDirect({
    actorUid: callerUid,
    actorName,
    action: "cast.deletePermanent",
    collection: CASTS,
    documentId: castId,
    storeId: castData.storeId ?? null,
    before: {
      stageName: castData.stageName,
      storeId: castData.storeId,
      deletedRelatedCounts: deletedCounts,
    },
    after: null,
  });

  return { ok: true, alreadyDeleted: false, deletedCounts };
});

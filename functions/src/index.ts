import { initializeApp } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import {
  GuardError,
  assertCanChangeRole,
  assertCanDisable,
  assertSelfDisableConfirmed,
  type Role,
  type TargetUserSnapshot,
} from "./lastOwnerGuard";

/**
 * ユーザー承認・権限変更・無効化・最後のowner保護（PR5）。
 *
 * これらはPR1〜PR4ではクライアント側のFirestoreトランザクションで
 * 暫定実装していた（README「⚠️ 重要: 権限変更処理は暫定実装です」参照）。
 * Admin SDKはFirestore Security Rulesをバイパスするため、Rules側では
 * users.role / status / accessibleStoreIds / approvedAt / approvedBy /
 * disabledAt をクライアントから直接変更できないよう制限し（firestore.rules
 * 参照）、これらの変更は必ずこの Cloud Functions を経由させる。
 *
 * 「最後の承認済みownerの保護」は、Firestoreトランザクション内で
 * 承認済みowner数をクエリで数え、その場で判定することで、同時操作による
 * 競合があっても正しく機能する（クライアント側の事前チェックのみでは
 * 保証できなかった問題を解消）。
 */

initializeApp();

const USERS = "users";
const AUDIT_LOGS = "auditLogs";

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

/** 呼び出し元が承認済みownerであることを検証する */
async function requireCallerIsOwner(uid: string): Promise<void> {
  const snap = await db().collection(USERS).doc(uid).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "ユーザー情報が見つかりません");
  const data = snap.data()!;
  if (data.status !== "approved" || data.role !== "owner") {
    throw new HttpsError("permission-denied", "オーナー権限が必要です");
  }
}

function requireAuth(request: CallableRequest): string {
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
    documentId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }
): void {
  const ref = db().collection(AUDIT_LOGS).doc();
  tx.set(ref, {
    userId: params.actorUid,
    userName: params.actorName || params.actorUid,
    action: params.action,
    collection: USERS,
    documentId: params.documentId,
    storeId: null,
    before: params.before,
    after: params.after,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function guardErrorToHttpsError(err: unknown): never {
  if (err instanceof GuardError) {
    throw new HttpsError(
      err.code === "self-confirm-required" ? "failed-precondition" : "failed-precondition",
      err.message
    );
  }
  throw err;
}

/** pendingユーザーを承認する */
export const approveUser = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");

  await db().runTransaction(async (tx) => {
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
      actorName: String(request.data?.actorName ?? ""),
      action: "user.approve",
      documentId: targetUid,
      before: { status: before.status },
      after: { status: "approved" },
    });
  });
  return { ok: true };
});

/** ユーザーの権限（role）を変更する */
export const changeUserRole = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  const newRole = request.data?.newRole as Role;
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");
  if (!["owner", "admin", "viewer"].includes(newRole)) {
    throw new HttpsError("invalid-argument", "newRole が不正です");
  }

  await db().runTransaction(async (tx) => {
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
      actorName: String(request.data?.actorName ?? ""),
      action: "user.roleChange",
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
export const disableUser = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  const confirmSelf = Boolean(request.data?.confirmSelf);
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");

  try {
    assertSelfDisableConfirmed(callerUid, targetUid, confirmSelf);
  } catch (err) {
    guardErrorToHttpsError(err);
  }

  await db().runTransaction(async (tx) => {
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
      actorName: String(request.data?.actorName ?? ""),
      action: "user.disable",
      documentId: targetUid,
      before: { status: before.status },
      after: { status: "disabled" },
    });
  });
  return { ok: true };
});

/** 無効化されたユーザーを再有効化する */
export const enableUser = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");

  await db().runTransaction(async (tx) => {
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
      actorName: String(request.data?.actorName ?? ""),
      action: "user.enable",
      documentId: targetUid,
      before: { status: before.status },
      after: { status: "approved" },
    });
  });
  return { ok: true };
});

/** 閲覧可能店舗を設定する */
export const setAccessibleStores = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireCallerIsOwner(callerUid);
  const targetUid = String(request.data?.targetUid ?? "");
  const storeIds = request.data?.storeIds;
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid が必要です");
  if (!Array.isArray(storeIds) || !storeIds.every((s) => typeof s === "string")) {
    throw new HttpsError("invalid-argument", "storeIds は文字列配列で指定してください");
  }

  await db().runTransaction(async (tx) => {
    const ref = db().collection(USERS).doc(targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "対象ユーザーが見つかりません");
    const before = snap.data()!;
    tx.update(ref, { accessibleStoreIds: storeIds, updatedAt: FieldValue.serverTimestamp() });
    addAuditLog(tx, {
      actorUid: callerUid,
      actorName: String(request.data?.actorName ?? ""),
      action: "user.accessibleStoresChange",
      documentId: targetUid,
      before: { accessibleStoreIds: before.accessibleStoreIds ?? [] },
      after: { accessibleStoreIds: storeIds },
    });
  });
  return { ok: true };
});

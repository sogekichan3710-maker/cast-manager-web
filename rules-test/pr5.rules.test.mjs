/**
 * PR5 Firestore Security Rules テスト
 * （users role/status/accessibleStoreIds のCloud Functions専用化 /
 *   casts・wageHistoryの完全削除はCloud Functions専用・クライアントSDKからは
 *   owner含め禁止 / auditLogsのaction allowlist）
 *
 * 実行方法: cd rules-test && npm install && npm test
 *
 * カバーするケース:
 *  - users: role/status/accessibleStoreIds/approvedAt/approvedBy/disabledAt
 *    はowner含め誰もクライアントSDKから直接変更できない（Cloud Functions専用）
 *  - users: 本人のdisplayName更新は引き続き可能
 *  - casts: owner含め誰もクライアントSDKから任意のキャストを削除できない
 *    （完全削除はdeleteCastPermanently Cloud Function専用）。
 *    admin以下はimportBatchId付きのExcelロールバックのみ従来どおり削除可
 *  - wageHistory: 同上（owner含め任意削除不可・source:excel-importの
 *    ロールバックのみ削除可）
 *  - auditLogs: クライアントは許可されたaction（業務データ変更系）のみ
 *    作成可能。ユーザー管理・キャスト完全削除のactionはクライアントから
 *    作成できない（Cloud Functions専用）。createdAtはサーバー時刻固定
 *  - pending / disabled / usersドキュメント不在は一切アクセス不可
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { addDoc, collection, doc, getDoc, serverTimestamp, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('@firebase/rules-unit-testing').RulesTestEnvironment} */
let env;

const PROJECT_ID = "cast-manager-rules-test-pr5";

const UIDS = {
  owner: "uid-owner",
  owner2: "uid-owner-2",
  adminV: "uid-admin-virgo",
  viewerV: "uid-viewer-virgo",
  pending: "uid-pending",
  disabled: "uid-disabled",
  noDoc: "uid-no-userdoc",
};

const STORE_VIRGO = "store_virgo";
const STORE_REGINA = "store_regina";

function userDocData(role, status, stores) {
  return {
    email: `${role}-${status}-${Math.random()}@example.com`,
    displayName: `${role} ${status}`,
    role,
    status,
    accessibleStoreIds: stores,
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: status === "approved" ? new Date() : null,
    approvedBy: status === "approved" ? UIDS.owner : null,
    disabledAt: status === "disabled" ? new Date() : null,
  };
}

function castData(storeId, byUid, archived, importBatchId) {
  return {
    storeId,
    stageName: "テストキャスト",
    realName: "",
    kana: "",
    hourlyWage: 5000,
    rank: "A",
    status: "在籍",
    joinDate: "",
    leftDate: "",
    birthday: "",
    phone: "",
    line: "",
    manager: "",
    targetSales: 0,
    targetHonmei: 0,
    targetDouhan: 0,
    guarantee: "",
    personality: "",
    memo: "",
    customerNotes: "",
    archived,
    ...(importBatchId !== undefined ? { importBatchId } : {}),
    createdAt: new Date(),
    createdBy: byUid,
    updatedAt: new Date(),
    updatedBy: byUid,
  };
}

function wageHistoryData(storeId, byUid, source) {
  return {
    castId: "cast_virgo_1",
    storeId,
    oldHourlyWage: 5000,
    newHourlyWage: 5500,
    effectiveMonth: "2026-07",
    reason: "テスト",
    ...(source !== undefined ? { source } : {}),
    createdAt: new Date(),
    createdBy: byUid,
  };
}

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", UIDS.owner), userDocData("owner", "approved", []));
    await setDoc(doc(db, "users", UIDS.owner2), userDocData("owner", "approved", []));
    await setDoc(doc(db, "users", UIDS.adminV), userDocData("admin", "approved", [STORE_VIRGO]));
    await setDoc(doc(db, "users", UIDS.viewerV), userDocData("viewer", "approved", [STORE_VIRGO]));
    await setDoc(doc(db, "users", UIDS.pending), userDocData("viewer", "pending", []));
    await setDoc(doc(db, "users", UIDS.disabled), userDocData("viewer", "disabled", []));
    await setDoc(doc(db, "stores", STORE_VIRGO), {
      name: "VIRGO", code: "virgo", color: "#9c27b0", active: true, order: 0, wagePolicy: "fixed",
      createdAt: new Date(), createdBy: "seed", updatedAt: new Date(), updatedBy: "seed",
    });
    await setDoc(doc(db, "stores", STORE_REGINA), {
      name: "REGINA", code: "regina", color: "#e91e63", active: true, order: 1, wagePolicy: "slide",
      createdAt: new Date(), createdBy: "seed", updatedAt: new Date(), updatedBy: "seed",
    });
    // 手動作成キャスト（importBatchIdなし）
    await setDoc(doc(db, "casts", "cast_manual_virgo"), castData(STORE_VIRGO, "seed", false));
    await setDoc(doc(db, "casts", "cast_manual_regina"), castData(STORE_REGINA, "seed", false));
    // インポート作成キャスト（importBatchIdあり）
    await setDoc(doc(db, "casts", "cast_import_virgo"), castData(STORE_VIRGO, UIDS.adminV, false, "batch1"));
    // 手動の時給履歴（sourceなし）とExcelインポートの時給履歴
    await setDoc(doc(db, "wageHistory", "wh_manual"), wageHistoryData(STORE_VIRGO, "seed"));
    await setDoc(doc(db, "wageHistory", "wh_import"), wageHistoryData(STORE_VIRGO, UIDS.adminV, "excel-import"));
    await setDoc(doc(db, "wageHistory", "wh_migration"), wageHistoryData(STORE_VIRGO, UIDS.owner, "migration"));
  });
}

function dbAs(uid) {
  return env.authenticatedContext(uid).firestore();
}
function dbAnon() {
  return env.unauthenticatedContext().firestore();
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, "../firestore.rules"), "utf8"),
    },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await seed();
});

afterAll(async () => {
  await env.cleanup();
});

// ---------------- users: role/status/accessibleStoreIds はCloud Functions専用 ----------------
describe("users: 重要フィールドの直接変更禁止（PR5）", () => {
  it("ownerでも他ユーザーのroleをクライアントSDKから直接変更できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.viewerV), {
        role: "admin",
        updatedAt: new Date(),
      })
    );
  });

  it("ownerでも他ユーザーのstatusをクライアントSDKから直接変更できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.pending), {
        status: "approved",
        approvedAt: new Date(),
        approvedBy: UIDS.owner,
        disabledAt: null,
        updatedAt: new Date(),
      })
    );
  });

  it("ownerでも他ユーザーのaccessibleStoreIdsをクライアントSDKから直接変更できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.viewerV), {
        accessibleStoreIds: [STORE_VIRGO, STORE_REGINA],
        updatedAt: new Date(),
      })
    );
  });

  it("ownerでも他ユーザーのdisabledAtを直接変更できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.viewerV), {
        disabledAt: new Date(),
        updatedAt: new Date(),
      })
    );
  });

  it("adminやviewerはなおさら他ユーザーのroleを変更できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "users", UIDS.viewerV), {
        role: "owner",
        updatedAt: new Date(),
      })
    );
  });

  it("本人のdisplayName更新は引き続き可能", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.viewerV), "users", UIDS.viewerV), {
        displayName: "新しい名前",
        updatedAt: new Date(),
      })
    );
  });

  it("本人でもroleを混ぜて更新すると拒否される（displayName以外禁止）", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.owner), {
        displayName: "新しい名前",
        role: "admin",
        updatedAt: new Date(),
      })
    );
  });
});

// ---------------- casts: 完全削除はCloud Functions専用（PR5レビュー対応） ----------------
describe("casts: クライアントSDKからの削除禁止（PR5レビュー対応）", () => {
  it("ownerでも手動作成キャスト（importBatchIdなし）をクライアントSDKから削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "casts", "cast_manual_virgo")));
  });

  it("ownerでも全店舗のキャストをクライアントSDKから削除できない（完全削除はdeleteCastPermanently Cloud Function専用）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "casts", "cast_manual_regina")));
  });

  it("admin以下は手動作成キャストを削除できない（従来どおり）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_manual_virgo")));
  });

  it("admin以下はimportBatchId付きキャストなら削除できる（Excelロールバック用途・従来どおり維持）", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_import_virgo")));
  });

  it("ownerもimportBatchId付きキャストならExcelロールバック経路で削除できる（adminOrAboveに含まれるため）", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.owner), "casts", "cast_import_virgo")));
  });

  it("viewerは削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.viewerV), "casts", "cast_manual_virgo")));
  });
});

// ---------------- wageHistory: 完全削除はCloud Functions専用（PR5レビュー対応） ----------------
describe("wageHistory: クライアントSDKからの削除禁止（PR5レビュー対応）", () => {
  it("ownerでも手動の時給履歴（sourceなし）をクライアントSDKから削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_manual")));
  });

  it("ownerでも移行由来の時給履歴（source: migration）をクライアントSDKから削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_migration")));
  });

  it("admin以下は手動の時給履歴を削除できない（従来どおり）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_manual")));
  });

  it("admin以下はExcelインポート由来の履歴なら削除できる（ロールバック用途・従来どおり維持）", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_import")));
  });

  it("viewerは削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.viewerV), "wageHistory", "wh_manual")));
  });
});

// ---------------- auditLogs: クライアント作成のaction allowlist（PR5レビュー対応） ----------------
describe("auditLogs: クライアント作成の制限（PR5レビュー対応）", () => {
  function validClientLog(uid, action) {
    return {
      userId: uid,
      userName: "テストユーザー",
      action,
      collection: "casts",
      documentId: "cast_manual_virgo",
      storeId: STORE_VIRGO,
      before: null,
      after: null,
      createdAt: serverTimestamp(),
    };
  }

  it("業務データ変更系のactionは承認済みユーザーが作成できる", async () => {
    await assertSucceeds(
      addDoc(collection(dbAs(UIDS.adminV), "auditLogs"), validClientLog(UIDS.adminV, "cast.update"))
    );
  });

  it("user.approve 等のユーザー管理系actionはクライアントから作成できない（Cloud Functions専用）", async () => {
    await assertFails(
      addDoc(collection(dbAs(UIDS.owner), "auditLogs"), validClientLog(UIDS.owner, "user.approve"))
    );
  });

  it("cast.deletePermanent はクライアントから作成できない（Cloud Functions専用）", async () => {
    await assertFails(
      addDoc(collection(dbAs(UIDS.owner), "auditLogs"), validClientLog(UIDS.owner, "cast.deletePermanent"))
    );
  });

  it("allowlistにない任意のactionは作成できない", async () => {
    await assertFails(
      addDoc(collection(dbAs(UIDS.adminV), "auditLogs"), validClientLog(UIDS.adminV, "something.else"))
    );
  });

  it("userIdを他人のuidに偽装すると作成できない", async () => {
    await assertFails(
      addDoc(
        collection(dbAs(UIDS.adminV), "auditLogs"),
        validClientLog(UIDS.owner, "cast.update")
      )
    );
  });

  it("createdAtにサーバー時刻以外（クライアント指定の日時）を使うと作成できない", async () => {
    const log = validClientLog(UIDS.adminV, "cast.update");
    await assertFails(
      addDoc(collection(dbAs(UIDS.adminV), "auditLogs"), { ...log, createdAt: new Date() })
    );
  });

  it("owner以外はauditLogsを読めない", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.adminV), "auditLogs", "any-id")));
  });
});

// ---------------- pending/disabled/未登録は全操作不可（既存方針の維持確認） ----------------
describe("pending / disabled / usersドキュメント不在: 業務データ全面拒否（PR5でも維持）", () => {
  for (const uid of [UIDS.pending, UIDS.disabled, UIDS.noDoc]) {
    it(`${uid}: casts削除不可`, async () => {
      await assertFails(deleteDoc(doc(dbAs(uid), "casts", "cast_manual_virgo")));
    });
    it(`${uid}: wageHistory削除不可`, async () => {
      await assertFails(deleteDoc(doc(dbAs(uid), "wageHistory", "wh_manual")));
    });
  }
  it("未認証は読み取りもできない", async () => {
    await assertFails(getDoc(doc(dbAnon(), "casts", "cast_manual_virgo")));
  });
});

// ---------------- stores: wagePolicy フィールド（PR5・設定のみ） ----------------
describe("stores: wagePolicy（PR5）", () => {
  it("owner は wagePolicy 付きで店舗を更新できる", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.owner), "stores", STORE_VIRGO), {
        wagePolicy: "slide",
        updatedAt: new Date(),
        updatedBy: UIDS.owner,
      })
    );
  });

  it("承認済みユーザーはwagePolicyを含む店舗情報を読める", async () => {
    const snap = await assertSucceeds(getDoc(doc(dbAs(UIDS.viewerV), "stores", STORE_VIRGO)));
    // 読めること自体を検証（値の中身はサービス層のテストで確認）
    void snap;
  });
});

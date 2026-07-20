/**
 * PR5 Firestore Security Rules テスト
 * （users role/status/accessibleStoreIds のCloud Functions専用化 /
 *   casts完全削除・wageHistory完全削除のowner権限拡張）
 *
 * 実行方法: cd rules-test && npm install && npm test
 *
 * カバーするケース:
 *  - users: role/status/accessibleStoreIds/approvedAt/approvedBy/disabledAt
 *    はowner含め誰もクライアントSDKから直接変更できない（Cloud Functions専用）
 *  - users: 本人のdisplayName更新は引き続き可能
 *  - casts: ownerは許可店舗内なら任意のキャストを削除できる（完全削除）。
 *    admin以下はimportBatchId付き以外削除不可（従来どおり）
 *  - wageHistory: ownerは許可店舗内なら任意の履歴を削除できる（完全削除の
 *    一部）。admin以下はsource:excel-import以外削除不可（従来どおり）
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
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
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

// ---------------- casts: 完全削除（owner専用の任意キャスト削除） ----------------
describe("casts: 完全削除（PR5）", () => {
  it("ownerは手動作成キャスト（importBatchIdなし）も削除できる", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.owner), "casts", "cast_manual_virgo")));
  });

  it("ownerは全店舗のキャストを削除できる（ownerは元々全店舗アクセス権を持つ設計）", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.owner), "casts", "cast_manual_regina")));
  });

  it("admin以下は手動作成キャストを削除できない（従来どおり）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_manual_virgo")));
  });

  it("admin以下はimportBatchId付きキャストなら削除できる（ロールバック用途・従来どおり）", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_import_virgo")));
  });

  it("viewerは削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.viewerV), "casts", "cast_manual_virgo")));
  });
});

// ---------------- wageHistory: 完全削除（owner専用の任意履歴削除） ----------------
describe("wageHistory: 完全削除（PR5）", () => {
  it("ownerは手動の時給履歴（sourceなし）も削除できる", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_manual")));
  });

  it("ownerは移行由来の時給履歴（source: migration）も削除できる", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_migration")));
  });

  it("admin以下は手動の時給履歴を削除できない（従来どおり）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_manual")));
  });

  it("admin以下はExcelインポート由来の履歴なら削除できる（ロールバック用途・従来どおり）", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_import")));
  });

  it("viewerは削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.viewerV), "wageHistory", "wh_manual")));
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

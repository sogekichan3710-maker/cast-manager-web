/**
 * PR4 Firestore Security Rules テスト
 * （migrationRuns / nameMatchingRules / importBatches / casts.archived作成）
 *
 * 実行方法: cd rules-test && npm install && npm test
 *
 * カバーするケース:
 *  - migrationRuns: ownerのみ作成・更新・閲覧可 / createdBy・startedAt改竄禁止
 *  - nameMatchingRules: ownerまたは許可店舗adminのみ書込 / viewer書込不可 /
 *    storeId変更禁止 / createdBy・createdAt改竄禁止 / updatedByは本人 /
 *    許可店舗外は読めない / '__all__'禁止 / 削除不可
 *  - importBatches: ownerまたは許可店舗adminのみ作成 / viewer作成不可 /
 *    許可店舗外の作成拒否 / createdBy偽装禁止 / storeId不正変更禁止
 *  - casts: archived:true での作成は owner のみ（旧データ移行用）
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
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('@firebase/rules-unit-testing').RulesTestEnvironment} */
let env;

const PROJECT_ID = "cast-manager-rules-test-pr4";

const UIDS = {
  owner: "uid-owner",
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
    email: `${role}-${status}@example.com`,
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

function ruleData(storeId, byUid = "seed") {
  return {
    storeId,
    sourceName: "あいり",
    normalizedName: "あいり",
    decision: "link",
    linkedCastId: "cast_virgo_1",
    hourlyWage: 5000,
    active: true,
    createdAt: new Date(),
    createdBy: byUid,
    updatedAt: new Date(),
    updatedBy: byUid,
  };
}

function batchData(storeId, byUid = "seed") {
  return {
    storeId,
    fileName: "test.xlsx",
    targetMonth: "2026-07",
    status: "processing",
    totalRows: 10,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    summary: "",
    createdAt: new Date(),
    createdBy: byUid,
    completedAt: null,
  };
}

function migrationRunData(byUid) {
  return {
    fileName: "cm2_v4.json",
    sourceFormat: "cm2_v4",
    status: "processing",
    summary: "",
    startedAt: new Date(),
    completedAt: null,
    createdBy: byUid,
    errorSummary: "",
  };
}

function castData(storeId, byUid, archived) {
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
    createdAt: new Date(),
    createdBy: byUid,
    updatedAt: new Date(),
    updatedBy: byUid,
  };
}

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", UIDS.owner), userDocData("owner", "approved", []));
    await setDoc(doc(db, "users", UIDS.adminV), userDocData("admin", "approved", [STORE_VIRGO]));
    await setDoc(doc(db, "users", UIDS.viewerV), userDocData("viewer", "approved", [STORE_VIRGO]));
    await setDoc(doc(db, "users", UIDS.pending), userDocData("viewer", "pending", []));
    await setDoc(doc(db, "users", UIDS.disabled), userDocData("viewer", "disabled", []));
    await setDoc(doc(db, "stores", STORE_VIRGO), { name: "VIRGO", code: "virgo", color: "#9c27b0", active: true, order: 0, createdAt: new Date(), createdBy: "seed", updatedAt: new Date(), updatedBy: "seed" });
    await setDoc(doc(db, "stores", STORE_REGINA), { name: "REGINA", code: "regina", color: "#e91e63", active: true, order: 1, createdAt: new Date(), createdBy: "seed", updatedAt: new Date(), updatedBy: "seed" });
    await setDoc(doc(db, "casts", "cast_virgo_1"), castData(STORE_VIRGO, "seed", false));
    // 既存ルール（update系テスト用）
    await setDoc(doc(db, "nameMatchingRules", `${STORE_VIRGO}__あいり`), ruleData(STORE_VIRGO));
    await setDoc(doc(db, "nameMatchingRules", `${STORE_REGINA}__れいな`), {
      ...ruleData(STORE_REGINA),
      sourceName: "れいな",
      normalizedName: "れいな",
    });
    // 既存インポート履歴（update系テスト用）
    await setDoc(doc(db, "importBatches", "batch_virgo_1"), batchData(STORE_VIRGO, UIDS.adminV));
    await setDoc(doc(db, "importBatches", "batch_regina_1"), batchData(STORE_REGINA, "seed"));
    // 既存移行記録
    await setDoc(doc(db, "migrationRuns", "run1"), migrationRunData(UIDS.owner));
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

// ---------------- migrationRuns ----------------
describe("migrationRuns", () => {
  it("owner: 作成できる（createdBy=本人）", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "migrationRuns", "run2"), migrationRunData(UIDS.owner))
    );
  });

  it("owner: createdBy偽装は拒否", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.owner), "migrationRuns", "run3"), migrationRunData(UIDS.adminV))
    );
  });

  it("admin: 作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "migrationRuns", "run4"), migrationRunData(UIDS.adminV))
    );
  });

  it("viewer: 作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.viewerV), "migrationRuns", "run5"), migrationRunData(UIDS.viewerV))
    );
  });

  it("owner: 読める / admin・viewer・未ログイン: 読めない", async () => {
    await assertSucceeds(getDoc(doc(dbAs(UIDS.owner), "migrationRuns", "run1")));
    await assertFails(getDoc(doc(dbAs(UIDS.adminV), "migrationRuns", "run1")));
    await assertFails(getDoc(doc(dbAs(UIDS.viewerV), "migrationRuns", "run1")));
    await assertFails(getDoc(doc(dbAnon(), "migrationRuns", "run1")));
  });

  it("owner: 完了ステータスへ更新できる（createdBy/startedAt維持）", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.owner), "migrationRuns", "run1"), {
        status: "completed",
        summary: "作成 10 / 更新 0 / スキップ 2 / エラー 0",
        completedAt: new Date(),
      })
    );
  });

  it("owner: createdByの改竄は拒否", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "migrationRuns", "run1"), {
        createdBy: UIDS.adminV,
      })
    );
  });

  it("admin: 更新できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "migrationRuns", "run1"), { status: "completed" })
    );
  });

  it("削除は全員拒否", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "migrationRuns", "run1")));
  });
});

// ---------------- nameMatchingRules ----------------
describe("nameMatchingRules", () => {
  const newRuleId = `${STORE_VIRGO}__ももか`;
  const newRule = (byUid) => ({
    ...ruleData(STORE_VIRGO, byUid),
    sourceName: "ももか",
    normalizedName: "ももか",
  });

  it("owner: 作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "nameMatchingRules", newRuleId), newRule(UIDS.owner))
    );
  });

  it("admin(許可店舗): 作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "nameMatchingRules", newRuleId), newRule(UIDS.adminV))
    );
  });

  it("admin(許可外店舗): 作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "nameMatchingRules", `${STORE_REGINA}__ももか`), {
        ...newRule(UIDS.adminV),
        storeId: STORE_REGINA,
      })
    );
  });

  it("viewer: 作成できない（書き込み一切不可）", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.viewerV), "nameMatchingRules", newRuleId), newRule(UIDS.viewerV))
    );
  });

  it("storeId='__all__' は拒否", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.owner), "nameMatchingRules", "__all____ももか"), {
        ...newRule(UIDS.owner),
        storeId: "__all__",
      })
    );
  });

  it("createdBy偽装は拒否", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "nameMatchingRules", newRuleId), newRule(UIDS.owner))
    );
  });

  it("viewer: 許可店舗のルールは読める / 許可外店舗は読めない", async () => {
    await assertSucceeds(
      getDoc(doc(dbAs(UIDS.viewerV), "nameMatchingRules", `${STORE_VIRGO}__あいり`))
    );
    await assertFails(
      getDoc(doc(dbAs(UIDS.viewerV), "nameMatchingRules", `${STORE_REGINA}__れいな`))
    );
    await assertSucceeds(
      getDocs(
        query(
          collection(dbAs(UIDS.viewerV), "nameMatchingRules"),
          where("storeId", "==", STORE_VIRGO)
        )
      )
    );
  });

  it("admin(許可店舗): 更新できる（updatedBy=本人）", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.adminV), "nameMatchingRules", `${STORE_VIRGO}__あいり`), {
        linkedCastId: "cast_virgo_1",
        hourlyWage: 5500,
        updatedAt: new Date(),
        updatedBy: UIDS.adminV,
      })
    );
  });

  it("更新: updatedByの偽装は拒否", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "nameMatchingRules", `${STORE_VIRGO}__あいり`), {
        hourlyWage: 5500,
        updatedAt: new Date(),
        updatedBy: UIDS.owner,
      })
    );
  });

  it("更新: storeIdの変更は拒否", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "nameMatchingRules", `${STORE_VIRGO}__あいり`), {
        storeId: STORE_REGINA,
        updatedAt: new Date(),
        updatedBy: UIDS.owner,
      })
    );
  });

  it("更新: createdByの改竄は拒否", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "nameMatchingRules", `${STORE_VIRGO}__あいり`), {
        createdBy: UIDS.owner,
        updatedAt: new Date(),
        updatedBy: UIDS.owner,
      })
    );
  });

  it("削除: owner / 許可店舗adminは可（ロールバック用）・viewer / 許可外adminは不可", async () => {
    await assertFails(
      deleteDoc(doc(dbAs(UIDS.viewerV), "nameMatchingRules", `${STORE_VIRGO}__あいり`))
    );
    await assertFails(
      deleteDoc(doc(dbAs(UIDS.adminV), "nameMatchingRules", `${STORE_REGINA}__れいな`))
    );
    await assertSucceeds(
      deleteDoc(doc(dbAs(UIDS.adminV), "nameMatchingRules", `${STORE_VIRGO}__あいり`))
    );
  });

  it("pending / disabled / usersドキュメント不在: 読み書き不可", async () => {
    for (const uid of [UIDS.pending, UIDS.disabled, UIDS.noDoc]) {
      await assertFails(getDoc(doc(dbAs(uid), "nameMatchingRules", `${STORE_VIRGO}__あいり`)));
      await assertFails(
        setDoc(doc(dbAs(uid), "nameMatchingRules", newRuleId), newRule(uid))
      );
    }
  });
});

// ---------------- importBatches ----------------
describe("importBatches", () => {
  it("admin(許可店舗): 作成できる（createdBy=本人）", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_new"), batchData(STORE_VIRGO, UIDS.adminV))
    );
  });

  it("owner: 任意店舗で作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "importBatches", "batch_new2"), batchData(STORE_REGINA, UIDS.owner))
    );
  });

  it("admin(許可外店舗): 作成できない（許可店舗外インポート拒否）", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_bad"), batchData(STORE_REGINA, UIDS.adminV))
    );
  });

  it("viewer: 作成できない（viewerのインポート拒否）", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.viewerV), "importBatches", "batch_bad2"), batchData(STORE_VIRGO, UIDS.viewerV))
    );
  });

  it("createdBy偽装は拒否", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_bad3"), batchData(STORE_VIRGO, UIDS.owner))
    );
  });

  it("storeId='__all__' は拒否", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.owner), "importBatches", "batch_bad4"), batchData("__all__", UIDS.owner))
    );
  });

  it("admin(許可店舗): 完了時の件数更新ができる", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_virgo_1"), {
        status: "completed",
        createdCount: 8,
        updatedCount: 1,
        skippedCount: 1,
        errorCount: 0,
        summary: "作成 8 / 上書き 1 / スキップ 1 / エラー 0",
        completedAt: new Date(),
      })
    );
  });

  it("更新: storeIdの不正変更は拒否", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_virgo_1"), {
        storeId: STORE_REGINA,
      })
    );
  });

  it("更新: createdByの改竄は拒否", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_virgo_1"), {
        createdBy: UIDS.owner,
      })
    );
  });

  it("admin(許可外店舗): 他店舗の履歴は読めない・更新できない", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_regina_1")));
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_regina_1"), { status: "completed" })
    );
  });

  it("ロールバック結果を書き込める（rollbackBy=本人）", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_virgo_1"), {
        rollbackStatus: "completed",
        rollbackAt: new Date(),
        rollbackBy: UIDS.adminV,
        rollbackSummary: "取り消し 5 / 戻せない 0 / エラー 0",
      })
    );
  });

  it("rollbackByの偽装は拒否", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "importBatches", "batch_virgo_1"), {
        rollbackStatus: "completed",
        rollbackBy: UIDS.owner,
      })
    );
  });

  it("削除は全員拒否", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "importBatches", "batch_virgo_1")));
  });
});

// ---------------- ロールバック: casts / wageHistory の削除制限 ----------------
describe("ロールバック: 削除制限", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // インポートが作成したキャスト（importBatchId付き）
      await setDoc(doc(db, "casts", "cast_import_virgo"), {
        ...castData(STORE_VIRGO, UIDS.adminV, false),
        importBatchId: "batch_virgo_1",
      });
      await setDoc(doc(db, "casts", "cast_import_regina"), {
        ...castData(STORE_REGINA, "seed", false),
        importBatchId: "batch_regina_1",
      });
      // インポートが追加した時給履歴（source: excel-import）と手動の履歴
      await setDoc(doc(db, "wageHistory", "wh_import"), {
        castId: "cast_virgo_1", storeId: STORE_VIRGO,
        oldHourlyWage: 5000, newHourlyWage: 5500, effectiveMonth: "2026-07",
        reason: "Excelインポートによる時給変更", source: "excel-import",
        createdAt: new Date(), createdBy: UIDS.adminV,
      });
      await setDoc(doc(db, "wageHistory", "wh_manual"), {
        castId: "cast_virgo_1", storeId: STORE_VIRGO,
        oldHourlyWage: 4500, newHourlyWage: 5000, effectiveMonth: "2026-06",
        reason: "昇給", createdAt: new Date(), createdBy: "seed",
      });
    });
  });

  it("casts: インポート作成キャスト（importBatchId付き）は許可店舗adminが削除できる", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_import_virgo")));
  });

  it("casts: 手動作成キャスト（importBatchIdなし）はadminでは削除できないがownerは削除できる（PR5完全削除。詳細はpr5.rules.test.mjs）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_virgo_1")));
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.owner), "casts", "cast_virgo_1")));
  });

  it("casts: 許可外店舗のインポート作成キャストは削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_import_regina")));
  });

  it("casts: viewerは削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.viewerV), "casts", "cast_import_virgo")));
  });

  it("wageHistory: source: excel-import は許可店舗adminが削除できる", async () => {
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_import")));
  });

  it("wageHistory: 手動の履歴（sourceなし）はadminでは削除できないがownerは削除できる（PR5完全削除。詳細はpr5.rules.test.mjs）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_manual")));
    await assertSucceeds(deleteDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_manual")));
  });

  it("wageHistory: viewerは削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.viewerV), "wageHistory", "wh_import")));
  });
});

// ---------------- casts: archived作成（移行用） ----------------
describe("casts: archived:true での作成", () => {
  it("owner: archived:true で作成できる（旧データ移行）", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "casts", "cast_archived_1"), castData(STORE_VIRGO, UIDS.owner, true))
    );
  });

  it("admin: archived:true では作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "casts", "cast_archived_2"), castData(STORE_VIRGO, UIDS.adminV, true))
    );
  });

  it("admin: archived:false では従来どおり作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "casts", "cast_normal_1"), castData(STORE_VIRGO, UIDS.adminV, false))
    );
  });
});

// ---------------- monthlyResults: インポート形（batchId付き） ----------------
describe("monthlyResults: インポートによる作成", () => {
  const mrData = (storeId, byUid, batchId) => ({
    castId: "cast_virgo_1",
    storeId,
    month: "2026-07",
    totalSales: 1000000,
    payment: 500000,
    honshimeiCount: 10,
    honshimeiGroupCount: 5,
    customerCount: 20,
    jounaiCount: 8,
    douhan: 3,
    workDays: 15,
    workHours: 70,
    absent: 0,
    notes: "",
    batchId,
    createdAt: new Date(),
    createdBy: byUid,
    updatedAt: new Date(),
    updatedBy: byUid,
  });

  it("admin(許可店舗): batchId付きで作成できる", async () => {
    await assertSucceeds(
      setDoc(
        doc(dbAs(UIDS.adminV), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-07`),
        mrData(STORE_VIRGO, UIDS.adminV, "batch_virgo_1")
      )
    );
  });

  it("admin(許可外店舗): 作成できない（許可店舗外インポート拒否）", async () => {
    await assertFails(
      setDoc(
        doc(dbAs(UIDS.adminV), "monthlyResults", `${STORE_REGINA}_cast_x_2026-07`),
        { ...mrData(STORE_REGINA, UIDS.adminV, null), castId: "cast_x" }
      )
    );
  });

  it("viewer: 作成できない（viewerのインポート拒否）", async () => {
    await assertFails(
      setDoc(
        doc(dbAs(UIDS.viewerV), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-08`),
        mrData(STORE_VIRGO, UIDS.viewerV, null)
      )
    );
  });
});

// ---------------- wageHistory: excel-import ----------------
describe("wageHistory: source: excel-import", () => {
  const whData = (storeId, byUid) => ({
    castId: "cast_virgo_1",
    storeId,
    oldHourlyWage: 5000,
    newHourlyWage: 5500,
    effectiveMonth: "2026-07",
    reason: "Excelインポートによる時給変更",
    source: "excel-import",
    createdAt: new Date(),
    createdBy: byUid,
  });

  it("admin(許可店舗): 追記できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_1"), whData(STORE_VIRGO, UIDS.adminV))
    );
  });

  it("admin(許可外店舗): 追記できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh_2"), whData(STORE_REGINA, UIDS.adminV))
    );
  });

  it("viewer: 追記できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.viewerV), "wageHistory", "wh_3"), whData(STORE_VIRGO, UIDS.viewerV))
    );
  });

  it("更新は不可（追記のみ。削除の制限は「ロールバック: 削除制限」で検証）", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "wageHistory", "wh_seed"), whData(STORE_VIRGO, "seed"));
    });
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_seed"), { newHourlyWage: 9999 })
    );
  });
});

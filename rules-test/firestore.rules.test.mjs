/**
 * Firestore Security Rules テスト
 *
 * 実行方法（Firebaseエミュレータ必須）:
 *   cd rules-test && npm install
 *   npm test          # firebase emulators:exec 経由で実行
 *
 * カバーするケース:
 *  - 未ログイン: 全データ読み書き不可
 *  - pending: 業務データ読み書き不可 / 自分のusersドキュメントは読める
 *  - disabled: 業務データ読み書き不可
 *  - usersドキュメント不在の認証ユーザー: 業務データ読み書き不可
 *  - viewer(approved): 読み取り可 / 書き込み不可
 *  - admin(approved): アクセス可能店舗のみ読み書き可 / 他店舗不可
 *  - owner: 全店舗read/write可、users管理可
 *  - 自分のroleを自分で変更 → 拒否
 *  - 自分のstatusを自分で変更 → 拒否
 *  - 新規登録でrole/statusを偽装(admin/approved) → 拒否
 *  - storeId='__all__' での業務データ作成 → 拒否
 *  - update時のstoreId変更（店舗移動の偽装） → 拒否
 *  - auditLogsの更新・削除 → 拒否
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('@firebase/rules-unit-testing').RulesTestEnvironment} */
let env;

const PROJECT_ID = "cast-manager-rules-test";

// テストユーザー定義
const UIDS = {
  owner: "uid-owner",
  adminV: "uid-admin-virgo", // VIRGOのみアクセス可のadmin
  viewerV: "uid-viewer-virgo", // VIRGOのみアクセス可のviewer
  pending: "uid-pending",
  disabled: "uid-disabled",
  noDoc: "uid-no-userdoc", // Authにはいるがusersドキュメントなし
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

function castData(storeId, byUid = "seed") {
  return {
    storeId,
    stageName: "テストキャスト",
    realName: "",
    hourlyWage: 5000,
    rank: "A",
    status: "在籍",
    archived: false,
    createdAt: new Date(),
    createdBy: byUid,
    updatedAt: new Date(),
    updatedBy: byUid,
  };
}

function storeData(byUid = "seed") {
  return {
    name: "新店舗", code: "newstore", color: "#123456", active: true, order: 9,
    createdAt: new Date(), createdBy: byUid,
    updatedAt: new Date(), updatedBy: byUid,
  };
}

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // users
    await setDoc(doc(db, "users", UIDS.owner), userDocData("owner", "approved", []));
    await setDoc(doc(db, "users", UIDS.adminV), userDocData("admin", "approved", [STORE_VIRGO]));
    await setDoc(doc(db, "users", UIDS.viewerV), userDocData("viewer", "approved", [STORE_VIRGO]));
    await setDoc(doc(db, "users", UIDS.pending), userDocData("viewer", "pending", []));
    await setDoc(doc(db, "users", UIDS.disabled), userDocData("viewer", "disabled", []));
    // stores
    await setDoc(doc(db, "stores", STORE_VIRGO), { name: "VIRGO", code: "virgo", color: "#9c27b0", active: true, order: 0, createdAt: new Date(), createdBy: "seed", updatedAt: new Date(), updatedBy: "seed" });
    await setDoc(doc(db, "stores", STORE_REGINA), { name: "REGINA", code: "regina", color: "#e91e63", active: true, order: 1, createdAt: new Date(), createdBy: "seed", updatedAt: new Date(), updatedBy: "seed" });
    // casts
    await setDoc(doc(db, "casts", "cast_virgo_1"), castData(STORE_VIRGO));
    await setDoc(doc(db, "casts", "cast_regina_1"), castData(STORE_REGINA));
    // monthlyResults
    await setDoc(doc(db, "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-06`), {
      castId: "cast_virgo_1", storeId: STORE_VIRGO, month: "2026-06",
      totalSales: 1000000, payment: 500000, honshimeiCount: 10,
      honshimeiGroupCount: 5, customerCount: 20, jounaiCount: 8, douhan: 3,
      workDays: 15, workHours: 70, absent: 0, notes: "", batchId: null,
      createdAt: new Date(), createdBy: "seed",
      updatedAt: new Date(), updatedBy: "seed",
    });
    // interviews（PR3.5編集テスト用）
    await setDoc(doc(db, "interviews", "iv_seed"), {
      castId: "cast_virgo_1", storeId: STORE_VIRGO, date: "2026-06-01",
      type: "face-to-face", importance: "通常", follow: "中",
      interviewer: "店長", nextDate: "", content: "定期面談",
      worries: "", decisions: "", nextTask: "",
      createdAt: new Date(), createdBy: "seed",
      updatedAt: new Date(), updatedBy: "seed",
    });
    await setDoc(doc(db, "interviews", "iv_seed_regina"), {
      castId: "cast_regina_1", storeId: STORE_REGINA, date: "2026-06-01",
      type: "face-to-face", importance: "通常", follow: "低",
      interviewer: "店長", nextDate: "", content: "定期面談",
      worries: "", decisions: "", nextTask: "",
      createdAt: new Date(), createdBy: "seed",
      updatedAt: new Date(), updatedBy: "seed",
    });
    // auditLogs
    await setDoc(doc(db, "auditLogs", "log1"), {
      userId: UIDS.adminV, userName: "admin", action: "create",
      collection: "casts", documentId: "cast_virgo_1",
      storeId: STORE_VIRGO, before: null, after: {}, createdAt: new Date(),
    });
  });
}

function dbAs(uid) {
  return env.authenticatedContext(uid, uid ? { email: `${uid}@example.com` } : undefined).firestore();
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

// =====================================================================
describe("未ログイン", () => {
  it("業務データを読めない", async () => {
    await assertFails(getDoc(doc(dbAnon(), "casts", "cast_virgo_1")));
  });
  it("業務データへ書き込めない", async () => {
    await assertFails(setDoc(doc(dbAnon(), "casts", "x"), castData(STORE_VIRGO)));
  });
  it("usersを読めない", async () => {
    await assertFails(getDoc(doc(dbAnon(), "users", UIDS.owner)));
  });
});

describe("pendingユーザー", () => {
  it("業務データを読めない", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.pending), "casts", "cast_virgo_1")));
  });
  it("業務データへ書き込めない", async () => {
    await assertFails(setDoc(doc(dbAs(UIDS.pending), "casts", "x"), castData(STORE_VIRGO)));
  });
  it("店舗マスターも読めない", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.pending), "stores", STORE_VIRGO)));
  });
  it("自分のusersドキュメントは読める（承認待ち画面表示のため）", async () => {
    await assertSucceeds(getDoc(doc(dbAs(UIDS.pending), "users", UIDS.pending)));
  });
});

describe("disabledユーザー", () => {
  it("業務データを読めない", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.disabled), "casts", "cast_virgo_1")));
  });
  it("業務データへ書き込めない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.disabled), "casts", "cast_virgo_1"), { stageName: "改竄" })
    );
  });
});

describe("usersドキュメントが存在しない認証ユーザー", () => {
  it("業務データを読めない（承認扱いにならない）", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.noDoc), "casts", "cast_virgo_1")));
  });
  it("業務データへ書き込めない", async () => {
    await assertFails(setDoc(doc(dbAs(UIDS.noDoc), "casts", "x"), castData(STORE_VIRGO)));
  });
});

describe("viewer（承認済み・VIRGOのみ）", () => {
  it("アクセス可能店舗のキャストを読める", async () => {
    await assertSucceeds(getDoc(doc(dbAs(UIDS.viewerV), "casts", "cast_virgo_1")));
  });
  it("アクセス外店舗（REGINA）のキャストは読めない", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.viewerV), "casts", "cast_regina_1")));
  });
  it("書き込みはできない（読み取り専用）", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.viewerV), "casts", "cast_virgo_1"), { stageName: "変更" })
    );
  });
  it("キャストの新規作成もできない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.viewerV), "casts", "new1"), castData(STORE_VIRGO, UIDS.viewerV))
    );
  });
});

describe("admin（承認済み・VIRGOのみ）", () => {
  it("アクセス可能店舗のキャストを作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "casts", "new_v"), castData(STORE_VIRGO, UIDS.adminV))
    );
  });
  it("アクセス可能店舗のキャストを更新できる", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.adminV), "casts", "cast_virgo_1"), {
        stageName: "更新",
        updatedBy: UIDS.adminV,
      })
    );
  });
  it("アクセス外店舗（REGINA）のキャストは読めない", async () => {
    await assertFails(getDoc(doc(dbAs(UIDS.adminV), "casts", "cast_regina_1")));
  });
  it("アクセス外店舗（REGINA）へは作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "casts", "new_r"), castData(STORE_REGINA, UIDS.adminV))
    );
  });
  it("storeId='__all__' では作成できない（過去不具合の再発防止）", async () => {
    // '__all__' は accessibleStoreIds に含まれないため二重に拒否される
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "casts", "new_all"), castData("__all__", UIDS.adminV))
    );
  });
  it("update で storeId を書き換えられない（店舗移動の偽装防止）", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "casts", "cast_virgo_1"), {
        storeId: STORE_REGINA,
        updatedBy: UIDS.adminV,
      })
    );
  });
  it("usersの一覧は読めない（owner専用）", async () => {
    await assertFails(getDocs(collection(dbAs(UIDS.adminV), "users")));
  });
});

describe("owner", () => {
  it("全店舗のキャストを読める", async () => {
    await assertSucceeds(getDoc(doc(dbAs(UIDS.owner), "casts", "cast_virgo_1")));
    await assertSucceeds(getDoc(doc(dbAs(UIDS.owner), "casts", "cast_regina_1")));
  });
  it("全店舗へ書き込める", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "casts", "o_v"), castData(STORE_VIRGO, UIDS.owner))
    );
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "casts", "o_r"), castData(STORE_REGINA, UIDS.owner))
    );
  });
  it("users一覧を読める", async () => {
    await assertSucceeds(getDocs(collection(dbAs(UIDS.owner), "users")));
  });
  it("他ユーザーを承認できる（status変更）", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.pending), {
        status: "approved",
        approvedAt: new Date(),
        approvedBy: UIDS.owner,
        disabledAt: null,
        updatedAt: new Date(),
      })
    );
  });
  it("他ユーザーの権限を変更できる", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.viewerV), {
        role: "admin",
        updatedAt: new Date(),
      })
    );
  });
  it("店舗マスターを作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "stores", "store_new"), storeData(UIDS.owner))
    );
  });
});

describe("権限昇格の防止", () => {
  it("自分のroleを自分で変更できない（owner自身でも）", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "users", UIDS.owner), {
        role: "viewer",
        updatedAt: new Date(),
      })
    );
  });
  it("viewerが自分のroleをadminへ昇格できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.viewerV), "users", UIDS.viewerV), {
        role: "admin",
        updatedAt: new Date(),
      })
    );
  });
  it("pendingが自分のstatusをapprovedへ変更できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.pending), "users", UIDS.pending), {
        status: "approved",
        updatedAt: new Date(),
      })
    );
  });
  it("本人はdisplayNameのみ更新できる", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.viewerV), "users", UIDS.viewerV), {
        displayName: "新しい名前",
        updatedAt: new Date(),
      })
    );
  });
  it("新規登録でrole=adminを指定できない", async () => {
    const uid = "uid-new-fake-admin";
    const d = userDocData("admin", "pending", []);
    await assertFails(setDoc(doc(dbAs(uid), "users", uid), d));
  });
  it("新規登録でstatus=approvedを指定できない", async () => {
    const uid = "uid-new-fake-approved";
    const d = userDocData("viewer", "approved", []);
    await assertFails(setDoc(doc(dbAs(uid), "users", uid), d));
  });
  it("正しい新規登録（viewer/pending/店舗空）は成功する", async () => {
    const uid = "uid-new-ok";
    const d = userDocData("viewer", "pending", []);
    d.approvedAt = null;
    d.approvedBy = null;
    d.disabledAt = null;
    await assertSucceeds(setDoc(doc(dbAs(uid), "users", uid), d));
  });
  it("他人のusersドキュメントを作成できない", async () => {
    const d = userDocData("viewer", "pending", []);
    await assertFails(setDoc(doc(dbAs("uid-attacker"), "users", "uid-victim"), d));
  });
  it("usersドキュメントを削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "users", UIDS.viewerV)));
  });
});

function mrData(storeId, castId, month, byUid) {
  return {
    castId, storeId, month,
    totalSales: 500000, payment: 300000, honshimeiCount: 5,
    honshimeiGroupCount: 2, customerCount: 10, jounaiCount: 3, douhan: 1,
    workDays: 10, workHours: 45, absent: 0, notes: "", batchId: null,
    createdAt: new Date(), createdBy: byUid,
    updatedAt: new Date(), updatedBy: byUid,
  };
}

describe("PR3: 月別成績", () => {
  it("adminは許可店舗の成績を作成できる", async () => {
    await assertSucceeds(
      setDoc(
        doc(dbAs(UIDS.adminV), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-07`),
        mrData(STORE_VIRGO, "cast_virgo_1", "2026-07", UIDS.adminV)
      )
    );
  });
  it("adminはアクセス外店舗の成績を作成できない", async () => {
    await assertFails(
      setDoc(
        doc(dbAs(UIDS.adminV), "monthlyResults", `${STORE_REGINA}_cast_regina_1_2026-07`),
        mrData(STORE_REGINA, "cast_regina_1", "2026-07", UIDS.adminV)
      )
    );
  });
  it("viewerは成績を読める", async () => {
    await assertSucceeds(
      getDoc(doc(dbAs(UIDS.viewerV), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-06`))
    );
  });
  it("viewerは成績を作成できない", async () => {
    await assertFails(
      setDoc(
        doc(dbAs(UIDS.viewerV), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-08`),
        mrData(STORE_VIRGO, "cast_virgo_1", "2026-08", UIDS.viewerV)
      )
    );
  });
  it("update で castId / month を書き換えられない", async () => {
    await assertFails(
      updateDoc(
        doc(dbAs(UIDS.adminV), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-06`),
        { month: "2026-01", updatedBy: UIDS.adminV }
      )
    );
  });
  it("adminは許可店舗の成績を削除できる（既存版と同じ）", async () => {
    await assertSucceeds(
      deleteDoc(doc(dbAs(UIDS.adminV), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-06`))
    );
  });
  it("pendingは成績を読めない", async () => {
    await assertFails(
      getDoc(doc(dbAs(UIDS.pending), "monthlyResults", `${STORE_VIRGO}_cast_virgo_1_2026-06`))
    );
  });
});

describe("PR3: 面談・目標・モチベーション・時給履歴", () => {
  function ivData(byUid) {
    return {
      castId: "cast_virgo_1", storeId: STORE_VIRGO, date: "2026-07-01",
      type: "face-to-face", importance: "通常", follow: "中",
      interviewer: "店長", nextDate: "", content: "面談内容",
      worries: "", decisions: "", nextTask: "",
      createdAt: new Date(), createdBy: byUid,
      updatedAt: new Date(), updatedBy: byUid,
    };
  }
  it("adminは面談を作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "interviews", "iv1"), ivData(UIDS.adminV))
    );
  });
  it("createdBy偽装の面談は作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "interviews", "iv2"), ivData(UIDS.owner))
    );
  });
  it("adminはモチベーションを作成できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "motivations", "mo1"), {
        castId: "cast_virgo_1", storeId: STORE_VIRGO, date: "2026-07-01",
        level: "3:普通", followNeed: "", followDate: "", state: "",
        danger: "", follow: "", growth: "",
        createdAt: new Date(), createdBy: UIDS.adminV,
        updatedAt: new Date(), updatedBy: UIDS.adminV,
      })
    );
  });
  it("adminは時給履歴を追記できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "wageHistory", "wh1"), {
        castId: "cast_virgo_1", storeId: STORE_VIRGO,
        oldHourlyWage: 5000, newHourlyWage: 6000,
        effectiveMonth: "2026-07", reason: "昇給",
        createdAt: new Date(), createdBy: UIDS.adminV,
      })
    );
  });
  it("時給履歴は更新できない（追記のみ）", async () => {
    // seedがないため先にownerで作成
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_upd"), {
        castId: "cast_virgo_1", storeId: STORE_VIRGO,
        oldHourlyWage: 5000, newHourlyWage: 6000,
        effectiveMonth: "2026-07", reason: "",
        createdAt: new Date(), createdBy: UIDS.owner,
      })
    );
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "wageHistory", "wh_upd"), { newHourlyWage: 99999 })
    );
  });
  it("viewerは面談を作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.viewerV), "interviews", "iv3"), ivData(UIDS.viewerV))
    );
  });
});

describe("PR2: createdBy/updatedBy偽装の防止", () => {
  it("createdByを他人のuidにしてキャストを作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "casts", "fake_creator"), castData(STORE_VIRGO, UIDS.owner))
    );
  });
  it("update時にupdatedByを他人のuidへ偽装できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "casts", "cast_virgo_1"), {
        stageName: "更新",
        updatedBy: UIDS.owner,
      })
    );
  });
  it("update時にupdatedByを設定しない更新は拒否される", async () => {
    // updatedByが既存値("seed")のまま = 本人uidでないため拒否
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "casts", "cast_virgo_1"), { stageName: "更新のみ" })
    );
  });
  it("update時にcreatedByを書き換えられない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "casts", "cast_virgo_1"), {
        createdBy: UIDS.adminV,
        updatedBy: UIDS.adminV,
      })
    );
  });
});

describe("PR2: 店舗マスターの保護", () => {
  it("adminは店舗を作成できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "stores", "hack_store"), storeData(UIDS.adminV))
    );
  });
  it("adminは店舗を更新できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "stores", STORE_VIRGO), {
        name: "改竄", updatedBy: UIDS.adminV,
      })
    );
  });
  it("viewerは店舗を更新できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.viewerV), "stores", STORE_VIRGO), {
        name: "改竄", updatedBy: UIDS.viewerV,
      })
    );
  });
  it("viewerは店舗一覧を読める（店舗切替UIのため）", async () => {
    await assertSucceeds(getDoc(doc(dbAs(UIDS.viewerV), "stores", STORE_VIRGO)));
  });
  it("ownerでも店舗を削除できない（無効化で扱う）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "stores", STORE_VIRGO)));
  });
  it("ownerが店舗を更新するときcreatedByを書き換えられない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.owner), "stores", STORE_VIRGO), {
        name: "更新", createdBy: UIDS.owner, updatedBy: UIDS.owner,
      })
    );
  });
});

describe("PR2: キャスト完全削除の禁止", () => {
  it("adminはキャストを削除できない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.adminV), "casts", "cast_virgo_1")));
  });
  it("ownerでもキャストを削除できない（完全削除はPR5で実装）", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "casts", "cast_virgo_1")));
  });
});

describe("PR3.5: 面談編集の保護", () => {
  it("adminは許可店舗の面談を編集できる", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(UIDS.adminV), "interviews", "iv_seed"), {
        content: "更新した面談内容",
        updatedBy: UIDS.adminV,
      })
    );
  });
  it("viewerは面談を編集できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.viewerV), "interviews", "iv_seed"), {
        content: "改竄",
        updatedBy: UIDS.viewerV,
      })
    );
  });
  it("adminは許可店舗外の面談を編集できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "interviews", "iv_seed_regina"), {
        content: "改竄",
        updatedBy: UIDS.adminV,
      })
    );
  });
  it("面談のcastIdを書き換えられない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "interviews", "iv_seed"), {
        castId: "cast_regina_1",
        updatedBy: UIDS.adminV,
      })
    );
  });
  it("面談のcreatedByを書き換えられない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "interviews", "iv_seed"), {
        createdBy: UIDS.adminV,
        updatedBy: UIDS.adminV,
      })
    );
  });
  it("面談のupdatedByを他人uidへ偽装できない", async () => {
    await assertFails(
      updateDoc(doc(dbAs(UIDS.adminV), "interviews", "iv_seed"), {
        content: "更新",
        updatedBy: UIDS.owner,
      })
    );
  });
});

describe("auditLogs", () => {
  it("承認済みユーザーは自分のログを追記できる", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(UIDS.adminV), "auditLogs", "log_new"), {
        userId: UIDS.adminV, userName: "admin", action: "update",
        collection: "casts", documentId: "cast_virgo_1",
        storeId: STORE_VIRGO, before: {}, after: {}, createdAt: new Date(),
      })
    );
  });
  it("他人のuserIdを騙ったログは追記できない", async () => {
    await assertFails(
      setDoc(doc(dbAs(UIDS.adminV), "auditLogs", "log_fake"), {
        userId: UIDS.owner, userName: "owner", action: "update",
        collection: "casts", documentId: "x",
        storeId: STORE_VIRGO, before: null, after: null, createdAt: new Date(),
      })
    );
  });
  it("ログの更新は誰にもできない", async () => {
    await assertFails(updateDoc(doc(dbAs(UIDS.owner), "auditLogs", "log1"), { action: "改竄" }));
  });
  it("ログの削除は誰にもできない", async () => {
    await assertFails(deleteDoc(doc(dbAs(UIDS.owner), "auditLogs", "log1")));
  });
});

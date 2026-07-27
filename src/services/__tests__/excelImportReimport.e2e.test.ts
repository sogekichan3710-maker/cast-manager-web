import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchExcelRows, type MatchableCast } from "@/lib/excel/importMatching";
import { buildInitialRowStates } from "@/lib/excel/importPlan";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";

/**
 * 「同じ年月のExcelを再インポートしても売上が更新されない」不具合の
 * 実データ追跡テスト（推測ではなく実際にコードを動かして検証する）。
 *
 * Excel読込→importPlan→executeExcelImport→Firestore保存→画面再取得
 * までを、本物のfirebase/firestoreの代わりに軽量なインメモリFirestore
 * フェイクを通して最後まで動かし、各段階の値を検証する。
 *
 * フェイクの方針: `firebase/firestore` の関数（doc/collection/query/
 * runTransaction/getDoc/getDocs/setDoc/updateDoc/writeBatch等）を
 * インメモリMapベースの実装に差し替える。ロジック自体は本物の
 * executeExcelImport / fetchMonthlyResultsByStoreMonth をそのまま使う。
 */

const { store, resetStore } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    resetStore: () => store.clear(),
  };
});

vi.mock("@/lib/firebase", () => ({
  getDb: () => ({}) as unknown,
}));

vi.mock("firebase/firestore", () => {
  type Filter = { field: string; op: "==" | "in"; value: unknown };

  class DocRef {
    constructor(
      public collectionPath: string,
      public id: string
    ) {}
  }
  class CollectionRef {
    constructor(public path: string) {}
  }
  class QueryRef {
    constructor(
      public collectionPath: string,
      public filters: Filter[]
    ) {}
  }

  const SERVER_TS = { __serverTimestamp: true };
  let autoId = 0;

  function key(collectionPath: string, id: string) {
    return `${collectionPath}/${id}`;
  }
  function splitKey(k: string): [string, string] {
    const idx = k.lastIndexOf("/");
    return [k.slice(0, idx), k.slice(idx + 1)];
  }
  function resolveTimestamps(data: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = v === SERVER_TS ? { __serverTimestamp: true, toMillis: () => Date.now() } : v;
    }
    return out;
  }

  function collection(_db: unknown, path: string) {
    return new CollectionRef(path);
  }
  function doc(...args: unknown[]): DocRef {
    if (args.length === 1) {
      const c = args[0] as CollectionRef;
      return new DocRef(c.path, `auto${++autoId}`);
    }
    const collectionPath = args[1] as string;
    const id = args[2] as string;
    return new DocRef(collectionPath, id);
  }
  function where(field: string, op: "==" | "in", value: unknown): Filter {
    return { field, op, value };
  }
  function query(collectionRef: CollectionRef, ...filters: Filter[]): QueryRef {
    return new QueryRef(collectionRef.path, filters);
  }
  function orderBy() {
    return { __type: "orderBy" };
  }
  function limit() {
    return { __type: "limit" };
  }
  function matchesFilters(data: Record<string, unknown>, filters: Filter[]) {
    return filters.every((f) => {
      if (f.op === "==") return data[f.field] === f.value;
      if (f.op === "in") return Array.isArray(f.value) && f.value.includes(data[f.field]);
      return true;
    });
  }
  function docSnapFrom(ref: DocRef) {
    const data = store.get(key(ref.collectionPath, ref.id));
    return {
      id: ref.id,
      exists: () => data !== undefined,
      data: () => (data ? { ...data } : undefined),
    };
  }
  async function getDoc(ref: DocRef) {
    return docSnapFrom(ref);
  }
  async function getDocs(q: QueryRef) {
    const docs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
    for (const [k, data] of store.entries()) {
      const [collectionPath, id] = splitKey(k);
      if (collectionPath !== q.collectionPath) continue;
      if (!matchesFilters(data, q.filters)) continue;
      docs.push({ id, data: () => ({ ...data }) });
    }
    return { docs };
  }
  function serverTimestamp() {
    return SERVER_TS;
  }
  async function setDoc(ref: DocRef, data: Record<string, unknown>) {
    store.set(key(ref.collectionPath, ref.id), resolveTimestamps(data));
  }
  async function updateDoc(ref: DocRef, data: Record<string, unknown>) {
    const k = key(ref.collectionPath, ref.id);
    const cur = store.get(k) ?? {};
    store.set(k, { ...cur, ...resolveTimestamps(data) });
  }
  function writeBatch() {
    const ops: Array<() => void> = [];
    return {
      set(ref: DocRef, data: Record<string, unknown>) {
        ops.push(() => store.set(key(ref.collectionPath, ref.id), resolveTimestamps(data)));
      },
      async commit() {
        for (const op of ops) op();
      },
    };
  }
  async function runTransaction<T>(_db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      get: async (ref: DocRef) => docSnapFrom(ref),
      set: (ref: DocRef, data: Record<string, unknown>) => {
        store.set(key(ref.collectionPath, ref.id), resolveTimestamps(data));
      },
      update: (ref: DocRef, data: Record<string, unknown>) => {
        const k = key(ref.collectionPath, ref.id);
        const cur = store.get(k) ?? {};
        store.set(k, { ...cur, ...resolveTimestamps(data) });
      },
      delete: (ref: DocRef) => {
        store.delete(key(ref.collectionPath, ref.id));
      },
    };
    return fn(tx);
  }
  function onSnapshot() {
    return () => {};
  }
  const Timestamp = {
    fromDate: (d: Date) => ({ toMillis: () => d.getTime(), toDate: () => d }),
  };

  return {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    orderBy,
    limit,
    serverTimestamp,
    setDoc,
    updateDoc,
    writeBatch,
    runTransaction,
    onSnapshot,
    Timestamp,
  };
});

function row(overrides: Partial<ExcelMonthlyRow> = {}): ExcelMonthlyRow {
  return {
    rowNumber: 2,
    name: "あいり",
    hourlyWage: 5000,
    scoutedBy: "",
    totalSales: 1000000,
    payment: 400000,
    honshimeiCount: 5,
    honshimeiGroupCount: 2,
    customerCount: 8,
    jounaiCount: 1,
    douhan: 0,
    workDays: 10,
    workHours: 50,
    absent: 0,
    notes: "",
    ...overrides,
  };
}

function cast(partial: Partial<MatchableCast> = {}): MatchableCast {
  return {
    id: "c1",
    storeId: "virgo",
    stageName: "あいり",
    realName: "",
    kana: "",
    hourlyWage: 5000,
    status: "在籍",
    archived: false,
    scoutedBy: "",
    ...partial,
  };
}

describe("同一年月のExcel再インポート（実データ追跡: Excel読込→importPlan→executeExcelImport→Firestore保存→画面再取得）", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("既存の月別成績を新しいExcel値で完全に上書き更新し、画面側の再取得でも新しい値が読める", async () => {
    const { executeExcelImport } = await import("@/services/excelImportService");
    const { fetchMonthlyResultsByStoreMonth } = await import("@/services/monthlyResultService");

    // ---- 事前状態: 7月分の既存Firestoreドキュメント（旧い売上） ----
    store.set("monthlyResults/virgo_c1_2026-07", {
      castId: "c1",
      storeId: "virgo",
      month: "2026-07",
      totalSales: 1000000, // 旧い売上（1回目インポート時の値）
      payment: 400000,
      honshimeiCount: 5,
      honshimeiGroupCount: 2,
      customerCount: 8,
      jounaiCount: 1,
      douhan: 0,
      workDays: 10,
      workHours: 50,
      absent: 0,
      notes: "",
      batchId: "prev-batch",
      targetDate: null,
      lastImportAt: { toMillis: () => 1 },
      lastImportBatchId: "prev-batch",
      createdAt: { toMillis: () => 1 },
      createdBy: "u0",
      updatedAt: { toMillis: () => 1 },
      updatedBy: "u0",
    });

    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // ---- 1. Excel読込（今回の再インポート分。売上が増えている） ----
    const excelRows = [row({ totalSales: 1800000, payment: 650000, honshimeiCount: 9 })];

    // ---- 2. importPlan（画面の照合確認と同じ関数を使う） ----
    const existing = await fetchMonthlyResultsByStoreMonth("virgo", "2026-07");
    expect(existing).toHaveLength(1);
    expect(existing[0].totalSales).toBe(1000000); // 再取得した既存Firestoreの売上

    const existingCastIds = new Set(existing.map((m) => m.castId));
    const { matches } = matchExcelRows(excelRows, "virgo", [cast()], []);
    const rowStates = buildInitialRowStates(matches, existingCastIds);

    expect(rowStates[0].action).toBe("link"); // 完全一致・時給同一で自動確定
    expect(rowStates[0].existing).toBe("overwrite"); // 修正後の既定値（重要: ここがskipなら再現する不具合そのもの）

    // src/app/import/page.tsx の onExecute と同じ変換
    const decisions = rowStates.map((r) => ({
      row: r.match.row,
      action: r.action!,
      castId: r.action === "new" ? null : r.castId,
      newWage: r.action === "wage-change" ? r.match.row.hourlyWage : null,
      existing: r.existing,
      saveRule: false,
    }));

    // ---- 3. executeExcelImport ----
    const result = await executeExcelImport(
      "actor-uid",
      "Actor Name",
      {
        storeId: "virgo",
        targetMonth: "2026-07",
        targetDate: null,
        fileName: "test.xlsx",
        decisions,
        statusDecisions: [],
      },
      () => {},
      () => false
    );

    expect(result.errors).toBe(0);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1); // スキップではなく上書き更新されたこと
    expect(result.skipped).toBe(0);

    // ---- 4. Firestore保存後の状態 ----
    const saved = store.get("monthlyResults/virgo_c1_2026-07");
    expect(saved?.totalSales).toBe(1800000); // 新しいExcel値で上書きされている
    expect(saved?.payment).toBe(650000);
    expect(saved?.honshimeiCount).toBe(9);

    // ---- 5. 画面再取得（表示側と同じ fetchMonthlyResultsByStoreMonth を再実行） ----
    const refetched = await fetchMonthlyResultsByStoreMonth("virgo", "2026-07");
    expect(refetched).toHaveLength(1);
    expect(refetched[0].totalSales).toBe(1800000); // 画面側でも新しい値が見える

    // ---- トレースログ（1件分の値の流れがログに出ていること） ----
    const traceCall = consoleSpy.mock.calls.find(
      (args) => args[0] === "[excelImport:monthlyResults]"
    );
    expect(traceCall).toBeDefined();
    const trace = traceCall![1] as Record<string, unknown>;
    expect(trace.existingDecision).toBe("overwrite");
    expect(trace.excelTotalSales).toBe(1800000);
    expect(trace.beforeTotalSales).toBe(1000000);
    expect(trace.payloadTotalSales).toBe(1800000);
    expect(trace.afterTotalSales).toBe(1800000);
    expect(trace.outcome).toBe("updated");
  });

  it("既存を明示的にスキップした場合は旧い売上のまま維持される（挙動の対照確認）", async () => {
    const { executeExcelImport } = await import("@/services/excelImportService");

    store.set("monthlyResults/virgo_c1_2026-07", {
      castId: "c1",
      storeId: "virgo",
      month: "2026-07",
      totalSales: 1000000,
      payment: 400000,
      honshimeiCount: 5,
      honshimeiGroupCount: 2,
      customerCount: 8,
      jounaiCount: 1,
      douhan: 0,
      workDays: 10,
      workHours: 50,
      absent: 0,
      notes: "",
      batchId: "prev-batch",
      targetDate: null,
      createdAt: { toMillis: () => 1 },
      createdBy: "u0",
      updatedAt: { toMillis: () => 1 },
      updatedBy: "u0",
    });

    const excelRow = row({ totalSales: 1800000 });
    const result = await executeExcelImport(
      "actor-uid",
      "Actor Name",
      {
        storeId: "virgo",
        targetMonth: "2026-07",
        targetDate: null,
        fileName: "test.xlsx",
        decisions: [
          {
            row: excelRow,
            action: "link",
            castId: "c1",
            newWage: null,
            existing: "skip",
            saveRule: false,
          },
        ],
        statusDecisions: [],
      },
      () => {},
      () => false
    );

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.get("monthlyResults/virgo_c1_2026-07")?.totalSales).toBe(1000000); // 変わらない
  });
});

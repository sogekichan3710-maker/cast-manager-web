import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CastDoc, CastWithId } from "@/types";

/**
 * 入店日・退店日を「未設定へ戻せる」ことの実データ追跡テスト。
 *
 * 不具合内容:
 *   一度日付を設定すると変更はできるが、未設定（空）へ戻せない。
 *   （`<input type="date">` は端末によってはクリア操作が無いため）
 *
 * データ上の未設定表現は空文字 '' （既存設計。null / フィールド削除は使わない）。
 * 本テストは createCast / updateCast / castToInput を、インメモリの
 * Firestoreフェイクを通して実際に動かし、
 *   未設定→設定→別日付へ変更→未設定へ戻す→再読込
 * が全て正しく往復することを検証する。
 */

const { store, resetStore } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  return { store, resetStore: () => store.clear() };
});

vi.mock("@/lib/firebase", () => ({
  getDb: () => ({}) as unknown,
}));

vi.mock("firebase/firestore", () => {
  class DocRef {
    constructor(
      public collectionPath: string,
      public id: string
    ) {}
  }
  class CollectionRef {
    constructor(public path: string) {}
  }

  const SERVER_TS = { __serverTimestamp: true, isEqual: () => true };
  let autoId = 0;

  const key = (collectionPath: string, id: string) => `${collectionPath}/${id}`;

  function resolveTimestamps(data: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) out[k] = v === SERVER_TS ? SERVER_TS : v;
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
    return new DocRef(args[1] as string, args[2] as string);
  }
  function docSnapFrom(ref: DocRef) {
    const data = store.get(key(ref.collectionPath, ref.id));
    return {
      id: ref.id,
      exists: () => data !== undefined,
      data: () => (data ? { ...data } : undefined),
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
        store.set(k, { ...(store.get(k) ?? {}), ...resolveTimestamps(data) });
      },
      delete: (ref: DocRef) => store.delete(key(ref.collectionPath, ref.id)),
    };
    return fn(tx);
  }

  const Timestamp = {
    fromDate: (d: Date) => ({
      toMillis: () => d.getTime(),
      toDate: () => d,
      isEqual: (o: { toMillis: () => number }) => o?.toMillis?.() === d.getTime(),
    }),
  };

  return {
    collection,
    doc,
    getDoc: async (ref: DocRef) => docSnapFrom(ref),
    getDocs: async () => ({ docs: [] }),
    query: (c: CollectionRef) => c,
    where: () => ({}),
    orderBy: () => ({}),
    limit: () => ({}),
    serverTimestamp: () => SERVER_TS,
    setDoc: async (ref: DocRef, data: Record<string, unknown>) => {
      store.set(key(ref.collectionPath, ref.id), resolveTimestamps(data));
    },
    updateDoc: async (ref: DocRef, data: Record<string, unknown>) => {
      const k = key(ref.collectionPath, ref.id);
      store.set(k, { ...(store.get(k) ?? {}), ...resolveTimestamps(data) });
    },
    writeBatch: () => ({ set: () => {}, commit: async () => {} }),
    runTransaction,
    onSnapshot: () => () => {},
    Timestamp,
  };
});

const UID = "u1";
const NAME = "テスト管理者";
const ALLOWED = ["virgo"];

/** Firestoreに保存されているキャストを、画面が読むときと同じ形で取り出す */
function readCast(castId: string): CastWithId {
  const raw = store.get(`casts/${castId}`);
  if (!raw) throw new Error("cast not found");
  return { id: castId, ...(raw as unknown as CastDoc) };
}

describe("入店日・退店日の未設定化（実データ追跡: フォーム入力→保存→Firestore→再読込）", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("未設定→設定→別日付へ変更→未設定へ戻す、が入店日・退店日それぞれで往復できる", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput } = await import(
      "@/services/castService"
    );

    // 1. 入店日・退店日とも未設定で新規作成 → Firestoreには空文字で入る
    const castId = await createCast(
      UID,
      NAME,
      { ...emptyCastInput("virgo"), stageName: "あいり" },
      ALLOWED
    );
    expect(readCast(castId).joinDate).toBe("");
    expect(readCast(castId).leftDate).toBe("");

    // 2. 未設定 → 日付を設定できる
    let input = castToInput(readCast(castId));
    input = { ...input, joinDate: "2026-01-15", leftDate: "2026-06-30" };
    await updateCast(UID, NAME, castId, input, ALLOWED, null);
    expect(readCast(castId).joinDate).toBe("2026-01-15");
    expect(readCast(castId).leftDate).toBe("2026-06-30");

    // 3. 設定済み → 別の日付へ変更できる
    input = { ...castToInput(readCast(castId)), joinDate: "2026-02-01", leftDate: "2026-07-31" };
    await updateCast(UID, NAME, castId, input, ALLOWED, null);
    expect(readCast(castId).joinDate).toBe("2026-02-01");
    expect(readCast(castId).leftDate).toBe("2026-07-31");

    // 4. 設定済み → 未設定へ戻せる（「未設定に戻す」ボタンが行う操作と同じ）
    input = { ...castToInput(readCast(castId)), joinDate: "", leftDate: "" };
    await updateCast(UID, NAME, castId, input, ALLOWED, null);
    expect(readCast(castId).joinDate).toBe("");
    expect(readCast(castId).leftDate).toBe("");

    // 5. 再読込しても未設定のまま（フォームの初期値も空文字に戻っている）
    const reloaded = castToInput(readCast(castId));
    expect(reloaded.joinDate).toBe("");
    expect(reloaded.leftDate).toBe("");
  });

  it("入店日のみ／退店日のみのクリアができ、もう一方は保持される", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput } = await import(
      "@/services/castService"
    );
    const castId = await createCast(
      UID,
      NAME,
      {
        ...emptyCastInput("virgo"),
        stageName: "みゆ",
        joinDate: "2026-03-01",
        leftDate: "2026-09-01",
      },
      ALLOWED
    );

    // 入店日だけクリア
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), joinDate: "" },
      ALLOWED,
      null
    );
    expect(readCast(castId).joinDate).toBe("");
    expect(readCast(castId).leftDate).toBe("2026-09-01");

    // 退店日だけクリア
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), leftDate: "" },
      ALLOWED,
      null
    );
    expect(readCast(castId).joinDate).toBe("");
    expect(readCast(castId).leftDate).toBe("");
  });

  it("4通りの組み合わせ（両方設定／入店日のみ／退店日のみ／両方未設定）すべてを保存できる", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput, validateCastInput } =
      await import("@/services/castService");
    const castId = await createCast(
      UID,
      NAME,
      { ...emptyCastInput("virgo"), stageName: "さら" },
      ALLOWED
    );

    const combos: Array<[string, string]> = [
      ["2026-04-01", "2026-10-01"], // 両方設定
      ["2026-04-01", ""], // 入店日のみ
      ["", "2026-10-01"], // 退店日のみ
      ["", ""], // 両方未設定
    ];
    for (const [joinDate, leftDate] of combos) {
      const input = { ...castToInput(readCast(castId)), joinDate, leftDate };
      // どの組み合わせでもバリデーションエラーにならない
      expect(validateCastInput(input, ALLOWED)).toBeNull();
      await updateCast(UID, NAME, castId, input, ALLOWED, null);
      expect(readCast(castId).joinDate).toBe(joinDate);
      expect(readCast(castId).leftDate).toBe(leftDate);
    }
  });

  it("クリアした値は監査ログにも空文字で残り、undefined／null にはならない", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput } = await import(
      "@/services/castService"
    );
    const castId = await createCast(
      UID,
      NAME,
      {
        ...emptyCastInput("virgo"),
        stageName: "のあ",
        joinDate: "2026-05-05",
        leftDate: "2026-05-20",
      },
      ALLOWED
    );
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), joinDate: "", leftDate: "" },
      ALLOWED,
      null
    );

    const logs = Array.from(store.entries())
      .filter(([k]) => k.startsWith("auditLogs/"))
      .map(([, v]) => v)
      .filter((v) => v.action === "cast.update");
    expect(logs).toHaveLength(1);
    const after = logs[0].after as Record<string, unknown>;
    const before = logs[0].before as Record<string, unknown>;
    expect(before.joinDate).toBe("2026-05-05");
    expect(before.leftDate).toBe("2026-05-20");
    expect(after.joinDate).toBe("");
    expect(after.leftDate).toBe("");

    // Firestoreへ書いたドキュメントにフィールド自体は残る（キー欠落にしない）
    const saved = store.get(`casts/${castId}`)!;
    expect(Object.prototype.hasOwnProperty.call(saved, "joinDate")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(saved, "leftDate")).toBe(true);
    expect(saved.joinDate).toBe("");
    expect(saved.leftDate).toBe("");
  });

  it("入店日・退店日が undefined の旧データでもフォーム初期値は空文字になる", async () => {
    const { castToInput } = await import("@/services/castService");
    const legacy = {
      id: "legacy1",
      storeId: "virgo",
      stageName: "旧データ",
    } as unknown as CastWithId;
    const input = castToInput(legacy);
    expect(input.joinDate).toBe("");
    expect(input.leftDate).toBe("");
  });
});

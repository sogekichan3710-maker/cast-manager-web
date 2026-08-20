import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CastDoc, CastWithId } from "@/types";

/**
 * キャストフォームの日付項目を「未設定へ戻せる」ことの実データ追跡テスト。
 *
 * 不具合内容:
 *   一度日付を設定すると変更はできるが、未設定（空）へ戻せない。
 *   （`<input type="date">` は端末によってはクリア操作が無いため）
 *
 * 対象4項目と、それぞれのFirestore上の未設定表現（既存設計に従う）:
 * - joinDate（入店日）           … string / 未設定 = 空文字 ''
 * - leftDate（退店日）           … string / 未設定 = 空文字 ''
 * - birthday（誕生日）           … string / 未設定 = 空文字 ''
 * - rankingEligibleFrom（ランキング対象開始日）
 *                                … Timestamp | null / 未設定 = null
 *   （フォームは YYYY-MM-DD 文字列で持ち、保存時に dateStrToTimestamp が
 *     空文字を null へ変換する）
 *
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

  it("誕生日も 未設定→設定→変更→未設定 を往復でき、空文字で保存される", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput } = await import(
      "@/services/castService"
    );
    const castId = await createCast(
      UID,
      NAME,
      { ...emptyCastInput("virgo"), stageName: "ゆい" },
      ALLOWED
    );
    // 1. 未設定で作成される
    expect(readCast(castId).birthday).toBe("");

    // 2. 未設定 → 設定
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), birthday: "1998-07-24" },
      ALLOWED,
      null
    );
    expect(readCast(castId).birthday).toBe("1998-07-24");

    // 3. 設定済み → 変更
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), birthday: "1999-08-25" },
      ALLOWED,
      null
    );
    expect(readCast(castId).birthday).toBe("1999-08-25");

    // 4. 設定済み → 未設定（空文字。フィールド自体は残す）
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), birthday: "" },
      ALLOWED,
      null
    );
    const saved = store.get(`casts/${castId}`)!;
    expect(saved.birthday).toBe("");
    expect(Object.prototype.hasOwnProperty.call(saved, "birthday")).toBe(true);

    // 5. 再読込しても未設定のまま
    expect(castToInput(readCast(castId)).birthday).toBe("");
  });

  it("誕生日を未設定にすると誕生日一覧の対象から外れる（表示ロジックが壊れない）", async () => {
    const { getBirthdayCasts, parseBirthday, daysUntilBirthday, calcAge } = await import(
      "@/lib/dashboard"
    );
    const withBirthday = {
      id: "c1",
      birthday: "1998-07-24",
      archived: false,
      status: "在籍",
      stageName: "ゆい",
    } as unknown as CastWithId;
    const cleared = { ...withBirthday, id: "c2", birthday: "" } as CastWithId;

    // 設定済みのみが7月の対象になり、未設定はエラーにならず単に対象外
    expect(getBirthdayCasts([withBirthday, cleared], 7).map((c) => c.id)).toEqual(["c1"]);
    expect(parseBirthday("")).toBeNull();
    expect(daysUntilBirthday("")).toBeNull();
    expect(calcAge("")).toBeNull();
  });

  it("ランキング対象開始日は 未設定→設定→変更→未設定 を往復し、未設定は null で保存される", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput } = await import(
      "@/services/castService"
    );
    const castId = await createCast(
      UID,
      NAME,
      { ...emptyCastInput("virgo"), stageName: "りん" },
      ALLOWED
    );
    // 1. 未設定で作成される（空文字ではなく null）
    expect(readCast(castId).rankingEligibleFrom).toBeNull();

    // 2. 未設定 → 設定（Timestampとして保存される）
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), rankingEligibleFrom: "2026-01-10" },
      ALLOWED,
      null
    );
    expect(readCast(castId).rankingEligibleFrom).not.toBeNull();
    expect(castToInput(readCast(castId)).rankingEligibleFrom).toBe("2026-01-10");

    // 3. 設定済み → 別の日付へ変更
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), rankingEligibleFrom: "2026-03-20" },
      ALLOWED,
      null
    );
    expect(castToInput(readCast(castId)).rankingEligibleFrom).toBe("2026-03-20");

    // 4. 設定済み → 未設定（空文字 '' ではなく null で保存する）
    await updateCast(
      UID,
      NAME,
      castId,
      { ...castToInput(readCast(castId)), rankingEligibleFrom: "" },
      ALLOWED,
      null
    );
    const saved = store.get(`casts/${castId}`)!;
    expect(saved.rankingEligibleFrom).toBeNull();
    expect(saved.rankingEligibleFrom).not.toBe("");

    // 5. 再読込してもフォーム側は未設定（空文字）のまま
    expect(castToInput(readCast(castId)).rankingEligibleFrom).toBe("");
  });

  it("ランキング対象開始日を未設定に戻すとランキングで「常に対象」に戻る", async () => {
    const { isRankingEligible } = await import("@/lib/ranking");
    const { Timestamp } = await import("firebase/firestore");
    const periodEnd = new Date(2026, 0, 31, 23, 59, 59, 999); // 2026-01 の月末

    // 対象期間より後の開始日 → 対象外
    const future = Timestamp.fromDate(new Date(2026, 5, 1));
    expect(isRankingEligible(future, periodEnd)).toBe(false);
    // 未設定（null）へ戻すと常に対象
    expect(isRankingEligible(null, periodEnd)).toBe(true);
    expect(isRankingEligible(undefined, periodEnd)).toBe(true);
  });

  it("1つの日付項目をクリアしても他の3項目には影響しない", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput } = await import(
      "@/services/castService"
    );
    const full = {
      ...emptyCastInput("virgo"),
      stageName: "まな",
      joinDate: "2026-01-01",
      leftDate: "2026-12-31",
      birthday: "1997-05-05",
      rankingEligibleFrom: "2026-02-02",
    };
    const castId = await createCast(UID, NAME, full, ALLOWED);

    const keys = ["joinDate", "leftDate", "birthday", "rankingEligibleFrom"] as const;
    for (const target of keys) {
      // 毎回すべて設定された状態へ戻してから、1項目だけクリアする
      await updateCast(UID, NAME, castId, full, ALLOWED, null);
      const cleared = { ...castToInput(readCast(castId)), [target]: "" };
      await updateCast(UID, NAME, castId, cleared, ALLOWED, null);

      const after = castToInput(readCast(castId));
      expect(after[target]).toBe("");
      for (const other of keys) {
        if (other === target) continue;
        expect(after[other]).toBe(full[other]);
      }
    }
  });

  it("日付項目がすべて未設定でも、すべて設定済みでも保存・再読込できる", async () => {
    const { createCast, updateCast, castToInput, emptyCastInput, validateCastInput } =
      await import("@/services/castService");
    const castId = await createCast(
      UID,
      NAME,
      { ...emptyCastInput("virgo"), stageName: "ここ" },
      ALLOWED
    );

    const allSet = {
      ...castToInput(readCast(castId)),
      joinDate: "2026-01-01",
      leftDate: "2026-12-31",
      birthday: "1997-05-05",
      rankingEligibleFrom: "2026-02-02",
    };
    expect(validateCastInput(allSet, ALLOWED)).toBeNull();
    await updateCast(UID, NAME, castId, allSet, ALLOWED, null);
    expect(castToInput(readCast(castId))).toMatchObject({
      joinDate: "2026-01-01",
      leftDate: "2026-12-31",
      birthday: "1997-05-05",
      rankingEligibleFrom: "2026-02-02",
    });

    const allCleared = {
      ...castToInput(readCast(castId)),
      joinDate: "",
      leftDate: "",
      birthday: "",
      rankingEligibleFrom: "",
    };
    expect(validateCastInput(allCleared, ALLOWED)).toBeNull();
    await updateCast(UID, NAME, castId, allCleared, ALLOWED, null);
    expect(castToInput(readCast(castId))).toMatchObject({
      joinDate: "",
      leftDate: "",
      birthday: "",
      rankingEligibleFrom: "",
    });
    // Firestore上の表現は項目ごとの既存設計どおり（文字列は '' / Timestampは null）
    const saved = store.get(`casts/${castId}`)!;
    expect(saved.joinDate).toBe("");
    expect(saved.leftDate).toBe("");
    expect(saved.birthday).toBe("");
    expect(saved.rankingEligibleFrom).toBeNull();
  });

  it("誕生日・ランキング対象開始日が欠落した旧データでもフォーム初期値は空文字になる", async () => {
    const { castToInput } = await import("@/services/castService");
    const legacy = {
      id: "legacy2",
      storeId: "virgo",
      stageName: "旧データ",
      joinDate: "2020-04-01",
    } as unknown as CastWithId;
    const input = castToInput(legacy);
    expect(input.birthday).toBe("");
    expect(input.rankingEligibleFrom).toBe("");
    expect(input.joinDate).toBe("2020-04-01");
  });
});

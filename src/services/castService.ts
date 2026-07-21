import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { addAuditLogToTransaction } from "@/services/auditLogService";
import {
  ALL_STORES_FILTER,
  CAST_STATUSES,
  RANKS,
  type CastDoc,
  type CastStatus,
  type CastWithId,
  type Rank,
} from "@/types";

const CASTS = "casts";

/**
 * 他ユーザーによる更新を検知したときに投げる競合エラー。
 * UI側はこのエラーを捕捉して再読み込みを促すこと。
 */
export class ConflictError extends Error {
  constructor() {
    super(
      "他のユーザーがこのキャストを更新しました。最新の内容を確認してから、もう一度編集してください。"
    );
    this.name = "ConflictError";
  }
}

/**
 * 指定店舗のキャストを購読する。
 * - storeIds が空の場合は購読せず即座に空を返す
 * - Firestore の in 句は最大30件のため、それ以上はチャンク分割
 * - archived の絞り込みはクライアント側で行う（表示切替を即時にするため）
 */
export function subscribeCasts(
  storeIds: string[],
  onChange: (casts: CastWithId[]) => void,
  onError: (message: string) => void
): Unsubscribe {
  if (storeIds.length === 0 || storeIds.includes(ALL_STORES_FILTER)) {
    // '__all__' はクエリに使わない。呼び出し側で実際の店舗ID配列へ展開すること。
    onChange([]);
    return () => {};
  }

  const chunks: string[][] = [];
  for (let i = 0; i < storeIds.length; i += 30) {
    chunks.push(storeIds.slice(i, i + 30));
  }

  const results = new Map<number, CastWithId[]>();
  const unsubs = chunks.map((chunk, idx) =>
    onSnapshot(
      query(collection(getDb(), CASTS), where("storeId", "in", chunk)),
      (snap) => {
        results.set(
          idx,
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as CastDoc) }))
        );
        if (results.size === chunks.length) {
          const all = Array.from(results.values()).flat();
          all.sort((a, b) => a.stageName.localeCompare(b.stageName, "ja"));
          onChange(all);
        }
      },
      (err) => onError(err.message)
    )
  );

  return () => unsubs.forEach((u) => u());
}

/** 単一キャストを購読する（詳細ページ用） */
export function subscribeCast(
  castId: string,
  onChange: (cast: CastWithId | null) => void,
  onError: (message: string) => void
): Unsubscribe {
  return onSnapshot(
    doc(getDb(), CASTS, castId),
    (snap) => {
      if (!snap.exists()) {
        onChange(null);
        return;
      }
      onChange({ id: snap.id, ...(snap.data() as CastDoc) });
    },
    (err) => onError(err.message)
  );
}

/** キャストフォームの入力値（作成・編集共通） */
export interface CastInput {
  storeId: string;
  stageName: string;
  realName: string;
  kana: string;
  status: CastStatus;
  rank: Rank | "";
  hourlyWage: number;
  joinDate: string;
  leftDate: string;
  birthday: string;
  phone: string;
  line: string;
  manager: string;
  /** スカウト者（担当者とは別項目） */
  scoutedBy: string;
  /**
   * ランキング対象開始日（YYYY-MM-DD・空文字=未設定）。
   * 未設定の場合は自動判定値（初回データ登録日）が使われる。
   */
  rankingEligibleFrom: string;
  targetSales: number;
  targetHonmei: number;
  targetDouhan: number;
  guarantee: string;
  personality: string;
  memo: string;
  customerNotes: string;
}

/** 空のフォーム初期値（空文字・0で統一） */
export function emptyCastInput(storeId: string): CastInput {
  return {
    storeId,
    stageName: "",
    realName: "",
    kana: "",
    status: "在籍",
    rank: "",
    hourlyWage: 0,
    joinDate: "",
    leftDate: "",
    birthday: "",
    phone: "",
    line: "",
    manager: "",
    scoutedBy: "",
    rankingEligibleFrom: "",
    targetSales: 0,
    targetHonmei: 0,
    targetDouhan: 0,
    guarantee: "",
    personality: "",
    memo: "",
    customerNotes: "",
  };
}

/** YYYY-MM-DD 文字列 → Timestamp（ローカルタイムの0時）。空文字/不正形式は null */
function dateStrToTimestamp(s: string): Timestamp | null {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Timestamp.fromDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Timestamp → YYYY-MM-DD 文字列（フォーム表示用）。null/undefinedは空文字 */
export function timestampToDateStr(ts: Timestamp | null | undefined): string {
  if (!ts) return "";
  const d = ts.toDate();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** 既存キャストからフォーム入力値を作る */
export function castToInput(cast: CastWithId): CastInput {
  return {
    storeId: cast.storeId,
    stageName: cast.stageName ?? "",
    realName: cast.realName ?? "",
    kana: cast.kana ?? "",
    status: cast.status ?? "在籍",
    rank: cast.rank ?? "",
    hourlyWage: cast.hourlyWage ?? 0,
    joinDate: cast.joinDate ?? "",
    leftDate: cast.leftDate ?? "",
    birthday: cast.birthday ?? "",
    phone: cast.phone ?? "",
    line: cast.line ?? "",
    manager: cast.manager ?? "",
    scoutedBy: cast.scoutedBy ?? "",
    rankingEligibleFrom: timestampToDateStr(cast.rankingEligibleFrom),
    targetSales: cast.targetSales ?? 0,
    targetHonmei: cast.targetHonmei ?? 0,
    targetDouhan: cast.targetDouhan ?? 0,
    guarantee: cast.guarantee ?? "",
    personality: cast.personality ?? "",
    memo: cast.memo ?? "",
    customerNotes: cast.customerNotes ?? "",
  };
}

/** バリデーション。エラーメッセージ、問題なければ null を返す */
export function validateCastInput(
  input: CastInput,
  allowedStoreIds: string[] | "all"
): string | null {
  if (!input.stageName.trim()) return "源氏名は必須です";
  if (!input.storeId || input.storeId === ALL_STORES_FILTER) {
    return "店舗を選択してください（「全店舗」のまま保存はできません）";
  }
  if (allowedStoreIds !== "all" && !allowedStoreIds.includes(input.storeId)) {
    return "この店舗への登録権限がありません";
  }
  if (!(CAST_STATUSES as readonly string[]).includes(input.status)) {
    return "在籍状態の値が不正です";
  }
  if (input.rank !== "" && !(RANKS as readonly string[]).includes(input.rank)) {
    return "ランクの値が不正です";
  }
  if (input.rankingEligibleFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.rankingEligibleFrom)) {
    return "ランキング対象開始日の形式が不正です";
  }
  for (const [label, v] of [
    ["時給", input.hourlyWage],
    ["目標売上", input.targetSales],
    ["目標本指名", input.targetHonmei],
    ["目標同伴", input.targetDouhan],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) return `${label}は0以上の数値で入力してください`;
  }
  return null;
}

/** 入力値を保存用に正規化（trim・数値丸め） */
function normalizeInput(input: CastInput) {
  return {
    storeId: input.storeId,
    stageName: input.stageName.trim(),
    realName: input.realName.trim(),
    kana: input.kana.trim(),
    status: input.status,
    rank: input.rank,
    hourlyWage: Math.round(input.hourlyWage),
    joinDate: input.joinDate,
    leftDate: input.leftDate,
    birthday: input.birthday,
    phone: input.phone.trim(),
    line: input.line.trim(),
    manager: input.manager.trim(),
    scoutedBy: input.scoutedBy.trim(),
    rankingEligibleFrom: dateStrToTimestamp(input.rankingEligibleFrom),
    targetSales: Math.round(input.targetSales),
    targetHonmei: Math.round(input.targetHonmei),
    targetDouhan: Math.round(input.targetDouhan),
    guarantee: input.guarantee.trim(),
    personality: input.personality.trim(),
    memo: input.memo,
    customerNotes: input.customerNotes,
  };
}

/** キャストを新規作成する（owner/admin・Rulesでも制限） */
export async function createCast(
  actorUid: string,
  actorName: string,
  input: CastInput,
  allowedStoreIds: string[] | "all"
): Promise<string> {
  const err = validateCastInput(input, allowedStoreIds);
  if (err) throw new Error(err);
  const ref = doc(collection(getDb(), CASTS));
  const data = normalizeInput(input);
  await runTransaction(getDb(), async (tx) => {
    tx.set(ref, {
      ...data,
      archived: false,
      createdAt: serverTimestamp(),
      createdBy: actorUid,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    });
    addAuditLogToTransaction(tx, {
      actorUid,
      actorName,
      action: "cast.create",
      collection: CASTS,
      documentId: ref.id,
      storeId: data.storeId,
      before: null,
      after: data,
    });
  });
  return ref.id;
}

/**
 * キャストを更新する（競合検知付き）。
 * expectedUpdatedAt: 編集開始時点の updatedAt。
 * 保存直前に最新の updatedAt と比較し、異なれば ConflictError を投げる。
 * storeId の変更は現在のPRでは許可しない（Rules側も storeId 不変を強制）。
 */
export async function updateCast(
  actorUid: string,
  actorName: string,
  castId: string,
  input: CastInput,
  allowedStoreIds: string[] | "all",
  expectedUpdatedAt: Timestamp | null
): Promise<void> {
  const err = validateCastInput(input, allowedStoreIds);
  if (err) throw new Error(err);
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, CASTS, castId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("キャストが見つかりません");
    const current = snap.data() as CastDoc;
    if (
      expectedUpdatedAt &&
      current.updatedAt &&
      !current.updatedAt.isEqual(expectedUpdatedAt)
    ) {
      throw new ConflictError();
    }
    if (current.storeId !== input.storeId) {
      throw new Error("店舗の変更はこの画面からはできません");
    }
    const data = normalizeInput(input);
    tx.update(ref, {
      ...data,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    });
    addAuditLogToTransaction(tx, {
      actorUid,
      actorName,
      action: "cast.update",
      collection: CASTS,
      documentId: castId,
      storeId: data.storeId,
      before: castBusinessFields(current),
      after: data,
    });
  });
}

/** 監査ログの before 用に業務フィールドのみ抽出（メタ情報は含めない） */
function castBusinessFields(c: CastDoc): Record<string, unknown> {
  return {
    storeId: c.storeId,
    stageName: c.stageName,
    realName: c.realName,
    kana: c.kana,
    hourlyWage: c.hourlyWage,
    rank: c.rank,
    status: c.status,
    joinDate: c.joinDate,
    leftDate: c.leftDate,
    birthday: c.birthday,
    phone: c.phone,
    line: c.line,
    manager: c.manager,
    scoutedBy: c.scoutedBy,
    rankingEligibleFrom: timestampToDateStr(c.rankingEligibleFrom),
    targetSales: c.targetSales,
    targetHonmei: c.targetHonmei,
    targetDouhan: c.targetDouhan,
    guarantee: c.guarantee,
    personality: c.personality,
    memo: c.memo,
    customerNotes: c.customerNotes,
  };
}

/** アーカイブする（退店とは別概念） */
export async function archiveCast(
  actorUid: string,
  actorName: string,
  castId: string
): Promise<void> {
  await setArchived(actorUid, actorName, castId, true);
}

/** アーカイブから復元する */
export async function restoreCast(
  actorUid: string,
  actorName: string,
  castId: string
): Promise<void> {
  await setArchived(actorUid, actorName, castId, false);
}

async function setArchived(
  actorUid: string,
  actorName: string,
  castId: string,
  archived: boolean
): Promise<void> {
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, CASTS, castId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("キャストが見つかりません");
    const current = snap.data() as CastDoc;
    tx.update(ref, {
      archived,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    });
    addAuditLogToTransaction(tx, {
      actorUid,
      actorName,
      action: archived ? "cast.archive" : "cast.restore",
      collection: CASTS,
      documentId: castId,
      storeId: current.storeId,
      before: { archived: current.archived },
      after: { archived },
    });
  });
}

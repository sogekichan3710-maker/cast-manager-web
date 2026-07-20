import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { addAuditLogToBatch, addAuditLogToTransaction } from "@/services/auditLogService";
import type {
  FollowNeed,
  GoalDoc,
  GoalStatus,
  GoalWithId,
  InterviewDoc,
  InterviewWithId,
  MotiLevel,
  MotivationDoc,
  MotivationWithId,
  WageHistoryDoc,
  WageHistoryWithId,
} from "@/types";

/**
 * 面談記録サービス。
 * 既存ローカル版の saveRecord は「面談 + 目標 + モチベーション」を
 * 1つのフォームから同時保存する統合方式のため、その挙動を維持する。
 */

function byCastQuery(col: string, castId: string) {
  return query(collection(getDb(), col), where("castId", "==", castId));
}

export function subscribeInterviews(
  castId: string,
  onChange: (items: InterviewWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return onSnapshot(
    byCastQuery("interviews", castId),
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as InterviewDoc) }));
      list.sort((a, b) => (b.date || "").localeCompare(a.date || "")); // 新しい日付順
      onChange(list);
    },
    (e) => onError(e.message)
  );
}

export function subscribeGoals(
  castId: string,
  onChange: (items: GoalWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return onSnapshot(
    byCastQuery("goals", castId),
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as GoalDoc) }));
      list.sort((a, b) => (b.month || "").localeCompare(a.month || "")); // 新しい月順
      onChange(list);
    },
    (e) => onError(e.message)
  );
}

export function subscribeMotivations(
  castId: string,
  onChange: (items: MotivationWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return onSnapshot(
    byCastQuery("motivations", castId),
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as MotivationDoc) }));
      list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      onChange(list);
    },
    (e) => onError(e.message)
  );
}

export function subscribeWageHistory(
  castId: string,
  onChange: (items: WageHistoryWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return onSnapshot(
    byCastQuery("wageHistory", castId),
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as WageHistoryDoc) }));
      list.sort((a, b) => (b.effectiveMonth || "").localeCompare(a.effectiveMonth || ""));
      onChange(list);
    },
    (e) => onError(e.message)
  );
}

/** 統合記録フォームの入力（既存ローカル版 recordModal と同一項目） */
export interface RecordInput {
  castId: string;
  storeId: string;
  date: string;
  // 面談
  interviewer: string;
  followNeed: FollowNeed | "";
  nextDate: string;
  content: string;
  worries: string;
  decisions: string;
  nextTask: string;
  // 目標（monthが空でなければ保存）
  goalMonth: string; // YYYY-MM
  salesTarget: number;
  honshimeiTarget: number;
  honGroupTarget: number;
  douhanTarget: number;
  jounaiTarget: number;
  workDaysTarget: number;
  workHoursTarget: number;
  goalStatus: GoalStatus | "";
  goalMemo: string;
  goalTask: string;
  // モチベーション（levelが選択されていれば保存）
  motiLevel: MotiLevel | "";
  followDate: string;
  motiState: string;
  motiDanger: string;
  motiFollow: string;
  motiGrowth: string;
}

export function emptyRecordInput(
  castId: string,
  storeId: string,
  goalMonth: string
): RecordInput {
  return {
    castId,
    storeId,
    date: new Date().toISOString().slice(0, 10),
    interviewer: "",
    followNeed: "",
    nextDate: "",
    content: "",
    worries: "",
    decisions: "",
    nextTask: "",
    goalMonth,
    salesTarget: 0,
    honshimeiTarget: 0,
    honGroupTarget: 0,
    douhanTarget: 0,
    jounaiTarget: 0,
    workDaysTarget: 0,
    workHoursTarget: 0,
    goalStatus: "",
    goalMemo: "",
    goalTask: "",
    motiLevel: "",
    followDate: "",
    motiState: "",
    motiDanger: "",
    motiFollow: "",
    motiGrowth: "",
  };
}

/**
 * 統合記録を保存する（既存ローカル版 saveRecord の移植）。
 * - 面談: 常に interviews へ追加（type: 'face-to-face' / importance: '通常' 固定）
 * - 目標: 目標値がいずれか入力されていれば goals へ保存
 *         （同一キャスト・同一月があれば上書き — 既存ローカル版と同じ）
 * - モチベーション: レベルが選択されていれば motivations へ追加
 * すべて1つの writeBatch でアトミックに保存する。
 */
export async function saveRecord(
  actorUid: string,
  actorName: string,
  input: RecordInput
): Promise<void> {
  if (!input.castId) throw new Error("キャストを選択してください");
  if (!input.date) throw new Error("面談日を入力してください");
  if (!input.storeId) throw new Error("店舗が不正です");

  const db = getDb();
  const batch = writeBatch(db);
  const meta = {
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  };

  // ── 面談 ──
  const ivRef = doc(collection(db, "interviews"));
  const ivData = {
    castId: input.castId,
    storeId: input.storeId,
    date: input.date,
    type: "face-to-face",
    importance: "通常",
    follow: input.followNeed,
    interviewer: input.interviewer.trim(),
    nextDate: input.nextDate,
    content: input.content,
    worries: input.worries,
    decisions: input.decisions,
    nextTask: input.nextTask,
  };
  batch.set(ivRef, {
    ...ivData,
    createdAt: serverTimestamp(),
    createdBy: actorUid,
    ...meta,
  });
  addAuditLogToBatch(batch, {
    actorUid,
    actorName,
    action: "interview.create",
    collection: "interviews",
    documentId: ivRef.id,
    storeId: input.storeId,
    before: null,
    after: ivData,
  });

  // ── 目標（値がある場合のみ・同月は上書き = 既存ローカル版と同じ） ──
  const hasGoal =
    input.salesTarget > 0 ||
    input.honshimeiTarget > 0 ||
    input.douhanTarget > 0 ||
    input.workDaysTarget > 0 ||
    input.goalStatus !== "";
  if (hasGoal) {
    if (!/^\d{4}-\d{2}$/.test(input.goalMonth)) {
      throw new Error("目標の対象月を選択してください");
    }
    // 同一キャスト×同一月の既存目標を検索（storeIdも一致条件に含める）
    const existing = await getDocs(
      query(
        collection(db, "goals"),
        where("castId", "==", input.castId),
        where("month", "==", input.goalMonth)
      )
    );
    const goalData = {
      castId: input.castId,
      storeId: input.storeId,
      month: input.goalMonth,
      salesTarget: Math.round(input.salesTarget),
      honshimeiTarget: input.honshimeiTarget,
      honGroupTarget: input.honGroupTarget,
      douhanTarget: input.douhanTarget,
      jounaiTarget: input.jounaiTarget,
      workDaysTarget: input.workDaysTarget,
      workHoursTarget: input.workHoursTarget,
      status: input.goalStatus,
      memo: input.goalMemo,
      task: input.goalTask,
      ...meta,
    };
    if (!existing.empty) {
      const before = existing.docs[0].data();
      batch.update(existing.docs[0].ref, goalData);
      addAuditLogToBatch(batch, {
        actorUid,
        actorName,
        action: "goal.upsert",
        collection: "goals",
        documentId: existing.docs[0].id,
        storeId: input.storeId,
        before,
        after: goalData,
      });
    } else {
      const goalRef = doc(collection(db, "goals"));
      batch.set(goalRef, {
        ...goalData,
        createdAt: serverTimestamp(),
        createdBy: actorUid,
      });
      addAuditLogToBatch(batch, {
        actorUid,
        actorName,
        action: "goal.upsert",
        collection: "goals",
        documentId: goalRef.id,
        storeId: input.storeId,
        before: null,
        after: goalData,
      });
    }
  }

  // ── モチベーション（レベル選択時のみ） ──
  if (input.motiLevel !== "") {
    const motiRef = doc(collection(db, "motivations"));
    const motiData = {
      castId: input.castId,
      storeId: input.storeId,
      date: input.date,
      level: input.motiLevel,
      followNeed: input.followNeed,
      followDate: input.followDate,
      state: input.motiState,
      danger: input.motiDanger,
      follow: input.motiFollow,
      growth: input.motiGrowth,
    };
    batch.set(motiRef, {
      ...motiData,
      createdAt: serverTimestamp(),
      createdBy: actorUid,
      ...meta,
    });
    addAuditLogToBatch(batch, {
      actorUid,
      actorName,
      action: "motivation.create",
      collection: "motivations",
      documentId: motiRef.id,
      storeId: input.storeId,
      before: null,
      after: motiData,
    });
  }

  await batch.commit();
}

export class InterviewConflictError extends Error {
  constructor() {
    super(
      "他のユーザーがこの面談記録を更新しました。最新の内容を確認してから、もう一度編集してください。"
    );
    this.name = "InterviewConflictError";
  }
}

/** 面談記録の編集用入力（面談フィールドのみ。目標・モチベーションは別レコードのため
 *  この編集では触らず、重複作成を防ぐ） */
export interface InterviewEditInput {
  date: string;
  interviewer: string;
  follow: FollowNeed | "";
  nextDate: string;
  content: string;
  worries: string;
  decisions: string;
  nextTask: string;
}

/**
 * 面談記録を更新する（競合検知付き）。
 * expectedUpdatedAt: 編集開始時点の updatedAt。他ユーザーの更新を検知したら
 * InterviewConflictError を投げ、無警告上書きしない。
 * castId / storeId / createdBy / createdAt は変更しない（Rulesでも不変を強制）。
 */
export async function updateInterview(
  actorUid: string,
  actorName: string,
  interviewId: string,
  input: InterviewEditInput,
  expectedUpdatedAt: Timestamp | null
): Promise<void> {
  if (!input.date) throw new Error("面談日を入力してください");
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "interviews", interviewId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("面談記録が見つかりません");
    const current = snap.data() as InterviewDoc;
    if (
      expectedUpdatedAt &&
      current.updatedAt &&
      !current.updatedAt.isEqual(expectedUpdatedAt)
    ) {
      throw new InterviewConflictError();
    }
    const data = {
      date: input.date,
      interviewer: input.interviewer.trim(),
      follow: input.follow,
      nextDate: input.nextDate,
      content: input.content,
      worries: input.worries,
      decisions: input.decisions,
      nextTask: input.nextTask,
    };
    tx.update(ref, { ...data, updatedAt: serverTimestamp(), updatedBy: actorUid });
    addAuditLogToTransaction(tx, {
      actorUid,
      actorName,
      action: "interview.update",
      collection: "interviews",
      documentId: interviewId,
      storeId: current.storeId,
      before: {
        date: current.date,
        interviewer: current.interviewer,
        follow: current.follow,
        nextDate: current.nextDate,
        content: current.content,
        worries: current.worries,
        decisions: current.decisions,
        nextTask: current.nextTask,
      },
      after: data,
    });
  });
}

/** 時給変更を記録し、キャストの時給も更新する（追記のみのwageHistoryへ） */
export async function recordWageChange(
  actorUid: string,
  actorName: string,
  params: {
    castId: string;
    storeId: string;
    oldHourlyWage: number;
    newHourlyWage: number;
    effectiveMonth: string;
    reason: string;
  }
): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);
  const whRef = doc(collection(db, "wageHistory"));
  const whData = {
    castId: params.castId,
    storeId: params.storeId,
    oldHourlyWage: Math.round(params.oldHourlyWage),
    newHourlyWage: Math.round(params.newHourlyWage),
    effectiveMonth: params.effectiveMonth,
    reason: params.reason.trim(),
  };
  batch.set(whRef, { ...whData, createdAt: serverTimestamp(), createdBy: actorUid });
  batch.update(doc(db, "casts", params.castId), {
    hourlyWage: Math.round(params.newHourlyWage),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  });
  addAuditLogToBatch(batch, {
    actorUid,
    actorName,
    action: "wageHistory.add",
    collection: "wageHistory",
    documentId: whRef.id,
    storeId: params.storeId,
    before: null,
    after: whData,
  });
  await batch.commit();
}

/** 店舗横断購読（ダッシュボード用）。in句30件チャンク対応。 */
function subscribeByStores<T extends { storeId: string }>(
  col: string,
  storeIds: string[],
  map: (id: string, data: unknown) => T,
  onChange: (items: T[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  if (storeIds.length === 0) {
    onChange([]);
    return () => {};
  }
  const chunks: string[][] = [];
  for (let i = 0; i < storeIds.length; i += 30) chunks.push(storeIds.slice(i, i + 30));
  const results = new Map<number, T[]>();
  const unsubs = chunks.map((chunk, idx) =>
    onSnapshot(
      query(collection(getDb(), col), where("storeId", "in", chunk)),
      (snap) => {
        results.set(idx, snap.docs.map((d) => map(d.id, d.data())));
        if (results.size === chunks.length) {
          onChange(Array.from(results.values()).flat());
        }
      },
      (e) => onError(e.message)
    )
  );
  return () => unsubs.forEach((u) => u());
}

export function subscribeInterviewsByStores(
  storeIds: string[],
  onChange: (items: InterviewWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return subscribeByStores<InterviewWithId>(
    "interviews",
    storeIds,
    (id, data) => ({ id, ...(data as InterviewDoc) }),
    onChange,
    onError
  );
}

export function subscribeGoalsByStores(
  storeIds: string[],
  onChange: (items: GoalWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return subscribeByStores<GoalWithId>(
    "goals",
    storeIds,
    (id, data) => ({ id, ...(data as GoalDoc) }),
    onChange,
    onError
  );
}

export function subscribeMotivationsByStores(
  storeIds: string[],
  onChange: (items: MotivationWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return subscribeByStores<MotivationWithId>(
    "motivations",
    storeIds,
    (id, data) => ({ id, ...(data as MotivationDoc) }),
    onChange,
    onError
  );
}

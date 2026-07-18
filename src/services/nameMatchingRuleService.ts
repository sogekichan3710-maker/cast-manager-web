import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import {
  nameMatchingRuleId,
  type NameMatchingRuleDoc,
  type NameMatchingRuleWithId,
  type RuleDecision,
} from "@/types";

const COL = "nameMatchingRules";

/** 対象店舗の照合ルールを取得する（インポート開始時に1回読む） */
export async function fetchRulesByStore(storeId: string): Promise<NameMatchingRuleWithId[]> {
  const snap = await getDocs(
    query(collection(getDb(), COL), where("storeId", "==", storeId))
  );
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as NameMatchingRuleDoc) }));
}

export interface RuleUpsertInput {
  storeId: string;
  sourceName: string;
  normalizedName: string;
  decision: RuleDecision;
  linkedCastId: string | null;
  hourlyWage: number | null;
}

/**
 * 照合ルールを保存する。ドキュメントID = storeId__正規化名 のため、
 * 同じ名前の確定は常に同じルールを更新する（重複ルールは作られない）。
 * createdBy / createdAt は初回作成時のまま保持する（Rulesでも改竄禁止）。
 */
export async function upsertNameMatchingRule(
  actorUid: string,
  input: RuleUpsertInput
): Promise<void> {
  const db = getDb();
  const id = nameMatchingRuleId(input.storeId, input.normalizedName);
  await runTransaction(db, async (tx) => {
    const ref = doc(db, COL, id);
    const snap = await tx.get(ref);
    const data = {
      storeId: input.storeId,
      sourceName: input.sourceName,
      normalizedName: input.normalizedName,
      decision: input.decision,
      linkedCastId: input.linkedCastId,
      hourlyWage: input.hourlyWage,
      active: true,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    };
    if (snap.exists()) {
      tx.update(ref, data);
    } else {
      tx.set(ref, { ...data, createdAt: serverTimestamp(), createdBy: actorUid });
    }
  });
}
